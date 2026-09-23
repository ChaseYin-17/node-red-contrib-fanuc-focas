'use strict';
/**
 * tools/verify-node-sessions.js — regression test for "Open handshake failed".
 *
 * A FOCAS controller accepts only a handful of concurrent sessions (5 on the machine
 * this was measured against). Every poll opens one, so polls that overlap — an inject
 * faster than a poll, or several nodes wired to one inject — used to have the extra
 * ones turned away.
 *
 * The controller answers such a request with frame type 0x0103 rather than the usual
 * open response, which the node reported as an opaque "Open handshake failed". Two
 * things are asserted here:
 *
 *   1. a refusal is named as one, and the refused socket is torn down
 *   2. one node serialises its polls, so a burst of messages all succeed
 *
 * Usage: node tools/verify-node-sessions.js [ip] [port] [burst]
 */
const path = require('path');

const IP    = process.argv[2] || '192.168.100.128';
const PORT  = parseInt(process.argv[3] || '8193', 10);
const BURST = parseInt(process.argv[4] || '16', 10);

const { Focas } = require(path.join(__dirname, '..', 'focas.js'));

const configNode = { host: IP, port: PORT, cnc_series: '16', label: () => `${IP}:${PORT}` };
let pollNode = null;

const RED = {
    nodes: {
        createNode(node) {
            node.on     = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
            node.status = ()  => {};
            node.error  = (m) => { node._error = m; };
            return node;
        },
        registerType(type, ctor) {
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'all', subtype: '', params: '' });
        },
        getNode: () => configNode,
    },
};

const h = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);
let failures = 0;

(async () => {
    console.log(`session-limit verification → ${IP}:${PORT}`);

    // ── How many sessions will the controller hold at once? ──────────────────
    h('PROBE — how many concurrent sessions the controller allows');
    const held = [];
    try {
        for (let i = 0; i < 32; i++) {
            const f = new Focas(IP, PORT, 4000);
            try { await f.connect(); held.push(f); } catch (_) { break; }
        }
        const limit = held.length;
        console.log(`  the controller stopped accepting after ${limit} session(s)`);

        h('CASE 1 — one more session, with every slot taken');
        const extra = new Focas(IP, PORT, 6000);
        try {
            await extra.connect();
            console.log('  ✗ unexpectedly opened — cannot exercise the refusal path');
            held.push(extra);
            failures++;
        } catch (e) {
            console.log(`  message: ${e.message}`);
            const named = /refused/i.test(e.message) && /session/i.test(e.message);
            const legacy = /^Open handshake failed$/.test(e.message);
            if (legacy) { console.log('  ✗ still the opaque message — the reason is not reported'); failures++; }
            else if (named) console.log('  ✔ the refusal is named, not reported as a generic handshake failure');
            else { console.log('  ✗ message does not say the session was refused'); failures++; }
            console.log(`  socket torn down: ${extra.socket === null ? '✔' : '✗ still held — it would keep a slot'}`);
            if (extra.socket !== null) failures++;
        }
    } finally {
        for (const f of held) { try { await f.disconnect(); } catch (_) {} }
    }
    await new Promise(r => setTimeout(r, 500));

    // ── One node, many messages at once ──────────────────────────────────────
    h(`CASE 2 — ${BURST} messages fired at one node simultaneously`);
    require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);
    const handler = pollNode._handlers.input;
    let ok = 0, bad = 0;
    const seen = [];
    await new Promise(res => {
        for (let i = 0; i < BURST; i++) {
            const msg = { i };
            seen.push(msg);
            handler(msg, () => {}, (err) => {          // done(err): undefined means success
                if (err) { bad++; console.log(`    msg[${i}]: ${err.message}`); } else ok++;
                if (ok + bad === BURST) res();
            });
        }
    });
    console.log(`  ok=${ok}  failed=${bad}`);
    if (bad) { console.log('  ✗ concurrent messages still collide — polls are not serialised'); failures++; }
    else console.log('  ✔ every message got its turn; the node queues instead of opening sessions');
    const stamped = seen.filter(m => m.payload && m.payload.timestamp).length;
    console.log(`  payloads delivered: ${stamped}/${BURST}`);
    if (stamped !== BURST) failures++;

    h(failures === 0 ? 'PASS — refusals are named and polls are serialised'
                     : `FAIL — ${failures} assertion(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });