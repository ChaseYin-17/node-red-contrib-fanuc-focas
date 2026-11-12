'use strict';
/**
 * tools/verify-decoders-offline.js — offline regression test for the wire decoders.
 *
 * Every fixture below is a byte string captured from a real controller on 2026-11-12
 * (the 31i at 10.192.233.166:8193, cnc_type 31, series G40A, max_axis 32, 5 servo axes
 * X Y Z B X2, 1 spindle S1). The captures are in docs/notes.md; the tools that produced
 * them are tools/probe-readonly-audit{,2,3}.js, tools/probe-param-types.js,
 * tools/probe-position-compare.js and tools/probe-dll-param.py.
 *
 * No controller is needed: `_reqSingle` is stubbed to answer from the fixtures, so the
 * real decoders in focas.js run against real bytes.
 *
 * Usage: node tools/verify-decoders-offline.js
 */
const path = require('path');
const { Focas } = require(path.join(__dirname, '..', 'focas.js'));

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? '  ✔' : '  ✗'} ${label}${detail !== undefined ? `   ${detail}` : ''}`);
    if (!ok) failures++;
};
const h = s => console.log(`\n${'─'.repeat(76)}\n${s}\n${'─'.repeat(76)}`);

const buf = hex => Buffer.from(hex.replace(/\s+/g, ''), 'hex');

// ── A stub controller: answers _reqSingle from a queue of fixtures ────────────
// Each entry is { len, data } or { len, error } or { len: -1 } — the three shapes
// _reqSingle returns.
let script = [];
let sent = [];
Focas.prototype._reqSingle = async function (c1, c2, c3, ...args) {
    sent.push({ c1, c2, c3, args });
    if (!script.length) throw new Error(`unexpected request func=0x${c3.toString(16)}`);
    const next = script.shift();
    return typeof next === 'function' ? next() : next;
};
Focas.prototype.connect = async function () {
    this.sysinfo = { addinfo: 514, maxaxis: 32, cnctype: '31', mttype: ' M',
                     series: 'G40A', version: '37.0', axes: '05' };
};
Focas.prototype.disconnect = async function () {};

const reply = (hex, len) => ({ len: len !== undefined ? len : hex.replace(/\s+/g, '').length / 2,
                               data: buf(hex) });

// A Focas instance with the captured sysinfo already in place, so the decoders that
// size their blocks from maxaxis work without a connect().
const mk = () => {
    const f = new Focas('x');
    f.sysinfo = { addinfo: 514, maxaxis: 32, cnctype: '31', mttype: ' M',
                  series: 'G40A', version: '37.0', axes: '05' };
    return f;
};

(async () => {
    // ── 1. cnc_rdparam3: 8-byte records, attribute at +6 ─────────────────────
    h('1 — cnc_rdparam3 decodes the measured wire, not the C struct');
    // 6711, 2-word with axis (attr 3), 32 axes of 8 bytes. Value 23101 at +0.
    const p6711 = '00 00 1a 37 00 00 00 03' + '00 00 5a 3d 00 0a 00 00' +
                  '30 35 78 8c 00 0a 20 4d' + '00 01 00 00 00 0a 00 05';
    script = [reply(p6711)];
    let r = await mk().readparam3(-1, 6711);
    check('6711 (attr 3, 2-word) reads 23101', r && r[6711] && r[6711].data[0] === 23101,
          r && r[6711] ? `data[0]=${r[6711].data[0]}` : 'null');
    check('the attribute is taken from +6, not from `type` at +4',
          r && r[6711] && r[6711].type === 3, r && r[6711] ? `type=${r[6711].type}` : 'null');

    // 1020, bit parameter with axis (attr 1): the byte at +3 of each record.
    const p1020 = '00 00 03 fc ff ff 00 01' + '00 00 00 58 00 0a 00 00' +
                  '00 00 00 59 00 0a 00 00' + '00 00 00 5a 00 0a 00 00' +
                  '00 00 00 42 00 0a 00 00' + '00 00 00 58 00 0a 00 00';
    script = [reply(p1020)];
    r = await mk().readparam3(-1, 1020);
    check('1020 (attr 1, bit) reads the axis-name bytes 88,89,90,66,88',
          r && JSON.stringify(r[1020].data.slice(0, 5)) === '[88,89,90,66,88]',
          r ? JSON.stringify(r[1020].data.slice(0, 5)) : 'null');

    // 5001, real parameter (attr 4): value(i32) then dec(i32).
    const p5001 = '00 00 13 89 00 00 00 04' + '00 00 00 40 00 00 00 02' +
                  '00 00 17 70 00 00 00 00';
    script = [reply(p5001)];
    r = await mk().readparam3(-1, 5001);
    check('5001 (attr 4, real) applies dec: 64 / 10^2 = 0.64',
          r && r[5001] && r[5001].data[0] === 0.64,
          r && r[5001] ? `data[0]=${r[5001].data[0]}` : 'null');

    // 1825, word with axis (attr 2): 6000 on every axis.
    const p1825 = '00 00 07 21 ff ff 00 02' + '00 00 17 70 00 0a 00 00' +
                  '00 00 17 70 00 0a 00 00';
    script = [reply(p1825)];
    r = await mk().readparam3(-1, 1825);
    check('1825 (attr 2, word with axis) reads 6000',
          r && r[1825] && r[1825].data[0] === 6000,
          r && r[1825] ? `data[0]=${r[1825].data[0]}` : 'null');

    // ── 2. cnc_rdmacro: mcr_val(i32) + dec_val(i16) ──────────────────────────
    h('2 — cnc_rdmacro decodes mcr_val/dec_val, not the feedrate shape');
    // (100, 100) → 8 bytes: mcr_val 120000000, dec_val 5 → 1200.0
    script = [reply('07 27 0e 00 00 0a 00 05')];
    r = await mk().readmacro(100);
    check('macro 100 = 120000000 / 10^5 = 1200', r && r[100] === 1200, r ? `r[100]=${r[100]}` : 'null');
    check('the request sends (number, number) — an end number, not a count',
          sent[sent.length - 1].args[0] === 100 && sent[sent.length - 1].args[1] === 100,
          JSON.stringify(sent[sent.length - 1].args));

    // (500, 500) → mcr_val 189200000, dec_val 8 → 1.892
    script = [reply('0b 46 f6 80 00 0a 00 08')];
    r = await mk().readmacro(500);
    check('macro 500 = 189200000 / 10^8 = 1.892', r && r[500] === 1.892, r ? `r[500]=${r[500]}` : 'null');

    // A vacant variable: mcr_val 0, dec_val -1 → null, not 0.
    script = [reply('00 00 00 00 00 0a ff ff')];
    r = await mk().readmacro(1);
    check('a vacant variable (dec_val = -1) is null, not 0', r && r[1] === null,
          r ? `r[1]=${JSON.stringify(r[1])}` : 'null');

    // ── 3. cnc_rdprogdir: 72-byte records, and the loop terminates ───────────
    h('3 — cnc_rdprogdir decodes 72-byte records and cannot spin');
    const rec = (num, len, cmt) => {
        const b = Buffer.alloc(72);
        b.writeUInt32BE(num, 0);
        b.writeUInt32BE(len, 4);
        b.write(cmt, 8, 'latin1');
        return b;
    };
    const page1 = Buffer.concat([rec(903, 28000, '(19237-0903_REVC_150670003)'),
                                 rec(8000, 500, '(RENISHAW VECTOR CAL)'),
                                 rec(8001, 1500, '()')]);
    sent = [];
    script = [reply(page1.toString('hex'))];
    r = await mk().listprog(1);
    check('three programs decoded', r && Object.keys(r).length === 3,
          r ? JSON.stringify(Object.keys(r)) : 'null');
    check('the comment is read from +8', r && r[903] && r[903].comment === '(19237-0903_REVC_150670003)',
          r && r[903] ? JSON.stringify(r[903].comment) : 'null');
    check('a short page ends the loop', sent.length === 1, `requests=${sent.length}`);

    // A malformed frame must end the loop, not re-request forever. This is the bug:
    // the old test was `st.len < -1`, which is never true for len = -1.
    sent = [];
    script = [{ len: -1 }];
    r = await mk().listprog(1);
    check('a malformed frame ends the loop after one request', sent.length === 1,
          `requests=${sent.length}`);
    check('...and reports null rather than an empty directory', r === null, String(r));

    // A page that does not advance `start` must also end it. The first page moves
    // start from 1 to 2 (program 1 is the last one on it); the second page repeats
    // program 1, which cannot advance start again, so the loop must stop there.
    sent = [];
    const stuck = Buffer.concat(Array.from({ length: 19 }, () => rec(1, 10, '()')));
    script = [reply(stuck.toString('hex')), reply(stuck.toString('hex'))];
    r = await mk().listprog(1);
    check('a page that does not advance the cursor stops the loop (bounded, not spinning)',
          sent.length === 2, `requests=${sent.length}`);

    // ── 4. cnc_rdalmmsg: 32-char cap and stride validation ───────────────────
    h('4 — cnc_rdalmmsg uses the documented 32-char record and validates the stride');
    const alm = Buffer.alloc(48);
    alm.writeInt32BE(100, 0);      // alm_no
    alm.writeInt32BE(0, 4);        // type
    alm.writeInt32BE(0, 8);        // axis
    alm.writeInt32BE(27, 12);      // msg_len
    alm.write('PARAMETER ENABLE SWITCH ON', 16, 'latin1');
    script = [reply(alm.toString('hex'))];
    r = await mk().readalarmcode(-1, 1, 10, 32);
    check('one 48-byte record decodes', r && r.length === 1, r ? `len=${r.length}` : 'null');
    check('alm_no / type / axis / text', r && r[0].alarmcode === 100 && r[0].alarmtype === 0 &&
          r[0].axis === 0 && r[0].text === 'PARAMETER ENABLE SWITCH ON',
          r ? JSON.stringify(r[0]) : 'null');
    check('the request asks for 32 characters, not 64',
          sent[sent.length - 1].args[3] === 32, JSON.stringify(sent[sent.length - 1].args));

    // A 64-character request must be clamped to 32 rather than trusted.
    script = [reply(alm.toString('hex'))];
    await mk().readalarmcode(-1, 1, 10, 64);
    check('a 64-char request is clamped to 32', sent[sent.length - 1].args[3] === 32,
          JSON.stringify(sent[sent.length - 1].args));

    // A payload that is not a whole number of records must raise, not mis-slice.
    script = [reply(alm.toString('hex') + '00'.repeat(8))];
    let threw = null;
    try { await mk().readalarmcode(-1, 1, 10, 32); } catch (e) { threw = e.message; }
    check('a 56-byte payload raises instead of mis-slicing', /not a whole number/.test(threw || ''),
          threw);

    // ── 5. Tool-life layouts: 20-byte and C-struct forms ─────────────────────
    h('5 — tool-life reads accept both the measured and the C-struct layouts');
    const tl20 = '00 00 00 14 00 00 01 00 00 00 00 04 00 01 86 a0 05 f5 e0 ff';
    script = [reply(tl20)];
    r = await mk().readtlinfo();
    check('20-byte cnc_rdtlinfo: max_group 256, max_tool 4, max_minute 100000, max_cycle 99999999',
          r.max_group === 256 && r.max_tool === 4 && r.max_minute === 100000 && r.max_cycle === 99999999,
          JSON.stringify(r));

    // The C ODBTLINFO: four longs, no leading count.
    script = [reply('00 00 01 00 00 00 00 04 00 01 86 a0 05 f5 e0 ff')];
    r = await mk().readtlinfo();
    check('16-byte cnc_rdtlinfo (C ODBTLINFO) decodes at +0',
          r.max_group === 256 && r.max_tool === 4, JSON.stringify(r));

    script = [reply(tl20)];
    r = await mk().readngrp();
    check('20-byte cnc_rdngrp: 20 groups', r === 20, String(r));

    // The C ODBTLIFE2: dummy[2] then the count at +4.
    script = [reply('00 00 00 00 00 00 00 14')];
    r = await mk().readngrp();
    check('8-byte cnc_rdngrp (C ODBTLIFE2) reads the count at +4, not 0', r === 20, String(r));

    script = [reply('00 00 00 00 00 00 00 02 00 00 00 02')];
    r = await mk().readusegrpid();
    check('12-byte cnc_rdusegrpid: next 0, use 2, slct 2',
          r.next === 0 && r.use === 2 && r.slct === 2, JSON.stringify(r));

    // The C ODBUSEGR: datano/type shorts, then the three longs at +4.
    script = [reply('00 00 00 00 00 00 00 02 00 00 00 02 00 00 00 03')];
    r = await mk().readusegrpid();
    check('16-byte cnc_rdusegrpid (C ODBUSEGR) skips the leading shorts',
          r.next === 2 && r.use === 2 && r.slct === 3, JSON.stringify(r));

    // ── 6. PMC status table ──────────────────────────────────────────────────
    h('6 — pmc_rdalmmsg reports PMC status names, not CNC ones');
    script = [{ len: 0, error: 1 }];
    threw = null;
    try { await mk().readpmcalarm(1, 10); } catch (e) { threw = e.message; }
    check('PMC status 1 is EW_NOPMC, not EW_FUNC', /EW_NOPMC/.test(threw || ''), threw);
    script = [{ len: 0, error: 3 }];
    threw = null;
    try { await mk().readpmcalarm(1, 10); } catch (e) { threw = e.message; }
    check('PMC status 3 is EW_RANGE, not EW_NUMBER', /EW_RANGE/.test(threw || ''), threw);
    script = [{ len: 0, error: 4 }];
    threw = null;
    try { await mk().readpmcalarm(1, 10); } catch (e) { threw = e.message; }
    check('PMC status 4 is EW_TYPE, not EW_ATTRIB', /EW_TYPE/.test(threw || ''), threw);

    // ── 7. Axis names: 4-byte records, data_num 0 ────────────────────────────
    h('7 — axis / spindle names use 4-byte records and send data_num 0');
    script = [reply('58 00 6e 10 59 00 6e 10 5a 00 6e 10 42 00 6e 10 58 32 00 10')];
    r = await mk().readaxisnames(5);
    check('five axis names X Y Z B X2', JSON.stringify(r) === '["X","Y","Z","B","X2"]',
          JSON.stringify(r));
    check('the request sends data_num 0', sent[sent.length - 1].args[0] === 0,
          JSON.stringify(sent[sent.length - 1].args));

    script = [reply('53 31 00 10')];
    r = await mk().readspindlenames(1);
    check('spindle name S1', JSON.stringify(r) === '["S1"]', JSON.stringify(r));

    // ── 8. Load meters: signed on the wire, magnitudes out ───────────────────
    h('8 — load meters report magnitudes for both servo and spindle');
    // 0x56[1]: five axes at dec 0, signed.
    const sv = Buffer.alloc(32 * 8);
    [-12, 33, -10, 0, -24].forEach((v, i) => {
        sv.writeInt32BE(v, i * 8);
        sv.writeInt16BE(10, i * 8 + 4);
        sv.writeInt16BE(0, i * 8 + 6);
    });
    script = [reply('00 05'), reply(sv.toString('hex'))];
    r = await mk().readsvmeter();
    check('servo load is a magnitude: [12,33,10,0,24]',
          JSON.stringify(r) === '[12,33,10,0,24]', JSON.stringify(r));

    // 0x40[0]: one spindle, 16-byte records, signed.
    const sp = Buffer.alloc(16);
    sp.writeInt32BE(-80, 0);
    sp.writeInt16BE(10, 4);
    sp.writeInt16BE(0, 6);
    script = [reply('00 01'), reply(sp.toString('hex'))];
    r = await mk().readspmeter();
    check('spindle load is a magnitude too: [80]', JSON.stringify(r) === '[80]', JSON.stringify(r));

    // ── 9. statinfo: the 14-byte block, and Series 15's own shape ────────────
    h('9 — statinfo decodes the 14-byte block and Series 15 separately');
    script = [reply('00 01 00 03 00 01 00 00 00 00 00 00 00 00')];
    r = await mk().statinfo();
    check('aut 1 (MEMory), run 3 (STaRt), motion 1',
          r && r.aut === 1 && r.run === 3 && r.motion === 1, JSON.stringify(r));

    const f15 = mk();
    f15.sysinfo = { cnctype: '15', maxaxis: 10, mttype: ' M', series: 'B0F1', version: '0001', axes: ' 3' };
    script = [reply('00 01 00 00 00 02 00 00 00 01 00 00 00 00 00 00 00 00 00 00')];
    r = await f15.statinfo();
    check('Series 15 decodes its own ODBST (aut 1, run 2)',
          r && r.aut === 1 && r.run === 2, JSON.stringify(r));

    // ── 10. The node layer ───────────────────────────────────────────────────
    h('10 — the node reports the current axis count, not max_axis');
    const configNode = { host: '127.0.0.1', port: 8193, cnc_series: '16', label: () => 'stub' };
    let pollNode = null;
    const RED = {
        nodes: {
            createNode(node) {
                node.on     = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
                node.status = () => {};
                node.error  = () => {};
                return node;
            },
            registerType(type, ctor) {
                if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'system_info', subtype: '', params: '' });
            },
            getNode: () => configNode,
        },
    };
    require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);
    const poll = fn => new Promise((resolve, reject) => {
        pollNode._handlers.input({ function: fn }, m => resolve(m.payload), e => (e ? reject(e) : null));
    });

    script = [];
    r = await poll('system_info');
    check('axes is the current count (5), max_axes is the maximum (32)',
          r.axes === 5 && r.max_axes === 32, JSON.stringify(r));

    // mstb 1 means FINished, not "active"; motion 2 is a dwell, not "moving".
    script = [reply('00 01 00 03 00 02 00 01 00 00 00 00 00 00')];
    r = await poll('status_info');
    check('mstb 1 reads "Finished"', r.mstb === 'Finished', JSON.stringify(r.mstb));
    check('motion 2 reads "Dwelling", not "Moving"', r.motion === 'Dwelling', JSON.stringify(r.motion));

    h(failures === 0 ? `PASS — ${'all'} decoder checks hold`
                     : `FAIL — ${failures} assertion(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
