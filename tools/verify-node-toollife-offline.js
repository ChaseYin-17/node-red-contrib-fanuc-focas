'use strict';
/**
 * tools/verify-node-toollife-offline.js — tool-life regression tests with no controller.
 *
 * `tools/verify-node-toollife.js` needs a CNC with the tool-life option; this one needs
 * nothing, so it runs in CI and on a bench. It stubs the socket and the four readers and
 * drives the *real* node code (fanuc-focas.js -> focas.js), pinning the things that were
 * got wrong on the way in:
 *
 *   - the wire offsets. The wire is not the SDK struct (fields are 4-byte longs, and
 *     cnc_rdgrpinfo4's `grp_no` is a long where the C struct has a short), so one wrong
 *     offset shows up as a whole column of zeros rather than an error.
 *   - the cnc_rdgrpinfo4 paging loop: it must terminate against a controller that ignores
 *     `grp_no`, must not ask for a group past `max_group` (EW_NUMBER), and must stop on the
 *     reported group count.
 *   - the optional sub-reads: a failure must be visible in `tool_life.errors`, not
 *     swallowed into a zero/null.
 *   - All Data carries both `axes_data` and `tool_life`.
 *   - the three failure shapes reqErr() has to tell apart.
 *
 * Usage: node tools/verify-node-toollife-offline.js
 */
const path = require('path');

const { Focas, TOOL_GROUP_PAGE } = require(path.join(__dirname, '..', 'focas'));

// ── Harness ───────────────────────────────────────────────────────────────────
let checks = 0, failures = 0;
const h = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);
function check(cond, msg) {
    checks++;
    if (!cond) failures++;
    console.log(`  ${cond ? '✔' : '✗'} ${msg}`);
}

// The real readers, kept so a section that stubs one can restore it.
const real = {
    readtlinfo:   Focas.prototype.readtlinfo,
    readngrp:     Focas.prototype.readngrp,
    readusegrpid: Focas.prototype.readusegrpid,
    readgrpinfo4: Focas.prototype.readgrpinfo4,
};

// ── Node-RED stub ─────────────────────────────────────────────────────────────
let FanucNode = null, pollNode = null;

const RED = {
    nodes: {
        createNode(node) {
            node.on     = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
            node.status = () => {};
            node.error  = () => {};
            return node;
        },
        registerType(type, ctor) { if (type === 'fanuc-focas') FanucNode = ctor; },
        getNode: () => ({ host: 'stub', port: 1, cnc_series: '16' }),
    },
};

function makeNode(fn) {
    pollNode = new FanucNode({ server: 'cfg', fn, subtype: '', params: '' });
}

function poll(msg) {
    const handler = pollNode._handlers.input;
    const run = new Promise((resolve, reject) => {
        let out = null, settled = false;
        handler(msg, (m) => { out = m; },
                      (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(out); });
    });
    const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('the poll never finished — the page loop hung')), 5000));
    return Promise.race([run, timeout]);
}

// Stubs shared by every section that drives the node rather than a single decoder.
Focas.prototype.connect    = async function () {
    this.sysinfo = { cnctype: '31 ', mttype: 'M ', series: 'G11Z', version: '13.0', maxaxis: 32 };
};
Focas.prototype.disconnect = async () => {};
function stubPeripherals() {
    Focas.prototype.statinfo            = async () => ({ aut: 1, run: 3, motion: 1, mstb: 0, emegency: 0, alarm: 0, edit: 0 });
    Focas.prototype.readparam3          = async (axis, first) => ({ [first]: { data: [7] } });
    Focas.prototype.readprognum         = async () => ({ run: 100, main: 100 });
    Focas.prototype.listprog            = async () => ({ 100: { comment: 'TEST' } });
    Focas.prototype.readalarmcode       = async () => [];
    Focas.prototype.readactfeed         = async () => 0;
    Focas.prototype.readactspindlespeed = async () => 0;
    Focas.prototype.readaxes            = async () => ({ ABS: [0, 0, 0] });
    Focas.prototype.readsvmeter         = async () => [1, 2, 3];
    Focas.prototype.readservocurrent    = async () => [0.1, 0.2, 0.3];
    Focas.prototype.readspmeter         = async () => [4];
    Focas.prototype.readaxiscount       = async () => 3;
    Focas.prototype.readaxisnames       = async () => ['X', 'Y', 'Z'];
    Focas.prototype.readspindlenames    = async () => ['S'];
}

