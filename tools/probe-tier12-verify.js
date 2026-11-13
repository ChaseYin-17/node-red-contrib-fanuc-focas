'use strict';
/**
 * tools/probe-tier12-verify.js — READ-ONLY: settle the layouts probe-tier12-layout.js
 * could not pin from a single sample.
 *
 * Four things came back ambiguous on the first pass and are re-measured here with
 * varying arguments, because a value that does not change with its arguments is the
 * signature of a wrong decode:
 *
 *   · cnc_rdopmsg3 — 268 bytes for a 262-byte OPMSG3: where does the header end?
 *   · cnc_statinfo2 — three sub-requests, 11 + 2 + 1 shorts: how do they assemble?
 *   · cnc_rdpm_item — 800 bytes for 10 items: is the stride 78 or 80?
 *   · 0x40[2] — is that really the spindle gear ratio, or a different record?
 *   · pmc_rdpmcrng — does a bit read return the bit or the byte holding it?
 *
 * Every request is a read.
 *
 * Usage: node tools/probe-tier12-verify.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex = b => b && b.length ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : null;
const i16 = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : null;
const u16 = (b, o) => (o + 2 <= b.length) ? b.readUInt16BE(o) : null;
const h   = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

async function req(f, c1, c2, c3, args, label) {
    const st = await f._reqSingle(c1, c2, c3, ...args);
    const err = st.error !== undefined ? st.error : 0;
    console.log(`\n  ${label}  → err=${err} len=${st.len}`);
    if (st.data && st.data.length) console.log(`    ${hex(st.data)}`);
    return st;
}

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}`);

    // ── cnc_rdopmsg3: where does the header end? ─────────────────────────────
    // 268 bytes for a 262-byte OPMSG3 leaves 6 unaccounted. Ask for each message
    // kind separately: if the 6-byte prefix is a count/echo it should change with
    // the argument, and if it is padding it should not.
    h('cnc_rdopmsg3 (0xd0) — locating the 6-byte prefix');
    for (const type_ of [-1, 0, 1, 2, 3, 4]) {
        const st = await req(f, 1, 1, 0xd0, [0, type_, 1], `cnc_rdopmsg3(type=${type_})`);
        if (st.len >= 12) {
            console.log(`    @0 as 3 longs : ${[0, 4, 8].map(o => i32(st.data, o)).join(' ')}`);
            console.log(`    @0 as 6 shorts: ${[0, 2, 4, 6, 8, 10].map(o => i16(st.data, o)).join(' ')}`);
            // The two candidate header sizes: 6 (C struct is 262, wire 268) and 8.
            for (const hdr of [6, 8]) {
                const body = st.data.slice(hdr);
                const nul  = body.indexOf(0);
                const text = (nul >= 0 ? body.slice(0, nul) : body).toString('latin1');
                console.log(`    hdr=${hdr}: datano=${i16(st.data, hdr)} type=${i16(st.data, hdr + 2)}` +
                            ` char_num=${i16(st.data, hdr + 4)} text=${JSON.stringify(text.slice(0, 40))}`);
            }
        }
    }

    // ── cnc_statinfo2: how do 11 + 2 + 1 shorts assemble? ────────────────────
    // ODBST2 is 13 shorts. 11 + 2 = 13, so sub3 (0x98) is probably not part of it.
    // Read the plain cnc_statinfo alongside so the two can be compared field by
    // field: aut/run/motion/mstb/emergency/alarm/edit must agree.
    h('cnc_statinfo2 — assembly against cnc_statinfo');
    const base = await req(f, 1, 1, 0x19, [0], 'cnc_statinfo (0x19) — the 7-short block');
    const baseWords = base.len >= 14 ? [0, 2, 4, 6, 8, 10, 12].map(o => i16(base.data, o)) : [];
    console.log(`    → aut=${baseWords[0]} run=${baseWords[1]} motion=${baseWords[2]}` +
                ` mstb=${baseWords[3]} emergency=${baseWords[4]} alarm=${baseWords[5]} edit=${baseWords[6]}`);

    const s1 = await req(f, 1, 1, 0x0e2, [], 'cnc_statinfo2 sub1 (0xe2)');
    const s2 = await req(f, 1, 1, 0x0e1, [], 'cnc_statinfo2 sub2 (0xe1)');
    const s3 = await req(f, 1, 1, 0x098, [], 'cnc_statinfo2 sub3 (0x98)');
    const w1 = s1.len >= 2 ? Array.from({ length: s1.len / 2 }, (_, i) => i16(s1.data, i * 2)) : [];
    const w2 = s2.len >= 2 ? Array.from({ length: s2.len / 2 }, (_, i) => i16(s2.data, i * 2)) : [];
    const w3 = s3.len >= 2 ? Array.from({ length: s3.len / 2 }, (_, i) => i16(s3.data, i * 2)) : [];
    console.log(`    sub1 (${w1.length} shorts): ${w1.join(' ')}`);
    console.log(`    sub2 (${w2.length} shorts): ${w2.join(' ')}`);
    console.log(`    sub3 (${w3.length} shorts): ${w3.join(' ')}`);
    const joined = w1.concat(w2);
    console.log(`    sub1+sub2 (${joined.length} shorts): ${joined.join(' ')}`);
    if (joined.length === 13) {
        const names = ['hdck', 'tmmode', 'aut', 'run', 'motion', 'mstb', 'emergency',
                       'alarm', 'edit', 'warning', 'o3dchk', 'ext_opt', 'restart'];
        console.log('    as ODBST2:');
        names.forEach((n, i) => console.log(`      ${n.padEnd(10)} = ${joined[i]}`));
        console.log(`    cross-check vs cnc_statinfo: aut ${joined[2]}==${baseWords[0]}` +
                    ` run ${joined[3]}==${baseWords[1]} motion ${joined[4]}==${baseWords[2]}` +
                    ` mstb ${joined[5]}==${baseWords[3]} emergency ${joined[6]}==${baseWords[4]}` +
                    ` alarm ${joined[7]}==${baseWords[5]} edit ${joined[8]}==${baseWords[6]}`);
    }

    // ── cnc_rdpm_item: is the stride 78 or 80? ───────────────────────────────
    // Ask for 1, 2 and 3 items. A stride is confirmed when the reply length is
    // exactly n × stride for every n, and when the second record starts where the
    // first one ends rather than repeating it.
    h('cnc_rdpm_item (0xbe) — stride from varying counts');
    for (const n of [1, 2, 3, 10]) {
        const st = await req(f, 1, 1, 0x0be, [1, n], `cnc_rdpm_item(start=1, num=${n})`);
        if (st.len > 0) {
            console.log(`    len=${st.len}  /1=${st.len}  /78=${(st.len / 78).toFixed(3)}` +
                        `  /80=${(st.len / 80).toFixed(3)}`);
            if (st.len >= 80) {
                const a = st.data.slice(0, 80), b = st.data.slice(80, 160);
                console.log(`    record0 == record1 ? ${a.equals(b)}`);
                console.log(`    record0 name bytes: ${hex(a.slice(0, 64))}`);
            }
        }
    }

    // ── 0x40[2]: is it the gear ratio? ───────────────────────────────────────
    // Compare all three selectors on the same spindle. If 0x40[2] were the gear
    // ratio it should be a small integer (1..4); a large value means the selector
    // is something else, or the record is not a LOADELM.
    h('0x40[0/1/2] — same spindle, three selectors');
    for (const [arg, label] of [[0, 'load'], [1, 'max rpm'], [2, 'gear?']]) {
        const st = await req(f, 1, 1, 0x40, [arg, -1], `0x40[${arg}] — ${label}`);
        if (st.len >= 8) {
            // LOADELM on the wire: value(i32) | unit(i16) | dec(i16) | 4 name bytes.
            const value = i32(st.data, 0), unit = i16(st.data, 4), dec = i16(st.data, 6);
            const name = st.data.slice(8, 12).toString('latin1').split('\0')[0];
            console.log(`    record0: value=${value} unit=${unit} dec=${dec}` +
                        ` → ${value / Math.pow(10, dec)}  name=${JSON.stringify(name)}`);
            // How many records actually differ from the first?
            let distinct = 1;
            for (let o = 8; o + 8 <= st.len; o += 8) {
                if (!st.data.slice(o, o + 8).equals(st.data.slice(0, 8))) distinct++;
            }
            console.log(`    ${st.len / 8} records, ${distinct} distinct`);
        }
    }

    // ── pmc_rdpmcrng: bit vs byte ────────────────────────────────────────────
    // A bit read must return the BYTE holding the bit (the caller masks), or the
    // bit itself. Read R0 as a bit and R0..R3 as bytes back to back: if the bit
    // read returns 0x14 and the byte read returns 0x14 for R0, it is the byte.
    h('pmc_rdpmcrng — bit read vs byte read on the same address');
    for (const [adr, dtype, s, e, label] of [
        [5, 1, 0, 0, 'R0.0 as bit'],
        [5, 1, 0, 7, 'R0.0..R0.7 as bits'],
        [5, 0, 0, 0, 'R0 as byte'],
        [5, 0, 0, 3, 'R0..R3 as bytes'],
        [9, 2, 100, 103, 'D100..D101 as words'],
        [9, 4, 100, 106, 'D100..D101 as dwords'],
        [9, 0, 100, 103, 'D100..D103 as bytes'],
    ]) {
        const st = await req(f, 2, 1, 0x8001, [s, e, adr, dtype, 0],
                             `pmc_rdpmcrng(${label}: adr=${adr} dtype=${dtype} ${s}..${e})`);
        if (st.len > 0) {
            console.log(`    ${st.len} bytes: ${[...st.data].join(' ')}`);
            if (dtype === 2 && st.len >= 4) {
                console.log(`    as words: ${Array.from({ length: st.len / 2 }, (_, i) => u16(st.data, i * 2)).join(' ')}`);
            }
            if (dtype === 4 && st.len >= 4) {
                console.log(`    as dwords: ${Array.from({ length: Math.floor(st.len / 4) }, (_, i) => st.data.readUInt32BE(i * 4)).join(' ')}`);
            }
        }
    }

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
