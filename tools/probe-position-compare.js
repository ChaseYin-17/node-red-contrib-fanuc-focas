'use strict';
/**
 * tools/probe-position-compare.js — READ-ONLY: does readaxes() agree with the vendor
 * library's cnc_rdaxisdata(cls=1)?
 *
 * focas.js reads the four position types with 0x26 sub-selectors 4/6/1/8/7. The vendor
 * capture (tools/probe-dll-opcode.py, cls=1) shows the library using 0x88[1], 0x88[2],
 * 0xa3[0,-1] and 0x26[0,-1] instead. This prints both, in one session, so the mapping
 * can be judged from values rather than from the selector numbers.
 *
 * Read-only: every request is a read.
 *
 * Usage: node tools/probe-position-compare.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.233.166';
const PORT = parseInt(process.argv[3] || '8193', 10);

const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : '-';
const i16 = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : '-';

// 8-byte records: value(i32) + format(i16) + dec(i16)
const rec8 = (d, n) => Array.from({ length: n }, (_, i) => {
    const v = i32(d, i * 8), dec = i16(d, i * 8 + 6);
    return (v / Math.pow(10, dec)).toFixed(3);
}).join('  ');

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    const nAx = await f.readaxiscount(2);
    const names = await f.readaxisnames(nAx);
    console.log(`connected ${IP}:${PORT}  axes=${nAx} ${JSON.stringify(names)}`);

    // What the node reports today.
    console.log('\n── readaxes() as the node does it (0x26 sub-selectors)');
    for (const [what, label] of [[1, 'ABS'], [4, 'REF'], [2, 'REL'], [16, 'DIST']]) {
        const r = await f.readaxes(what);
        console.log(`   ${label.padEnd(5)} ${JSON.stringify(r)}`);
    }

    // What the vendor library uses, decoded the same way.
    console.log('\n── the vendor library\'s opcodes');
    for (const [label, c3, args] of [
        ['0x88[1]', 0x88, [1, 0]],
        ['0x88[2]', 0x88, [2, 0]],
        ['0xa3[0,-1]', 0xa3, [0, -1]],
        ['0x26[0,-1]', 0x26, [0, -1]],
    ]) {
        const st = await f._reqSingle(1, 1, c3, ...args);
        const d = st.data || Buffer.alloc(0);
        console.log(`   ${label.padEnd(10)} err=${st.error ?? 0} len=${st.len}` +
                    (d.length >= nAx * 8 ? `  as 8-byte: ${rec8(d, nAx)}` : ''));
        if (d.length >= nAx * 4 && d.length < nAx * 8)
            console.log(`   ${''.padEnd(10)} as 4-byte: ` +
                Array.from({ length: nAx }, (_, i) => i32(d, i * 4)).join('  '));
    }

    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
