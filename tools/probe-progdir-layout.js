'use strict';
/**
 * tools/probe-progdir-layout.js — READ-ONLY: pin the cnc_rdprogdir (0x06) record layout.
 *
 * The node parses 0x06 as 72-byte records of number(4) + length(4) + comment(64), which
 * is not any structure in the SDK. This dumps the payload and tries every plausible
 * stride so the layout can be settled from bytes rather than inferred.
 *
 * Read-only: one 0x06 request, nothing else.
 *
 * Usage: node tools/probe-progdir-layout.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.233.166';
const PORT = parseInt(process.argv[3] || '8193', 10);

const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : null;
const txt = (b, o, n) => {
    let s = b.slice(o, o + n);
    const z = s.indexOf(0);
    if (z !== -1) s = s.slice(0, z);
    return s.toString('latin1');
};

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}` +
                ` maxaxis=${f.sysinfo.maxaxis} axes=${JSON.stringify(f.sysinfo.axes)}`);

    // arg0 = start program number, arg1 = how many to read, arg2 = format selector.
    // 0x13 = 19 was the count the node asks for; ask for a small number so the
    // record boundaries are unambiguous.
    for (const [label, args] of [
        ['start=1 n=3  fmt=2', [1, 3, 2]],
        ['start=1 n=1  fmt=2', [1, 1, 2]],
        ['start=1 n=2  fmt=2', [1, 2, 2]],
    ]) {
        const st = await f._reqSingle(1, 1, 0x06, ...args);
        console.log(`\n── ${label}  args=[${args}]  err=${st.error ?? 0}  len=${st.len}`);
        if (!st.data || !st.data.length) continue;
        const d = st.data;
        console.log(`   hex: ${d.toString('hex').replace(/(..)/g, '$1 ').trim()}`);

        for (const stride of [72, 76, 80, 88, 92, 96, 100, 104, 108, 112, 120, 128]) {
            if (d.length % stride !== 0) continue;
            const n = d.length / stride;
            console.log(`   stride ${stride} → ${n} record(s):`);
            for (let r = 0; r < Math.min(n, 4); r++) {
                const p = r * stride;
                console.log(`     [${r}] i32 @0,4,8,12 = ${[0, 4, 8, 12].map(o => i32(d, p + o)).join(', ')}` +
                            `   text@8=${JSON.stringify(txt(d, p + 8, stride - 8))}`);
            }
        }
    }

    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
