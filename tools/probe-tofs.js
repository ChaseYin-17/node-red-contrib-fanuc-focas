'use strict';
/**
 * tools/probe-tofs.js — READ-ONLY: verify the captured tool-offset opcodes.
 *
 * tools/probe-dll-tofs.py captured the vendor library's own traffic and showed the
 * real codes are 0x08 (cnc_rdtofs / cnc_rdtofsr), 0x0a (cnc_rdtofsinfo), 0x0b
 * (cnc_rdzofs) and 0x0d (cnc_rdzofsinfo) — not the 0x2c/0x2d/0x2e/0x2a/0x2b that look
 * adjacent to the other Ncdata reads. This puts those codes on the wire directly and
 * decodes them, so the capture is confirmed against the controller rather than trusted.
 *
 * READ-ONLY: no write call appears in this file.
 *
 * Usage: node tools/probe-tofs.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.233.166';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex = b => b ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : '-';
const i16 = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : '-';
const h = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

// Every one of these calls answers a plain run of 8-byte records —
// value(i32) | dec(i16) | unit(i16) — with no header, not the C struct.
const recs = d => Array.from({ length: Math.floor(d.length / 8) }, (_, i) => {
    const raw = i32(d, i * 8), dec = i16(d, i * 8 + 6), unit = i16(d, i * 8 + 4);
    return { raw, dec, unit, value: raw / Math.pow(10, dec) };
});

const ERR = {
    '-17':'EW_PROTOCOL','-16':'EW_SOCKET','-15':'EW_NODLL','-11':'EW_BUS','-10':'EW_SYSTEM2',
    '-9':'EW_HSSB','-8':'EW_HANDLE','-7':'EW_VERSION','-6':'EW_UNEXP','-5':'EW_SYSTEM',
    '-4':'EW_PARITY','-3':'EW_MMCSYS','-2':'EW_RESET','-1':'EW_BUSY','0':'EW_OK',
    '1':'EW_FUNC','2':'EW_LENGTH','3':'EW_NUMBER','4':'EW_ATTRIB','5':'EW_DATA',
    '6':'EW_NOOPT','7':'EW_PROT','8':'EW_OVRFLW','9':'EW_PARAM','10':'EW_BUFFER',
    '11':'EW_PATH','12':'EW_MODE','13':'EW_REJECT','14':'EW_DTSRVR','15':'EW_ALARM',
    '16':'EW_STOP','17':'EW_PASSWD',
};

async function req(f, c3, args, label) {
    const st = await f._reqSingle(1, 1, c3, ...args);
    const err = st.error !== undefined ? st.error : 0;
    console.log(`  ${label.padEnd(38)} func=0x${c3.toString(16).padStart(4,'0')}` +
                ` args=[${args.join(',')}]  ${ERR[String(err)] || 'EW_UNKNOWN'} (${err})  len=${st.len}`);
    if (st.data && st.data.length) console.log(`      ${hex(st.data)}`);
    return st;
}

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}` +
                ` mt_type=${JSON.stringify(f.sysinfo.mttype)}`);

    // ── cnc_rdtofsinfo (0x0a) ────────────────────────────────────────────────
    h('cnc_rdtofsinfo (0x0a) — ofs_type(i32) | a second word that is not a small count');
    const info = await req(f, 0x0a, [], 'cnc_rdtofsinfo');
    if (info && info.data && info.data.length >= 8)
        console.log(`      → ofs_type=${i32(info.data,0)}  use_no=${i32(info.data,4)}`);

    // ── cnc_rdtofs (0x08, single) ────────────────────────────────────────────
    h('cnc_rdtofs (0x08) — one 8-byte record: value(i32) | dec(i16) | unit(i16)');
    for (const [num, type] of [[1,0],[1,1],[1,2],[1,3],[2,0],[2,2],[3,2],[10,2]]) {
        const st = await req(f, 0x08, [num, type, 1000 + type], `rdtofs(number=${num}, type=${type})`);
        if (st && st.data && st.data.length >= 12)
            console.log(`      → ${JSON.stringify(recs(st.data))}`);
    }

    // ── cnc_rdtofsr (0x08, range) ────────────────────────────────────────────
    h('cnc_rdtofsr (0x08) — a plain run of 8-byte records, no header');
    for (const [s, e, type] of [[1,1,2],[1,3,2],[1,5,2],[1,5,3],[1,5,0]]) {
        const st = await req(f, 0x08, [s, e, type], `rdtofsr(s=${s}, e=${e}, type=${type})`);
        if (st && st.data && st.data.length >= 8)
            console.log(`      → ${JSON.stringify(recs(st.data))}`);
    }

    // ── cnc_rdzofsinfo (0x0d) / cnc_rdzofs (0x0b) ────────────────────────────
    h('cnc_rdzofsinfo (0x0d) / cnc_rdzofs (0x0b)');
    const zi = await req(f, 0x0d, [], 'cnc_rdzofsinfo');
    if (zi && zi.data && zi.data.length >= 4)
        console.log(`      → ofs_type=${i32(zi.data,0)}`);
    // The argument packing for cnc_rdzofs is NOT settled: the vendor library got EW_OK
    // with axis=1 on this machine, but (number, axis, length) is answered EW_ATTRIB.
    // Left as a probe rather than a decoder until the request bytes are captured.
    for (const [num, axis] of [[1,1],[1,2],[1,3],[2,1]]) {
        const st = await req(f, 0x0b, [num, axis, 8], `rdzofs(number=${num}, axis=${axis})`);
        if (st && st.data && st.data.length >= 8)
            console.log(`      → ${JSON.stringify(recs(st.data))}`);
    }

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
