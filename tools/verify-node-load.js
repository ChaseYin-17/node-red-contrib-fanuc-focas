'use strict';
/**
 * tools/verify-node-load.js — end-to-end regression test for the load meters.
 *
 * Drives the *real* node code (fanuc-focas.js) through a stub RED runtime, so it
 * exercises fnAxesData() -> Focas.readsvmeter()/readspmeter()/readaxisnames()/
 * readspindlenames() exactly as Node-RED does.
 *
 * What it guards against:
 *   - a silent null (the old cnc_diagnoss path swallowed EW_FUNC)
 *   - servo_load_percent coming back as a scalar instead of a per-axis array
 *   - the axis/spindle names not lining up with the values
 *
 * Usage: node tools/verify-node-load.js [ip] [port]
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
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'axes_data', subtype: 'servo_load', params: '' });
        },
        getNode: () => configNode,
    },
};

const h = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);

// Node-RED delivers either the payload or the error depending on the signature used.
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
    console.log(`node load-meter verification → ${IP}:${PORT}`);

    h('CASE 1 — fn = "axes_data", subtype = "servo_load"');
    const sv = (await poll({ subtype: 'servo_load' })).payload;
    console.log(JSON.stringify(sv, null, 2));
    const svVals  = sv.servo_load_percent;
    const svNames = sv.servo_load_axes;
    if (!Array.isArray(svVals))       console.log('  ✗ servo_load_percent must be an ARRAY, got ' + typeof svVals);
    else if (svVals.length === 0)     console.log('  ⚠ no servo axes reported');
    else                              console.log(`  ✔ ${svVals.length} servo axis reading(s): ${svVals.join(', ')}`);
    if (!Array.isArray(svNames) || svNames.length !== (svVals || []).length)
        console.log(`  ✗ servo_load_axes (${JSON.stringify(svNames)}) must line up 1:1 with the values`);
    else
        console.log(`  ✔ axes ${JSON.stringify(svNames)} line up with the values`);

    h('CASE 2 — fn = "axes_data", subtype = "spindle_load"');
    const sp = (await poll({ subtype: 'spindle_load' })).payload;
    console.log(JSON.stringify(sp, null, 2));
    if (Array.isArray(sp.spindle_load_percents) && sp.spindle_load_percents.length)
        console.log(`  ✔ ${sp.spindle_load_percents.length} spindle reading(s): ${sp.spindle_load_percents.join(', ')}`);
    else console.log('  ⚠ no spindle readings');
    if (sp.spindle_load_percent === null)
        console.log('  ⚠ scalar spindle_load_percent is null while percents is ' + JSON.stringify(sp.spindle_load_percents));

    h('CASE 3 — raw Focas API, types the vendor library accepts');
    const { Focas } = require('../focas');
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log('  cnc_rdsvmeter        ->', JSON.stringify(await f.readsvmeter()));
    console.log('  cnc_rdspmeter(LOAD)  ->', JSON.stringify(await f.readspmeter(0)));
    console.log('  cnc_rdspmeter(SPEED) ->', JSON.stringify(await f.readspmeter(1)));
    console.log('  axis names           ->', JSON.stringify(await f.readaxisnames(3)));
    console.log('  spindle names        ->', JSON.stringify(await f.readspindlenames(1)));
    await f.disconnect();

    h('DONE');
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });