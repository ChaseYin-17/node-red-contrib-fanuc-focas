'use strict';
/**
 * tools/probe-pmc-byteorder.js — READ-ONLY: pin the byte order of pmc_rdpmcrng.
 *
 * The first pass used the wrong data_type enum. FwSymbol.h defines
 *
 *     #define PMC_BYTE  0
 *     #define PMC_WORD  1
 *     #define PMC_LONG  2
 *
 * so `dtype=2` is LONG (4 bytes per element), not word. Every "word" reading in the
 * earlier run was actually a long reading, and the single-word request
 * (100..101 with dtype=2) asked for 2 bytes where a long needs 4 — which is why it
 * answered the nonsense 0x0202.
 *
 * s_number and e_number are BYTE addresses at every width. The element count is
 * (e - s + 1) / width, and the reply is that many elements. Reading the same byte
 * range at all three widths therefore always returns the same number of bytes, and
 * the three can be compared directly.
 *
 * Nothing here writes to the PMC.
 *
 * Usage: node tools/probe-pmc-byteorder.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

const PMC_BYTE = 0, PMC_WORD = 1, PMC_LONG = 2;
const WIDTH = { [PMC_BYTE]: 1, [PMC_WORD]: 2, [PMC_LONG]: 4 };
const WNAME = { [PMC_BYTE]: 'byte', [PMC_WORD]: 'word', [PMC_LONG]: 'long' };

const hex = b => b && b.length ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const h   = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

async function pmc(f, adr, dtype, s, e, label) {
    const st = await f._reqSingle(2, 1, 0x8001, s, e, adr, dtype, 0);
    const err = st.error !== undefined ? st.error : 0;
    const bytes = st.data && st.data.length ? [...st.data] : [];
    const expect = Math.floor((e - s + 1) / WIDTH[dtype]);
    console.log(`  ${label.padEnd(30)} dtype=${dtype}(${WNAME[dtype]}) ${s}..${e}` +
                `  err=${err}  len=${st.len} (expect ${expect})  ` +
                bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));
    return st;
}

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}`);

    // ── The same 8 bytes at all three widths ─────────────────────────────────
    h('D100..D107 — 8 bytes read as byte / word / long');
    const b = await pmc(f, 9, PMC_BYTE, 100, 107, 'D100..D107');
    const w = await pmc(f, 9, PMC_WORD, 100, 107, 'D100..D107');
    const l = await pmc(f, 9, PMC_LONG, 100, 107, 'D100..D107');

    if (b.len === 8 && w.len === 8 && l.len === 8) {
        const bytes = [...b.data];
        const wordsBE = [0, 2, 4, 6].map(o => w.data.readUInt16BE(o));
        const wordsLE = [0, 2, 4, 6].map(o => w.data.readUInt16LE(o));
        const longsBE = [0, 4].map(o => l.data.readUInt32BE(o));
        const longsLE = [0, 4].map(o => l.data.readUInt32LE(o));

        console.log(`\n  byte read : ${hex(b.data)}`);
        console.log(`  word read : ${hex(w.data)}   BE=${wordsBE.map(v => '0x' + v.toString(16).padStart(4,'0')).join(' ')}` +
                    `  LE=${wordsLE.map(v => '0x' + v.toString(16).padStart(4,'0')).join(' ')}`);
        console.log(`  long read : ${hex(l.data)}   BE=${longsBE.map(v => '0x' + v.toString(16).padStart(8,'0')).join(' ')}` +
                    `  LE=${longsLE.map(v => '0x' + v.toString(16).padStart(8,'0')).join(' ')}`);

        // Rebuild the byte stream from each width under each endianness and see
        // which one reproduces the byte read. That is the only comparison that
        // does not assume an answer.
        const cands = {
            'word BE': Buffer.from(wordsBE.flatMap(v => [v >> 8, v & 0xff])),
            'word LE': Buffer.from(wordsLE.flatMap(v => [v & 0xff, v >> 8])),
            'long BE': Buffer.from(longsBE.flatMap(v => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])),
            'long LE': Buffer.from(longsLE.flatMap(v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])),
        };
        console.log('\n  rebuilt from each width, compared against the byte read:');
        for (const [name, buf] of Object.entries(cands)) {
            console.log(`    ${name.padEnd(8)}: ${hex(buf)}  ${buf.equals(b.data) ? 'MATCH' : 'differs'}`);
        }

        // And the reverse direction: rebuild the byte read from the word read by
        // reversing each 4-byte group, which is what the earlier run suggested.
        const per4 = [];
        for (let i = 0; i < bytes.length; i += 4) per4.push(...bytes.slice(i, i + 4).reverse());
        console.log(`\n  byte read, each 4-byte group reversed: ${hex(Buffer.from(per4))}` +
                    `  ${Buffer.from(per4).equals(w.data) ? '== word read' : ''}`);
        const per2 = [];
        for (let i = 0; i < bytes.length; i += 2) per2.push(...bytes.slice(i, i + 2).reverse());
        console.log(`  byte read, each 2-byte group reversed: ${hex(Buffer.from(per2))}` +
                    `  ${Buffer.from(per2).equals(w.data) ? '== word read' : ''}`);
    }

    // ── One word vs the two bytes it covers ──────────────────────────────────
    // D100 is one word = byte addresses 100 and 101. Read the word with the CORRECT
    // dtype this time, then each byte separately.
    h('D100 as one word vs D100/D101 as single bytes');
    const w100 = await pmc(f, 9, PMC_WORD, 100, 101, 'D100 as 1 word');
    const b100 = await pmc(f, 9, PMC_BYTE, 100, 100, 'D100 as 1 byte');
    const b101 = await pmc(f, 9, PMC_BYTE, 101, 101, 'D101 as 1 byte');
    if (w100.len === 2 && b100.len === 1 && b101.len === 1) {
        const word = w100.data.readUInt16BE(0);
        const hi = word >> 8, lo = word & 0xff;
        console.log(`\n  D100 word = 0x${word.toString(16).padStart(4, '0')}` +
                    `  (hi=0x${hi.toString(16).padStart(2, '0')} lo=0x${lo.toString(16).padStart(2, '0')})`);
        console.log(`  D100 byte = 0x${b100.data[0].toString(16).padStart(2, '0')}`);
        console.log(`  D101 byte = 0x${b101.data[0].toString(16).padStart(2, '0')}`);
        if (b100.data[0] === hi && b101.data[0] === lo)
            console.log('  → byte path is BIG-endian: D100 holds the high half of the word');
        else if (b100.data[0] === lo && b101.data[0] === hi)
            console.log('  → byte path is LITTLE-endian: D100 holds the low half of the word');
        else
            console.log('  → neither; the two paths are not reading the same memory');
    }

    // ── A second area, to rule out a D-table quirk ───────────────────────────
    h('K0..K7 — a second area, same question');
    const kb = await pmc(f, 7, PMC_BYTE, 0, 7, 'K0..K7');
    const kw = await pmc(f, 7, PMC_WORD, 0, 7, 'K0..K7');
    if (kb.len === 8 && kw.len === 8) {
        const bytes = [...kb.data];
        const per4 = [];
        for (let i = 0; i < 8; i += 4) per4.push(...bytes.slice(i, i + 4).reverse());
        const per2 = [];
        for (let i = 0; i < 8; i += 2) per2.push(...bytes.slice(i, i + 2).reverse());
        console.log(`\n  byte read, each 4-byte group reversed: ${hex(Buffer.from(per4))}` +
                    `  ${Buffer.from(per4).equals(kw.data) ? '== word read' : ''}`);
        console.log(`  byte read, each 2-byte group reversed: ${hex(Buffer.from(per2))}` +
                    `  ${Buffer.from(per2).equals(kw.data) ? '== word read' : ''}`);
    }

    // ── Bit read: one byte per bit, or one byte holding eight? ───────────────
    h('R0..R7 — 8 bits vs 1 byte');
    const bits = await pmc(f, 5, PMC_BYTE, 0, 7, 'R0.0..R0.7 as 8 bits');
    const byte = await pmc(f, 5, PMC_BYTE, 0, 0, 'R0 as 1 byte');
    if (bits.len > 0 && byte.len > 0) {
        console.log(`\n  bit read  : ${[...bits.data].join(' ')}  (${bits.len} bytes for 8 bits)`);
        console.log(`  byte read : ${[...byte.data].join(' ')}  (${byte.len} bytes for 1 byte)`);
        console.log(`  → ${bits.len === 8 ? 'one byte per bit (caller masks)' :
                               bits.len === 1 ? 'one byte holding all 8 bits (caller shifts)' : 'neither'}`);
    }

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
