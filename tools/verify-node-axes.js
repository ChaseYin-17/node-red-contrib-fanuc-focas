'use strict';
/**
 * tools/verify-node-axes.js — regression test for the position reads.
 *
 * The CNC sizes every position block for the maximum axis count and leaves the slots
 * past the axes it controls undefined. Those slots still carry a decimal flag, so
 * decoding them produced plausible-looking numbers that were not positions — the
 * symptom was an absolute-position array of 256 entries full of 5.19e-24-style values.
 *
 * The official library returns the same integers at the same indices; its contract is
 * that only the current axes are valid. This test asserts the node now holds to that
 * contract: one entry per real axis, never a slot beyond them.
 *
 * Usage: node tools/verify-node-axes.js [ip] [port]
 */
const path = require('path');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);

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
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'axes_data', subtype: 'abs_pos', params: '' });
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
        setTimeout(() => { if (!settled) { settled = true; resolve(out); } }, 20000);
    });
}

(async () => {
    require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);
    console.log(`node position verification → ${IP}:${PORT}`);

    const { Focas } = require('../focas');
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    const axes = await f.readaxiscount(2);
    const maxaxis = f.sysinfo.maxaxis;
    console.log(`  real servo axes = ${axes}   sysinfo.maxaxis = ${maxaxis}` +
                (axes < maxaxis ? '  (block is oversized — the extra slots are undefined)' : ''));

    let bad = 0;
    // fnAxesData wraps the position set: { absolute_position: { ABS: [...] } }
    for (const [subtype, key, inner] of [['abs_pos','absolute_position','ABS'], ['rel_pos','relative_position','REL'],
                                         ['machine_pos','machine_position','REF'], ['dist_to_go','distance_to_go','DIST']]) {
        const p = (await poll({ subtype })).payload;
        const vals = (p[key] || {})[inner];
        const ok = Array.isArray(vals) && vals.length === axes;
        if (!ok) bad++;
        console.log(`  ${subtype.padEnd(12)} ${ok ? '✔' : '✗'} len=${Array.isArray(vals) ? vals.length : 'n/a'}  ${JSON.stringify(vals)}`);
        if (Array.isArray(vals) && vals.length > axes)
            console.log(`      ✗ ${vals.length - axes} slot(s) past the real axes leaked through`);
    }

    await f.disconnect();
    h(bad === 0 ? 'PASS — every position read is bounded by the real axis count'
                : `FAIL — ${bad} sub-type(s) returned the wrong number of axes`);
    process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });