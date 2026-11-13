'use strict';
/**
 * tools/probe-pmc-order.js — READ-ONLY: settle the byte/word/dword ordering of
 * pmc_rdpmcrng, which the first pass left contradictory.
 *
 * Measured on 10.192.232.189 (31i, 2026-11-13):
 *
 *   D100..D103 as words  → 14 03 05 22   → [0x1403, 0x0522] = [5123, 1314]
 *   D100..D103 as bytes  → 22 05 03 14   → [0x22, 0x05, 0x03, 0x14]
 *
 * The byte reply is the exact byte-reverse of the word reply, so one of the two
 * reverses the block. Reading the same range at three widths and comparing the
 * reconstructed bytes says which. Nothing here writes to the PMC.
 *
 * Usage: node tools/probe-pmc-order.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex = b => b && b.length ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const h   = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

async function pmc(f, adr, dtype, s, e, label) {
    const st = await f._reqSingle(2, 1, 0x8001, s, e, adr, dtype, 0);
    const err = st.error !== undefined ? st.error : 0;
    console.log(`\n  ${label}`);
    console.log(`    args=[${s},${e},${adr},${dtype},0]  err=${err} len=${st.len}`);
    if (st.data && st.data.length) console.log(`    ${hex(st.data)}`);
    return st;
}

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}`);

    // Machine state first: this probe is read-only, but knowing whether the
    // controller is cutting makes the numbers below interpretable.
    const st = await f.statinfo();
    console.log(`state: aut=${st.aut} run=${st.run} motion=${st.motion}`);

    // ── D100..D107 at three widths ───────────────────────────────────────────
    // 8 bytes of PMC, read as 8 bytes / 4 words / 2 dwords. If the three agree
    // after reconstruction, the wire is plain big-endian and the earlier
    // contradiction was a mis-sliced request (the dword read asked for 100..106,
    // which is 7 bytes — not a whole number of dwords).
    h('D100..D107 — bytes vs words vs dwords');
    const b = await pmc(f, 9, 0, 100, 107, 'D100..D107 as 8 bytes');
    const w = await pmc(f, 9, 2, 100, 107, 'D100..D107 as 4 words');
    const d = await pmc(f, 9, 4, 100, 107, 'D100..D107 as 2 dwords');

    if (b.len === 8 && w.len === 8 && d.len === 8) {
        const bytes = [...b.data];
        const wordsBE = [0, 2, 4, 6].map(o => w.data.readUInt16BE(o));
        const wordsLE = [0, 2, 4, 6].map(o => w.data.readUInt16LE(o));
        const dwordsBE = [0, 4].map(o => d.data.readUInt32BE(o));
        const dwordsLE = [0, 4].map(o => d.data.readUInt32LE(o));

        console.log(`\n  bytes    : ${bytes.join(' ')}`);
        console.log(`  words BE : ${wordsBE.map(v => '0x' + v.toString(16).padStart(4, '0')).join(' ')}`);
        console.log(`  words LE : ${wordsLE.map(v => '0x' + v.toString(16).padStart(4, '0')).join(' ')}`);
        console.log(`  dwords BE: ${dwordsBE.map(v => '0x' + v.toString(16).padStart(8, '0')).join(' ')}`);
        console.log(`  dwords LE: ${dwordsLE.map(v => '0x' + v.toString(16).padStart(8, '0')).join(' ')}`);

        // Reconstruct the byte stream from each width and compare against the
        // byte read. The width whose reconstruction matches is the one whose
        // ordering is consistent with the byte view.
        const fromWordsBE = Buffer.from(wordsBE.flatMap(v => [v >> 8, v & 0xff]));
        const fromWordsLE = Buffer.from(wordsLE.flatMap(v => [v & 0xff, v >> 8]));
        const fromDwordsBE = Buffer.from(dwordsBE.flatMap(v => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]));
        const fromDwordsLE = Buffer.from(dwordsLE.flatMap(v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));

        console.log(`\n  byte read            : ${hex(b.data)}`);
        console.log(`  words BE rebuilt     : ${hex(fromWordsBE)}  ${fromWordsBE.equals(b.data) ? 'MATCH' : 'differs'}`);
        console.log(`  words LE rebuilt     : ${hex(fromWordsLE)}  ${fromWordsLE.equals(b.data) ? 'MATCH' : 'differs'}`);
        console.log(`  dwords BE rebuilt    : ${hex(fromDwordsBE)}  ${fromDwordsBE.equals(b.data) ? 'MATCH' : 'differs'}`);
        console.log(`  dwords LE rebuilt    : ${hex(fromDwordsLE)}  ${fromDwordsLE.equals(b.data) ? 'MATCH' : 'differs'}`);
        console.log(`  byte read reversed   : ${hex(Buffer.from([...b.data].reverse()))}` +
                    `  ${Buffer.from([...b.data].reverse()).equals(w.data) ? '== word read' : ''}`);
    }

    // ── A wider range, to see whether any reversal is per-record or whole-block ──
    h('D100..D115 — 16 bytes, to tell per-record from whole-block reversal');
    const b16 = await pmc(f, 9, 0, 100, 115, 'D100..D115 as 16 bytes');
    const w16 = await pmc(f, 9, 2, 100, 115, 'D100..D115 as 8 words');
    if (b16.len === 16 && w16.len === 16) {
        const bytes = [...b16.data];
        const wordsBE = Array.from({ length: 8 }, (_, i) => w16.data.readUInt16BE(i * 2));
        const wordsLE = Array.from({ length: 8 }, (_, i) => w16.data.readUInt16LE(i * 2));
        console.log(`\n  bytes    : ${bytes.join(' ')}`);
        console.log(`  words BE : ${wordsBE.map(v => '0x' + v.toString(16).padStart(4, '0')).join(' ')}`);
        console.log(`  words LE : ${wordsLE.map(v => '0x' + v.toString(16).padStart(4, '0')).join(' ')}`);
        const fromBE = Buffer.from(wordsBE.flatMap(v => [v >> 8, v & 0xff]));
        const fromLE = Buffer.from(wordsLE.flatMap(v => [v & 0xff, v >> 8]));
        console.log(`  BE rebuilt: ${hex(fromBE)}  ${fromBE.equals(b16.data) ? 'MATCH' : 'differs'}`);
        console.log(`  LE rebuilt: ${hex(fromLE)}  ${fromLE.equals(b16.data) ? 'MATCH' : 'differs'}`);
        console.log(`  bytes reversed: ${hex(Buffer.from(bytes.reverse()))}`);
    }

    // ── Bit read: does it return the bit or the byte holding it? ─────────────
    // R0..R7 read as 8 bits and as 1 byte. If the bit read returns one byte per
    // bit, the caller masks; if it returns the byte, the caller shifts.
    h('R0..R7 — 8 bits vs 1 byte');
    const bits = await pmc(f, 5, 1, 0, 7, 'R0.0..R0.7 as 8 bits');
    const byte = await pmc(f, 5, 0, 0, 0, 'R0 as 1 byte');
    if (bits.len > 0 && byte.len > 0) {
        console.log(`\n  bit read  : ${[...bits.data].join(' ')}  (${bits.len} bytes for 8 bits)`);
        console.log(`  byte read : ${[...byte.data].join(' ')}  (${byte.len} bytes for 1 byte)`);
        console.log(`  → ${bits.len === 8 ? 'one byte per bit' : bits.len === 1 ? 'one byte holding all 8 bits' : 'neither'}`);
    }

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
