'use strict';
/**
 * tools/probe-param-types.js — READ-ONLY: find a real-type parameter and pin the
 * per-axis record stride of cnc_rdparam3 (0x8d).
 *
 * The vendor capture (tools/probe-dll-param.py) showed the wire is
 *   datano(i32) | type(i16, upper=type lower=axis) | attr(i16) | records
 * with an 8-byte record per axis and the value as a big-endian i32 at +0.
 * This sweeps parameter numbers to find which `attr` codes occur, so the decoder
 * can be written against observed values instead of the SDK's documented enum.
 *
 * Read-only: cnc_rdparam3 only.
 *
 * Usage: node tools/probe-param-types.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.233.166';
const PORT = parseInt(process.argv[3] || '8193', 10);

const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : '-';
const i16 = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : '-';
const u16 = (b, o) => (o + 2 <= b.length) ? b.readUInt16BE(o) : '-';

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    const maxaxis = f.sysinfo.maxaxis;
    console.log(`connected ${IP}:${PORT}  maxaxis=${maxaxis}`);

    const nums = [];
    for (let n = 1000; n <= 1030; n++) nums.push(n);
    for (const n of [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1825, 1850,
                     2000, 3000, 4000, 5000, 5001, 5002, 6000, 6700, 6711, 6750,
                     8000, 9000, 10000, 11000, 11001, 11002, 12000, 13000, 14000,
                     15000, 16000, 17000, 18000, 19000, 20000]) nums.push(n);

    const byAttr = new Map();
    console.log('\n  param   type   attr  len   stride  first records (i32 @ +0 of each)');
    console.log('  ─────   ────   ────  ────  ──────  ────────────────────────────────');
    for (const n of nums) {
        let st;
        try {
            st = await f._reqSingle(1, 1, 0x8d, n, n, -1);
        } catch (e) {
            console.log(`  ${String(n).padStart(5)}   THREW ${e.message}`);
            try { f.socket.removeAllListeners('data'); f.socket.removeAllListeners('error'); } catch (_) {}
            continue;
        }
        if (st.error !== undefined || !st.data || st.data.length < 8) continue;
        const d = st.data;
        const type = u16(d, 4);
        const attr = u16(d, 6);
        const stride = (d.length - 8) / maxaxis;
        const recs = [];
        for (let a = 0; a < Math.min(6, maxaxis); a++) recs.push(i32(d, 8 + a * stride));
        console.log(`  ${String(n).padStart(5)}   0x${type.toString(16).padStart(4, '0')}` +
                    `   ${String(attr).padStart(4)}  ${String(d.length).padStart(4)}` +
                    `  ${String(stride).padStart(6)}  ${recs.join(', ')}`);
        if (!byAttr.has(attr)) byAttr.set(attr, []);
        byAttr.get(attr).push(n);
    }

    console.log('\n  attr codes seen:');
    for (const [attr, list] of [...byAttr.entries()].sort((a, b) => a[0] - b[0]))
        console.log(`    attr=${attr}  (${list.length} params)  e.g. ${list.slice(0, 8).join(', ')}`);

    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