// ── Section 1: wire offsets ───────────────────────────────────────────────────
async function offsets() {
    h('1 — wire offsets (the decode that differs from the SDK struct)');
    let seen = null;
    Focas.prototype._reqSingle = async (c1, c2, c3, v1 = 0, v2 = 0, v3 = 0) => {
        seen = { c1, c2, c3, v1, v2, v3 };
        if (c3 === 0x1c4) {                                   // leading long, then four limits
            const d = Buffer.alloc(20);
            [30, 128, 8, 60000, 99999999].forEach((v, i) => d.writeInt32BE(v, i * 4));
            return { len: d.length, data: d };
        }
        if (c3 === 0x4a) {                                    // same block; count is at +0
            const d = Buffer.alloc(20);
            [30, 128, 8, 60000, 99999999].forEach((v, i) => d.writeInt32BE(v, i * 4));
            return { len: d.length, data: d };
        }
        if (c3 === 0x48) {                                    // three longs only
            const d = Buffer.alloc(12);
            d.writeInt32BE(0, 0); d.writeInt32BE(2, 4); d.writeInt32BE(2, 8);
            return { len: 12, data: d };
        }
        if (c3 === 0x1c1) {                                   // 7 longs a record
            const d = Buffer.alloc(2 * 28);
            [[1, 1, 5000, 3281, 1, 0, 0], [2, 1, 5000, 0, 1, 0, 7]]
                .forEach((rec, r) => rec.forEach((v, i) => d.writeInt32BE(v, r * 28 + i * 4)));
            return { len: d.length, data: d };
        }
        return { len: -1 };
    };

    const f = new Focas('stub', 1);

    const info = await f.readtlinfo();
    check(seen.c3 === 0x1c4, 'cnc_rdtlinfo uses 0x1c4');
    check(info.max_group === 128 && info.max_tool === 8 && info.max_minute === 60000 && info.max_cycle === 99999999,
          `limits read from +4 (${JSON.stringify(info)})`);

    const ngrp = await f.readngrp();
    check(seen.c3 === 0x4a && ngrp === 30, `cnc_rdngrp reads the count at +0 (${ngrp}, not the max_group at +4)`);

    const use = await f.readusegrpid();
    check(seen.c3 === 0x48 && use.next === 0 && use.use === 2 && use.slct === 2,
          `cnc_rdusegrpid reads three longs at +0/+4/+8 (${JSON.stringify(use)})`);

    const groups = await f.readgrpinfo4(1);
    check(seen.c3 === 0x1c1 && seen.v1 === 1 && seen.v2 === 0 && seen.v3 === TOOL_GROUP_PAGE,
          `cnc_rdgrpinfo4 sends grp_no=${seen.v1} direction=${seen.v2} num_to_read=${seen.v3}`);
    check(groups.length === 2 && groups[0].grp_no === 1 && groups[1].grp_no === 2,
          `grp_no is a 4-byte long (${groups.map(g => g.grp_no).join(', ')})`);
    check(groups[0].count_value === 5000 && groups[0].counter === 3281 && groups[1].life_rest === 7,
          'life / counter / life_rest land on their fields');
}

// ── Section 2: the record model ───────────────────────────────────────────────
function modelStubs(groups) {
    Focas.prototype.readtlinfo   = async () => ({ max_group: 128, max_tool: 8, max_minute: 60000, max_cycle: 99999999 });
    Focas.prototype.readngrp     = async () => groups.length;
    Focas.prototype.readusegrpid = async () => ({ next: 0, use: 2, slct: 2 });
    Focas.prototype.readgrpinfo4 = async () => groups;
}

const g = (n, life, counter, type = 1) =>
    ({ grp_no: n, n_tool: 1, count_value: life, counter, count_type: type, opt_grpno: 0, life_rest: 0 });

