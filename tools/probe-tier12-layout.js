'use strict';
/**
 * tools/probe-tier12-layout.js — READ-ONLY: pin the response layout of the tier-1/2 reads.
 *
 * tools/probe-funcsupport.js answers "does this controller accept the request". This
 * answers the next question: "what do the bytes mean". It sends the same requests and
 * hexdumps the replies, then decodes each one against the layout the SDK documents, so
 * a decode that disagrees with the raw bytes is visible instead of being trusted.
 *
 * Every request here is a read. Nothing writes, resets, clears or changes mode.
 *
 * cnc_rdexecprog is NOT included: its spec page says the execution pointer moves to the
 * next block under single-block operation, and that has not been disproved. Run
 * `node tools/probe-funcsupport.js <ip> --include-execprog` on an idle machine if you
 * need its opcode; do not point either tool at a controller that is cutting.
 *
 * Usage: node tools/probe-tier12-layout.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

const ERR = {
    '-17':'EW_PROTOCOL','-16':'EW_SOCKET','-15':'EW_NODLL','-11':'EW_BUS','-10':'EW_SYSTEM2',
    '-9':'EW_HSSB','-8':'EW_HANDLE','-7':'EW_VERSION','-6':'EW_UNEXP','-5':'EW_SYSTEM',
    '-4':'EW_PARITY','-3':'EW_MMCSYS','-2':'EW_RESET','-1':'EW_BUSY','0':'EW_OK',
    '1':'EW_FUNC','2':'EW_LENGTH','3':'EW_NUMBER','4':'EW_ATTRIB','5':'EW_DATA',
    '6':'EW_NOOPT','7':'EW_PROT','8':'EW_OVRFLW','9':'EW_PARAM','10':'EW_BUFFER',
    '11':'EW_PATH','12':'EW_MODE','13':'EW_REJECT','14':'EW_DTSRVR','15':'EW_ALARM',
    '16':'EW_STOP','17':'EW_PASSWD',
};

const hex  = b => b && b.length ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const i32  = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : null;
const i16  = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : null;
const u16  = (b, o) => (o + 2 <= b.length) ? b.readUInt16BE(o) : null;
const u32  = (b, o) => (o + 4 <= b.length) ? b.readUInt32BE(o) : null;
const h    = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

async function req(f, c1, c2, c3, args, label) {
    const st = await f._reqSingle(c1, c2, c3, ...args);
    const err = st.error !== undefined ? st.error : 0;
    console.log(`\n  ${label}`);
    console.log(`    func=0x${c3.toString(16).padStart(4, '0')} c1=${c1} c2=${c2}` +
                ` args=[${args.join(',')}]  ${ERR[String(err)] || 'EW_UNKNOWN'} (${err})  len=${st.len}`);
    if (st.data && st.data.length) console.log(`    ${hex(st.data)}`);
    return st;
}

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}` +
                ` mt_type=${JSON.stringify(f.sysinfo.mttype)} series=${JSON.stringify(f.sysinfo.series)}` +
                ` maxaxis=${f.sysinfo.maxaxis} axes=${JSON.stringify(f.sysinfo.axes)}`);

    // ── cnc_rdcncid (0x0e8) ──────────────────────────────────────────────────
    // ODB: unsigned long cncid[4]. The wire is 16 bytes = 4 longs, so the C struct
    // and the wire agree here — unlike almost everything else in this project.
    h('cnc_rdcncid (0x0e8) — 4 × unsigned long');
    let st = await req(f, 1, 1, 0x0e8, [], 'cnc_rdcncid');
    if (st.len === 16) {
        const id = [0, 1, 2, 3].map(i => u32(st.data, i * 4));
        console.log(`    → cncid = ${id.map(v => '0x' + v.toString(16).padStart(8, '0')).join(' ')}`);
        console.log(`    → decimal = ${id.join(' ')}`);
    }

    // ── cnc_rdzofsinfo (0x0d) ────────────────────────────────────────────────
    // Spec: short *use_no. The wire is 4 bytes, which is NOT sizeof(short) — the same
    // widening cnc_rdtofsinfo shows (it answers 8 bytes for two shorts).
    h('cnc_rdzofsinfo (0x0d) — short *use_no, widened on the wire');
    st = await req(f, 1, 1, 0x0d, [], 'cnc_rdzofsinfo');
    if (st.len >= 2) {
        console.log(`    → as short @0 = ${i16(st.data, 0)}`);
        if (st.len >= 4) console.log(`    → as long  @0 = ${i32(st.data, 0)}`);
    }

    // ── cnc_rdzofs (0x0b) ────────────────────────────────────────────────────
    // Wire args are (number, number, axis). IODBZOFS is
    //   short datano | short type | short dummy[2] | REALDATA data[MAX_AXIS]
    // and REALDATA is double val | long dec | long dummy = 16 bytes. The reply is
    // 8 bytes, so the wire is the same value(i32)|dec(i16)|unit(i16) record the tool
    // offsets use — NOT the C struct.
    h('cnc_rdzofs (0x0b) — args (number, number, axis)');
    for (const [num, axis] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2]]) {
        st = await req(f, 1, 1, 0x0b, [num, num, axis], `cnc_rdzofs(number=${num}, axis=${axis})`);
        if (st.len >= 8) {
            const raw = i32(st.data, 0), dec = i16(st.data, 6), unit = i16(st.data, 4);
            console.log(`      → raw=${raw} dec=${dec} unit=${unit} value=${raw / Math.pow(10, dec)}`);
        }
    }

    // ── cnc_rdseqnum (0x1d) ──────────────────────────────────────────────────
    // ODBSEQ is short dummy[2] | long data = 8 bytes. The wire answers 4, so the
    // dummy is dropped and only `data` is sent — the same treatment ODBALM gets.
    h('cnc_rdseqnum (0x1d) — ODBSEQ short dummy[2] | long data, wire drops the dummy');
    st = await req(f, 1, 1, 0x1d, [], 'cnc_rdseqnum');
    if (st.len >= 4) console.log(`    → sequence number = ${i32(st.data, 0)}`);

    // ── cnc_rdcommand (0x97) ─────────────────────────────────────────────────
    // ODBCMD is char adrs | char num | short flag | long cmd_val | long dec_val = 12
    // bytes. type -1 = all modal, -2 = all commanded, block 1 = active block.
    h('cnc_rdcommand (0x97) — ODBCMD char adrs | char num | short flag | long cmd_val | long dec_val');
    for (const [type_, block, label] of [[-1, 1, 'all modal'], [-2, 1, 'all commanded']]) {
        st = await req(f, 1, 1, 0x97, [type_, block], `cnc_rdcommand(type=${type_}, block=${block}) — ${label}`);
        if (st.len > 0 && st.len % 12 === 0) {
            const n = st.len / 12;
            console.log(`    → ${n} records of 12 bytes:`);
            for (let i = 0; i < n; i++) {
                const o = i * 12;
                const adrs = String.fromCharCode(st.data[o]);
                const num  = st.data[o + 1];
                const flag = u16(st.data, o + 2);
                const val  = i32(st.data, o + 4);
                const dec  = i32(st.data, o + 8);
                const shown = dec >= 0 && dec <= 9 ? val / Math.pow(10, dec) : val;
                console.log(`      [${String(i).padStart(2)}] adrs=${JSON.stringify(adrs)} num=${String(num).padStart(3)}` +
                            ` flag=0x${flag.toString(16).padStart(4, '0')} val=${String(val).padStart(10)}` +
                            ` dec=${String(dec).padStart(2)} → ${shown}`);
            }
        } else if (st.len > 0) {
            console.log(`    !! ${st.len} bytes is not a whole number of 12-byte ODBCMD records`);
        }
    }

    // ── cnc_rdopmsg3 (0xd0) ──────────────────────────────────────────────────
    // OPMSG3 is short datano | short type | short char_num | char data[256] = 262.
    // The wire answers 268, so there are 6 bytes of something before the 262.
    h('cnc_rdopmsg3 (0xd0) — OPMSG3 short datano | short type | short char_num | char data[256]');
    st = await req(f, 1, 1, 0xd0, [0, -1, 1], 'cnc_rdopmsg3(type=-1)');
    if (st.len >= 6) {
        console.log(`    → @0 datano=${i16(st.data, 0)}  @2 type=${i16(st.data, 2)}  @4 char_num=${i16(st.data, 4)}`);
        if (st.len > 6) {
            const body = st.data.slice(6);
            const nul  = body.indexOf(0);
            const text = (nul >= 0 ? body.slice(0, nul) : body).toString('latin1');
            console.log(`    → text (from +6) = ${JSON.stringify(text)}`);
        }
        if (st.len >= 268) {
            console.log(`    → 268 bytes = 6 header + 262 OPMSG3, i.e. the C struct IS the wire here`);
        }
    }

    // ── cnc_statinfo2 (0xe2 + 0xe1 + 0x98) ───────────────────────────────────
    // A COMPOSITE call: the library puts three sub-requests in one frame. Sent here
    // one at a time so each block's size is visible on its own.
    h('cnc_statinfo2 — three sub-requests (0xe2, 0xe1, 0x98)');
    for (const [c3, label] of [[0x0e2, 'sub1'], [0x0e1, 'sub2'], [0x098, 'sub3']]) {
        st = await req(f, 1, 1, c3, [], `cnc_statinfo2 ${label} (0x${c3.toString(16)})`);
        if (st.len >= 2 && st.len % 2 === 0) {
            const words = [];
            for (let o = 0; o + 2 <= st.len; o += 2) words.push(i16(st.data, o));
            console.log(`    → ${words.length} shorts: ${words.join(' ')}`);
        }
    }

    // ── cnc_rdproginfo (0x07) ────────────────────────────────────────────────
    // ODBNC is a union of {bin: short reg_prg | short unreg_prg | long used_mem |
    // long unused_mem = 12} and {asc[31]}. The wire answers 16, so there is a 4-byte
    // prefix before the 12-byte bin — the same leading-long pattern cnc_rdtlinfo has.
    h('cnc_rdproginfo (0x07) — ODBNC union, wire answers 16 bytes');
    st = await req(f, 1, 1, 0x07, [], 'cnc_rdproginfo');
    if (st.len >= 16) {
        console.log(`    → @0  as long  = ${i32(st.data, 0)}`);
        console.log(`    → @4  reg_prg=${i16(st.data, 4)} unreg_prg=${i16(st.data, 6)}` +
                    ` used_mem=${i32(st.data, 8)} unused_mem=${i32(st.data, 12)}`);
        console.log(`    → @0  as 4 shorts = ${[0, 2, 4, 6].map(o => i16(st.data, o)).join(' ')}`);
    }

    // ── cnc_rdpm_item (0xbe) ─────────────────────────────────────────────────
    // IODBPMAINTE is char name[62] | long type | long total | long remain | long stat
    // = 78 bytes. The wire answers 800 for 10 items = 80 bytes each, so the wire pads
    // name to 64 — the same widening the tool-life records show.
    h('cnc_rdpm_item (0xbe) — IODBPMAINTE char name[62] | long type | long total | long remain | long stat');
    st = await req(f, 1, 1, 0xbe, [1, 10], 'cnc_rdpm_item(start=1, num=10)');
    if (st.len > 0) {
        for (const stride of [78, 80]) {
            if (st.len % stride !== 0) continue;
            const n = st.len / stride;
            console.log(`    → ${st.len} bytes = ${n} × ${stride}`);
            for (let i = 0; i < Math.min(n, 10); i++) {
                const o = i * stride;
                const nameBytes = st.data.slice(o, o + 62);
                const nul = nameBytes.indexOf(0);
                const name = (nul >= 0 ? nameBytes.slice(0, nul) : nameBytes).toString('latin1');
                console.log(`      [${i + 1}] name=${JSON.stringify(name)}` +
                            ` type=${i32(st.data, o + 62)} total=${i32(st.data, o + 66)}` +
                            ` remain=${i32(st.data, o + 70)} stat=${i32(st.data, o + 74)}`);
            }
        }
    }

    // ── cnc_rdspgear / cnc_rdspload / cnc_rdspmaxrpm (all 0x40) ──────────────
    // ODBSPN is short datano | short type | short data[MAX_SPINDLE]. The wire answers
    // 64 bytes, which is not 4 + 2*MAX_SPINDLE for any of the documented maxima — so
    // the wire widens each entry to a long, the way every other record here does.
    h('cnc_rdspgear / cnc_rdspload / cnc_rdspmaxrpm — all 0x40, selected by arg 0');
    for (const [arg, label] of [[2, 'gear ratio'], [0, 'load'], [1, 'max rpm']]) {
        st = await req(f, 1, 1, 0x40, [arg, -1], `0x40[${arg}] — ${label}`);
        if (st.len >= 8) {
            console.log(`    → @0 datano=${i16(st.data, 0)} @2 type=${i16(st.data, 2)}`);
            const asShorts = [];
            for (let o = 4; o + 2 <= st.len; o += 2) asShorts.push(i16(st.data, o));
            console.log(`    → shorts from +4: ${asShorts.join(' ')}`);
            const asLongs = [];
            for (let o = 4; o + 4 <= st.len; o += 4) asLongs.push(i32(st.data, o));
            console.log(`    → longs  from +4: ${asLongs.join(' ')}`);
        }
    }

    // ── cnc_rdblkcount (0x35) ────────────────────────────────────────────────
    h('cnc_rdblkcount (0x35) — long *prog_bc');
    st = await req(f, 1, 1, 0x35, [], 'cnc_rdblkcount');
    if (st.len >= 4) console.log(`    → block counter = ${i32(st.data, 0)}`);

    // ── cnc_gettimer (0x45) ──────────────────────────────────────────────────
    // IODBTIMER is short type | short dummy | union { date{year,month,date} |
    // time{hour,minute,second} } = 10 bytes. The wire answers 12, so the union is
    // widened to three longs — the same treatment ODBUSEGR gets.
    h('cnc_gettimer (0x45) — IODBTIMER short type | short dummy | union{3 shorts}');
    for (const [type_, label] of [[0, 'date'], [1, 'time']]) {
        st = await req(f, 1, 1, 0x45, [type_], `cnc_gettimer(type=${type_}) — ${label}`);
        if (st.len >= 12) {
            console.log(`    → as 6 shorts: ${[0, 2, 4, 6, 8, 10].map(o => i16(st.data, o)).join(' ')}`);
            console.log(`    → as 3 longs : ${[0, 4, 8].map(o => i32(st.data, o)).join(' ')}`);
        }
    }

    // ── pmc_rdpmcrng (0x8001, c1/c2 = 2/1) ───────────────────────────────────
    // IODBPMC is short type_a | short type_d | ushort datano_s | ushort datano_e |
    // union { char cdata[5] | short idata[5] | long ldata[5] } = 28 bytes.
    // Wire args are (s_number, e_number, adr_type, data_type, 0) — length never goes
    // on the wire, the library computes it from the address range and the data type.
    h('pmc_rdpmcrng (0x8001, c1=2 c2=1) — args (s, e, adr_type, data_type, 0)');
    for (const [adr, dtype, s, e, label] of [
        [9, 2, 100, 103, 'D100 word ×2'],
        [9, 0, 100, 100, 'D100 byte'],
        [9, 4, 100, 106, 'D100 dword ×2'],
        [5, 1, 0,   0,   'R0 bit'],
        [5, 0, 0,   3,   'R0..R3 byte'],
        [0, 1, 0,   0,   'G0 bit'],
        [1, 1, 0,   0,   'F0 bit'],
        [2, 1, 0,   0,   'Y0 bit'],
        [3, 1, 0,   0,   'X0 bit'],
    ]) {
        st = await req(f, 2, 1, 0x8001, [s, e, adr, dtype, 0],
                       `pmc_rdpmcrng(${label}: adr=${adr} dtype=${dtype} ${s}..${e})`);
        if (st.len > 0) {
            console.log(`    → ${st.len} bytes; as bytes: ${[...st.data].join(' ')}`);
            if (st.len >= 8) {
                console.log(`    → @0 type_a=${i16(st.data, 0)} type_d=${i16(st.data, 2)}` +
                            ` datano_s=${u16(st.data, 4)} datano_e=${u16(st.data, 6)}`);
            }
        }
    }

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
