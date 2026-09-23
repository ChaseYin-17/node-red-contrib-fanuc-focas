'use strict';
/**
 * tools/verify-node-alarms.js — end-to-end regression test for the alarm fix.
 *
 * Drives the *real* node code (fanuc-focas.js) through a stub RED runtime, so it exercises
 * almSeriesGroup() -> fnAlarmMessages() -> Focas.readalarmcode() exactly as Node-RED does.
 *
 * Usage: node tools/verify-node-alarms.js [ip] [port] [cnc_series]
 */
const path = require('path');

const IP         = process.argv[2] || '192.168.100.128';
const PORT       = parseInt(process.argv[3] || '8193', 10);
const CNC_SERIES = process.argv[4] || '16';

// ── Stub the Node-RED runtime ─────────────────────────────────────────────────
const configNode = {
    host: IP, port: PORT, cnc_series: CNC_SERIES,
    label: () => `${IP}:${PORT}`,
};
let pollNode = null;

const RED = {
    nodes: {
        createNode(node, config) {
            node.on      = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
            node.status  = (s) => { node._status = s; };
            node.error   = (m) => { node._error = m; };
            return node;
        },
        registerType(type, ctor) {
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'all', subtype: 'feedrate', params: '' });
        },
        getNode: () => configNode,
    },
};

const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

// Run one poll through the node's real input handler.
function poll(msg) {
    const handler = pollNode._handlers.input;
    return new Promise((resolve, reject) => {
        let out = null;
        handler(msg, (m) => { out = m; }, (err) => { if (err) reject(err); else resolve(out); });
    });
}

(async () => {
    require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);
    if (!pollNode) throw new Error('fanuc-focas node was not registered');

    console.log(`node wired to ${IP}:${PORT} (cnc_series=${CNC_SERIES})`);

    h('CASE 1 — fn = "alarm_messages" (the function that was returning [])');
    const a = await poll({ function: 'alarm_messages' });
    console.log(JSON.stringify(a.payload, null, 2));
    console.log(`\n  status   = ${JSON.stringify(pollNode._status)}`);
    console.log(`  isArray  = ${Array.isArray(a.payload)}  (must be true — see collect())`);
    console.log(`  keys     = ${JSON.stringify(Object.keys(a.payload).filter(k => isNaN(Number(k))))}`);
    if (!Array.isArray(a.payload))   console.log('  ✗ list result was object-spread — regression.');
    else if (a.payload.length === 0) console.log('  ⚠ still empty — investigate.');
    else                             console.log(`  ✔ recovered ${a.payload.length} alarm(s).`);

    h('CASE 2 — fn = "all" (active_alarms inside the combined payload)');
    const b = await poll({ function: 'all' });
    console.log('  machine_state =', JSON.stringify(b.payload.machine_state));
    console.log('  active_alarms =', JSON.stringify(b.payload.active_alarms, null, 2));
    if (!b.payload.active_alarms || b.payload.active_alarms.length === 0) console.log('  ⚠ active_alarms still empty.');
    else console.log(`  ✔ active_alarms has ${b.payload.active_alarms.length} entry/entries.`);

    h('CASE 3 — deliberate error path: out-of-range type must THROW, not return []');
    // Reaches past the node layer to confirm readalarmcode surfaces EW_ATTRIB.
    const { Focas } = require(path.join(__dirname, '..', 'focas.js'));
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    for (const t of [32, 99]) {
        try {
            const r = await f.readalarmcode(t, 1, 10, 32);
            console.log(`  type=${t} → returned ${JSON.stringify(r)}  ✗ expected a throw`);
        } catch (e) {
            console.log(`  type=${t} → threw: ${e.message}  ✔`);
        }
    }
    try {
        const r = await f.readalarmcode(-1, 1, 10, 32);
        console.log(`  type=-1 → ${JSON.stringify(r)}  ✔ (all categories)`);
    } catch (e) {
        console.log(`  type=-1 → threw: ${e.message}  ✗`);
    }
    await f.disconnect();

    h('CASE 4 — a non-alarm field fails: the rest of "all" must still come through');
    const realFeed = Focas.prototype.readactfeed;
    Focas.prototype.readactfeed = async () => { throw new Error('simulated EW_BUFFER (10)'); };
    try {
        const p = (await poll({ function: 'all' })).payload;
        console.log('  feedrate_spindle =', JSON.stringify(p.feedrate_spindle));
        console.log('  errors           =', JSON.stringify(p.errors));
        console.log('  active_alarms    =', p.active_alarms ? `${p.active_alarms.length} entry/entries` : String(p.active_alarms));
        const ok = p.feedrate_spindle.actual_feedrate_mm_min === null
                && typeof p.errors.actual_feedrate_mm_min === 'string'
                && Array.isArray(p.active_alarms) && p.active_alarms.length > 0
                && p.machine_state !== null;
        console.log(ok ? '  ✔ degraded to null, everything else intact' : '  ✗ unexpected payload');
    } finally {
        Focas.prototype.readactfeed = realFeed;
    }

    h('CASE 5 — the alarm read fails: active_alarms must be null, NOT []');
    const realAlarm = Focas.prototype.readalarmcode;
    Focas.prototype.readalarmcode = async () => { throw new Error('cnc_rdalmmsg: CNC returned EW_NOOPT (6) for type=-1'); };
    try {
        const p = (await poll({ function: 'all' })).payload;
        console.log('  active_alarms =', JSON.stringify(p.active_alarms));
        console.log('  errors        =', JSON.stringify(p.errors));
        console.log('  machine_state =', JSON.stringify(p.machine_state));
        console.log(p.active_alarms === null
            ? '  ✔ null (distinguishable from [] = "no alarms")'
            : '  ✗ must be null when the read failed');

        // A standalone poll of the same function must still surface the error loudly.
        try {
            await poll({ function: 'alarm_messages' });
            console.log('  ✗ standalone alarm_messages swallowed the error');
        } catch (e) {
            console.log(`  ✔ standalone alarm_messages still throws: ${e.message}`);
        }
    } finally {
        Focas.prototype.readalarmcode = realAlarm;
    }

    h('DONE');
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });