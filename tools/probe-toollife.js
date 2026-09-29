'use strict';
/**
 * tools/probe-toollife.js — dump the raw tool-life responses.
 *
 * The wire layout of the tool-life calls is not the SDK's C struct: fields are widened
 * to 4-byte longs and at least one call carries a leading long. The opcodes themselves
 * come from tools/probe-dll-opcode.py; this dumps the *payloads* so the offsets in
 * focas.js can be pinned against real bytes rather than inferred.
 *
 * Every call here is a read. Needs a controller with the tool-life-management option;
 * without it the four calls answer EW_NOOPT and there is nothing to decode.
 *
 * Usage: node tools/probe-toollife.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex  = b => b ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : null;
const i32  = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : '-';
const i16  = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : '-';
const at   = (b, offs) => offs.map(o => i32(b, o)).join(', ');

(async () => {
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}` +
                `  series=${JSON.stringify(f.sysinfo.series)}`);

    for (const [name, c3, args] of [
        ['cnc_rdngrp     0x4a ', 0x4a,  []],
        ['cnc_rdtlinfo   0x1c4', 0x1c4, []],
        ['cnc_rdusegrpid 0x48 ', 0x48,  []],
        ['cnc_rdgrpinfo4 0x1c1', 0x1c1, [1, 0, 64]],
    ]) {
        console.log('\n──────────────────────────────────────────────────────────────────────');
        try {
            const st = await f._reqSingle(1, 1, c3, ...args);
            console.log(`${name}  len=${st.len}  error=${st.error}`);
            if (!st.data) { console.log('  (no data)'); continue; }
            console.log(`  bytes : ${hex(st.data)}`);
            console.log(`  int32 : ${at(st.data, [0, 4, 8, 12, 16, 20])}`);
            console.log(`  int16 : ${[0, 2, 4, 6, 8, 10, 12, 14].map(o => i16(st.data, o)).join(', ')}`);
            if (c3 === 0x1c1) {
                const n = Math.floor(st.data.length / 28);
                console.log(`  ${n} group record(s) of 28 bytes`);
                for (let r = 0; r < Math.min(3, n); r++) {
                    const p = r * 28;
                    console.log(`    rec${r} i32 @0,4,8,12,16,20,24 = ${at(st.data, [p, p+4, p+8, p+12, p+16, p+20, p+24])}`);
                    console.log(`          i16 @0,2 = ${i16(st.data, p)}, ${i16(st.data, p+2)}`);
                }
            }
        } catch (e) {
            console.log(`${name}  THREW ${e.message}`);
        }
    }

    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
