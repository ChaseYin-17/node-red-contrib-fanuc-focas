'use strict';
/**
 * tools/verify-node-toollife.js — end-to-end check for the tool-life reader.
 *
 * Drives the *real* node code (fanuc-focas.js) through a stub RED runtime, so it
 * exercises fnToolLife() -> Focas.readtlinfo()/readngrp()/readusegrpid()/
 * readgrpinfo4() exactly as Node-RED does.
 *
 * WHAT IT CAN AND CANNOT CONFIRM
 *   Tool-life management is a separate CNC option. On a controller without it every
 *   call answers EW_NOOPT (6) — and this script says so rather than failing: the
 *   opcodes and the call arguments are confirmed by the request reaching the
 *   controller, but the response record layout cannot be. Run it on a controller
 *   WITH the option to check the decoded numbers against the machine's own tool-life
 *   screen; that is the only thing that validates the byte offsets in focas.js.
 *
 * What it guards against:
 *   - EW_NOOPT being mistaken for an empty tool table
 *   - groups[] not being an array of fully-populated records
 *   - usage_percent / remaining being reported as 0 when there is no life set
 *   - more than one group flagged in_use
 *
 * Usage: node tools/verify-node-toollife.js [ip] [port]
 */
const path = require('path');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);

// ── Stub the Node-RED runtime ─────────────────────────────────────────────────
const configNode = { host: IP, port: PORT, cnc_series: '16', label: () => `${IP}:${PORT}` };
let pollNode = null;

const RED = {
    nodes: {
        createNode(node) {
            node.on     = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
            node.status = (s) => { node._status = s; };
            node.error  = (m) => { node._error = m; };
            return node;
        },
        registerType(type, ctor) {
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'tool_life', subtype: 'feedrate', params: '' });
        },
        getNode: () => configNode,
    },
};

const h = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);

function poll(msg) {
    const handler = pollNode._handlers.input;
    return new Promise((resolve, reject) => {
        let out = null, settled = false;
        handler(msg, (m) => { out = m; },
                      (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(out); });
        // Reject rather than resolve: a poll that never calls back is a failure, and
        // resolving would hand back a null payload that fails later as a confusing crash.
        setTimeout(() => { if (!settled) { settled = true; reject(new Error('poll did not finish within 20s')); } }, 20000);
    });
}

// EW_NOOPT means the option is off, not that anything here is broken.
function reportFailure(e) {
    const msg = (e && e.message) || String(e);
    if (/EW_NOOPT/.test(msg)) {
        console.log(`  ⚠ controller refused: ${msg}`);
        console.log('    → tool-life management is not enabled on this CNC.');
        console.log('    → the opcode/arguments are confirmed (the request was answered),');
        console.log('      but the response layout is NOT exercised. Re-run on a controller');
        console.log('      with the option to validate the decoded numbers.');
    } else {
        console.log(`  ✗ ${msg}`);
    }
}

function checkShape(tl) {
    if (!Array.isArray(tl.groups)) {
        console.log(`  ✗ groups must be an array, got ${typeof tl.groups}`);
        return;
    }
    console.log(`  ✔ groups is an array of ${tl.groups.length} registered group(s)`);
    if (tl.groups.length === 0) console.log('  ⚠ no tool groups registered');

    let bad = 0;
    for (const g of tl.groups) {
        for (const k of ['group', 'tool_count', 'life', 'counter', 'count_type', 'unit']) {
            if (g[k] === undefined) { console.log(`  ✗ group ${g.group} is missing "${k}"`); bad++; }
        }
        if (g.life === 0 && (g.remaining !== null || g.usage_percent !== null))
            console.log(`  ✗ group ${g.group} has no life set but reports remaining/usage instead of null`);
        if (g.usage_percent !== null && (g.usage_percent < 0 || g.usage_percent > 100))
            console.log(`  ✗ group ${g.group} usage_percent out of range: ${g.usage_percent}`);
    }
    if (bad === 0) console.log('  ✔ every group record is fully populated');

    const inUse = tl.groups.filter(g => g.in_use).map(g => g.group);
    if (inUse.length > 1) console.log(`  ✗ more than one group flagged in_use: ${inUse.join(', ')}`);
    else if (inUse.length === 1) console.log(`  ✔ in_use group: ${inUse[0]}`);

    if (tl.most_used_group !== null && !tl.groups.some(g => g.group === tl.most_used_group))
        console.log(`  ✗ most_used_group ${tl.most_used_group} is not one of the groups read`);
    else
        console.log(`  ✔ most_used_group = ${tl.most_used_group}`);
}

(async () => {
    require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);
    console.log(`node tool-life verification → ${IP}:${PORT}`);

    h('CASE 1 — fn = "tool_life" through the Node-RED node');
    try {
        const payload = (await poll({})).payload;
        console.log(JSON.stringify(payload, null, 2));
        checkShape(payload);
    } catch (e) {
        reportFailure(e);
    }

    h('CASE 2 — raw Focas tool-life reads');
    const { Focas } = require('../focas');
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log('  cnc_type', JSON.stringify(f.sysinfo.cnctype), 'series', JSON.stringify(f.sysinfo.series));
    for (const [label, run] of [
        ['cnc_rdtlinfo   -> readtlinfo()',   () => f.readtlinfo()],
        ['cnc_rdngrp     -> readngrp()',     () => f.readngrp()],
        ['cnc_rdusegrpid -> readusegrpid()', () => f.readusegrpid()],
        ['cnc_rdgrpinfo4 -> readgrpinfo4()', () => f.readgrpinfo4()],
    ]) {
        try   { console.log(`  ${label}: ${JSON.stringify(await run())}`); }
        catch (e) { console.log(`  ${label}: ${e.message}`); }
    }
    await f.disconnect();

    h('DONE');
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