async function model() {
    h('2 — per-group model');
    makeNode('tool_life');
    modelStubs([g(1, 500, 412, 0), g(2, 500, 0), g(3, 0, 0), g(4, 8000, 6685)]);
    const tl = (await poll({})).payload;

    check(tl.using_group === 2 && tl.groups.filter(x => x.in_use).length === 1,
          `using_group = ${tl.using_group}, exactly one group flagged in_use`);
    check(tl.groups.length === 4 && tl.group_count === 4, `groups = ${tl.groups.length}`);
    check(tl.groups[0].unit === 'count' && tl.groups[1].unit === 'minute', 'count_type 0/1 -> count/minute');
    check(tl.groups[0].remaining === 88 && Math.abs(tl.groups[0].usage_percent - 82.4) < 1e-9,
          `group 1 remaining/usage = ${tl.groups[0].remaining} / ${tl.groups[0].usage_percent}`);
    check(tl.groups[2].remaining === null && tl.groups[2].usage_percent === null,
          'life unset -> remaining and usage null, never 0');
    check(tl.most_used_group === 4,
          `most_used_group = ${tl.most_used_group} (highest usage, not the 0% group 2)`);
    check(Object.keys(tl.errors).length === 0, 'errors empty when every read succeeds');

    h('2b — remaining falls back to life - counter, and prefers life_rest when set');
    modelStubs([
        { ...g(5, 500, 412), life_rest: 0 },      // -> 88
        { ...g(6, 500, 412), life_rest: 20 },     // CNC rest counter wins
        { ...g(7, 500, 600), life_rest: 0 },      // counter past life -> clamped to 0
    ]);
    const tl2 = (await poll({})).payload;
    check(tl2.groups[0].remaining === 88, `life - counter = ${tl2.groups[0].remaining}`);
    check(tl2.groups[1].remaining === 20 && tl2.groups[1].life_rest_raw === 20, 'life_rest preferred when > 0');
    check(tl2.groups[2].remaining === 0, 'never negative');

    h('2c — no group ever used -> most_used_group null');
    modelStubs([g(8, 500, 0), g(9, 0, 0)]);
    const tl3 = (await poll({})).payload;
    check(tl3.most_used_group === null, `most_used_group = ${tl3.most_used_group}`);
}

// ── Section 3: paging guards ──────────────────────────────────────────────────
async function paging() {
    h('3 — cnc_rdgrpinfo4 paging');
    makeNode('tool_life');
    const seq = (upTo) => (from) => {
        const out = [];
        for (let n = from; n < from + TOOL_GROUP_PAGE && n <= upTo; n++) out.push(g(n, 100, n));
        return out;
    };
    let calls = [];
    let pageFn = null;
    Focas.prototype.readgrpinfo4 = async (from) => { calls.push(from); return pageFn(from); };

    Focas.prototype.readtlinfo = async () => ({ max_group: 256, max_tool: 8, max_minute: 1, max_cycle: 1 });
    Focas.prototype.readngrp   = async () => 130;
    calls = []; pageFn = seq(130);
    let tl = (await poll({})).payload;
    check(calls.join(',') === '1,65,129', `130 groups read as pages ${calls.join(' / ')}`);
    check(tl.groups.length === 130, `groups = ${tl.groups.length}`);

    // A controller that ignores grp_no must not spin forever.
    calls = []; pageFn = () => Array.from({ length: TOOL_GROUP_PAGE }, (_, i) => g(i + 1, 100, i));
    Focas.prototype.readngrp = async () => 0;
    tl = (await poll({})).payload;
    check(calls.length === 2, `a page that does not advance grp_no stops it (${calls.length} call(s))`);

    // Exactly one full page that is the whole range: stop on the count, not on a 2nd call.
    calls = []; pageFn = seq(64);
    Focas.prototype.readtlinfo = async () => ({ max_group: 64, max_tool: 8, max_minute: 1, max_cycle: 1 });
    Focas.prototype.readngrp   = async () => 64;
    tl = (await poll({})).payload;
    check(calls.length === 1 && tl.groups.length === 64, `full page == whole range stops after ${calls.length} call(s)`);

    // Same, but the count is unavailable: max_group has to stop it before EW_NUMBER.
    calls = []; pageFn = seq(64);
    Focas.prototype.readngrp = async () => { throw new Error('cnc_rdngrp: CNC returned EW_NOOPT (6)'); };
    tl = (await poll({})).payload;
    check(calls.length === 1 && calls.every(n => n <= 64), `max_group caps it (asked for ${calls.join(',')})`);
    check(tl.group_count === 0 && /EW_NOOPT/.test(tl.errors.readngrp || ''),
          `failed count surfaced, not swallowed: ${JSON.stringify(tl.errors)}`);

    h('3b — a failing limit read is reported, not zeroed silently');
    calls = []; pageFn = seq(30);
    Focas.prototype.readtlinfo = async () => { throw new Error('cnc_rdtlinfo: CNC returned EW_NOOPT (6)'); };
    Focas.prototype.readngrp   = async () => 30;
    tl = (await poll({})).payload;
    check(tl.max_group === 0 && /EW_NOOPT/.test(tl.errors.readtlinfo || ''),
          `tool_life.errors.readtlinfo = ${JSON.stringify(tl.errors.readtlinfo)}`);
    check(tl.groups.length === 30 && tl.using_group === 2, 'the groups still come back');
}

// ── Section 4: All Data ───────────────────────────────────────────────────────
async function allData() {
    h('4 — All Data carries axes_data and tool_life');
    stubPeripherals();
    modelStubs([g(1, 500, 412), g(2, 500, 0)]);
    makeNode('all');
    const p = (await poll({})).payload;

    check(p.axes_data && Array.isArray(p.axes_data.servo_load_percent),
          `axes_data present (servo_load_percent = ${JSON.stringify(p.axes_data && p.axes_data.servo_load_percent)})`);
    check(p.axes_data && p.axes_data.spindle_load_names && p.axes_data.spindle_load_names[0] === 'S',
          'axes_data carries the spindle names');
    check(p.tool_life && p.tool_life.group_count === 2 && p.tool_life.using_group === 2,
          `tool_life present (group_count = ${p.tool_life && p.tool_life.group_count})`);
    const keys = Object.keys(p.axes_data || {});
    check(keys.indexOf('servo_load_current_amps') > keys.indexOf('servo_load_percent') &&
          keys.indexOf('servo_load_current_amps') < keys.indexOf('spindle_load_percent'),
          `servo readings sit together: ${keys.join(', ')}`);
    check(p.feedrate_spindle && 'actual_feedrate_mm_min' in p.feedrate_spindle, 'feedrate_spindle kept');
    check(p.errors && Object.keys(p.errors).length === 0, 'no fields degraded');
}

// ── Section 5: failure shapes ─────────────────────────────────────────────────
async function failureShapes() {
    h('5 — reqErr names the three failure shapes');
    Object.assign(Focas.prototype, real);                  // back to the real readers
    const f = new Focas('stub', 1);

    Focas.prototype._reqSingle = async () => ({ len: -1, ftype: 0x2103, raw: Buffer.from([0, 0, 0xff, 0xef, 0, 1, 0, 0]) });
    let m = await f.readgrpinfo4(1).then(() => '(no throw)', e => e.message);
    check(/unexpected reply frame 0x2103/.test(m) && /head=/.test(m), `over-range reply: ${m}`);

    Focas.prototype._reqSingle = async () => ({ len: -1 });
    m = await f.readgrpinfo4(1).then(() => '(no throw)', e => e.message);
    check(/malformed or empty response frame/.test(m), `plain non-answer: ${m}`);

    Focas.prototype._reqSingle = async () => ({ len: 0, error: 6, data: Buffer.alloc(8) });
    m = await f.readgrpinfo4(1).then(() => '(no throw)', e => e.message);
    check(/CNC returned EW_NOOPT \(6\)/.test(m), `CNC status: ${m}`);

    Focas.prototype._reqSingle = async () => ({ len: 0, error: 6, data: Buffer.alloc(8) });
    m = await f.readtlinfo().then(() => '(no throw)', e => e.message);
    check(/cnc_rdtlinfo: CNC returned EW_NOOPT \(6\)/.test(m), `tool-life read: ${m}`);
}

(async () => {
    require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);

    await offsets();
    await model();
    await paging();
    await allData();
    await failureShapes();

    Object.assign(Focas.prototype, real);                  // leave nothing stubbed
    h(failures === 0 ? `PASS — ${checks}/${checks} checks`
                     : `FAIL — ${failures} of ${checks} checks failed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
