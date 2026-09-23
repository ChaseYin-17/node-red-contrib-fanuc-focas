'use strict';
/**
 * tools/probe-alarms.js — one-shot diagnostic for cnc_rdalmmsg (func 0x23)
 *
 * Purpose: dump the RAW FOCAS response for the alarm-message function so the
 * real record layout can be reverse-engineered, instead of guessing.
 *
 * Usage:
 *     node tools/probe-alarms.js [ip] [port]
 *     node tools/probe-alarms.js 192.168.100.128 8193
 *
 * Nothing is written back to the controller — read-only probes only.
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);

const FTYPE_VAR_REQU = 0x2101;
const FTYPE_VAR_RESP = 0x2102;

// ── Raw framing (mirrors focas.js so we can dump the *whole* frame) ───────────
function frame(payload, fvers = 1) {
    const sub = Buffer.alloc(4);
    sub.writeUInt16BE(1, 0);
    sub.writeUInt16BE(payload.length + 2, 2);
    const body = Buffer.concat([sub, payload]);
    const hdr = Buffer.alloc(6);
    hdr.writeUInt16BE(fvers, 0);
    hdr.writeUInt16BE(FTYPE_VAR_REQU, 2);
    hdr.writeUInt16BE(body.length, 4);
    return Buffer.concat([Buffer.from([0xa0, 0xa0, 0xa0, 0xa0]), hdr, body]);
}

function cmdPayload(c1, c2, c3, args) {
    const b = Buffer.alloc(6 + 5 * 4);        // cmd(6) + 5 int32 args(20) — same shape as _reqSingle
    b.writeUInt16BE(c1, 0);
    b.writeUInt16BE(c2, 2);
    b.writeUInt16BE(c3, 4);
    for (let i = 0; i < 5; i++) b.writeInt32BE(args[i] | 0, 6 + i * 4);
    return b;
}

// ── Output helpers ────────────────────────────────────────────────────────────
function hexdump(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i += 16) {
        const c = buf.slice(i, i + 16);
        const hex = [...c].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(47);
        const asc = [...c].map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');
        out.push(`  ${i.toString(16).padStart(4, '0')}  ${hex}  |${asc}|`);
    }
    return out.join('\n');
}

const h = (s) => console.log(`\n${'═'.repeat(74)}\n${s}\n${'═'.repeat(74)}`);

// ── Candidate record decoders ─────────────────────────────────────────────────
// Layout A — what focas.js readalarmcode() currently assumes:
//   alm_no i32 @0 | type i32 @4 | axis i32 @8 | msg_len i32 @12 | text @16 (textlen)
// Layout B — FOCAS C struct IODBALMMSG (native short alignment):
//   alm_no i32 @0 | type i16 @4 | axis i16 @6 | dummy i16 @8 | msg_len i16 @10 | text @12 (32)
const LAYOUTS = [
    { name: 'A  (all-int32, text@16)',        stride: (t) => 16 + t, head: 16, textOff: 16, textLen: (t) => t, wide: true },
    { name: 'B  (FOCAS short struct, text@12)', stride: () => 44,   head: 12, textOff: 12, textLen: () => 32, wide: false },
    { name: 'A+ (2B count prefix)',           stride: (t) => 16 + t, head: 16, textOff: 16, textLen: (t) => t, wide: true,  skip: 2 },
    { name: 'B+ (2B count prefix)',           stride: () => 44,   head: 12, textOff: 12, textLen: () => 32, wide: false, skip: 2 },
];

function decodeWith(buf, L, textlen) {
    const skip   = L.skip || 0;
    const stride = L.stride(textlen);
    const body   = buf.slice(skip);
    const n      = Math.floor(body.length / stride);
    const recs   = [];
    for (let i = 0; i < n; i++) {
        const p = i * stride;
        let rec;
        if (L.wide) {
            rec = {
                alm_no:  body.readInt32BE(p),
                type:    body.readInt32BE(p + 4),
                axis:    body.readInt32BE(p + 8),
                msg_len: body.readInt32BE(p + 12),
                text:    body.slice(p + 16, p + 16 + L.textLen(textlen)),
            };
        } else {
            rec = {
                alm_no:  body.readInt32BE(p),
                type:    body.readInt16BE(p + 4),
                axis:    body.readInt16BE(p + 6),
                dummy:   body.readInt16BE(p + 8),
                msg_len: body.readInt16BE(p + 10),
                text:    body.slice(p + 12, p + 12 + L.textLen()),
            };
        }
        const nul = rec.text.indexOf(0);
        rec.text = (nul === -1 ? rec.text : rec.text.slice(0, nul)).toString('latin1').trim();
        recs.push(rec);
    }
    return { stride, skip, n, recs, leftover: body.length - n * stride };
}

function analyse(buf) {
    if (!buf || buf.length === 0) {
        console.log('  (empty payload — nothing to analyse)');
        return;
    }
    console.log(`  payload length = ${buf.length} bytes`);
    const divisors = [];
    for (let s = 8; s <= 128; s++) if (buf.length % s === 0) divisors.push(s);
    console.log(`  divides evenly by: ${divisors.join(', ')}`);

    for (const L of LAYOUTS) {
        const r = decodeWith(buf, L, 32);
        console.log(`\n  ── Layout ${L.name}  → stride ${r.stride}, prefix ${r.skip}, records ${r.n}, leftover ${r.leftover}`);
        if (r.n === 0) { console.log('     (no whole record fits)'); continue; }
        r.recs.forEach((rec, i) => {
            console.log(`     [${i}] alm_no=${rec.alm_no} type=${rec.type} axis=${rec.axis}` +
                        `${rec.msg_len !== undefined ? ` msg_len=${rec.msg_len}` : ''}` +
                        ` text=${JSON.stringify(rec.text)}`);
        });
    }
}

// ── Probe a function code, dumping the raw frame ──────────────────────────────
async function probe(focas, label, c1, c2, c3, args) {
    h(`${label}   →  func 0x${c3.toString(16).padStart(2, '0')}   args=[${args.join(', ')}]`);
    let raw;
    try {
        await focas._send(frame(cmdPayload(c1, c2, c3, args)));
        raw = await focas._recv();
    } catch (e) {
        console.log(`  ✗ transport failure: ${e.message}`);
        return null;
    }

    console.log('  RAW FRAME:');
    console.log(hexdump(raw));

    if (raw.length < 10) { console.log('  ✗ frame too short'); return null; }
    const ftype = raw.readUInt16BE(6);
    const len1  = raw.readUInt16BE(8);
    console.log(`  fvers=${raw.readUInt16BE(4)}  ftype=0x${ftype.toString(16)}  frameLen=${len1}`);
    if (ftype !== FTYPE_VAR_RESP) { console.log('  ✗ not a variable-response frame'); return null; }

    const body = raw.slice(10);
    const qu   = body.readUInt16BE(0);
    console.log(`  sub-payload count (qu) = ${qu}`);
    let n = 2;
    const subs = [];
    for (let t = 0; t < qu; t++) {
        if (n + 2 > body.length) { console.log('  ✗ truncated sub-payload header'); break; }
        const le = body.readUInt16BE(n);
        subs.push(body.slice(n + 2, n + le));
        n += le;
    }
    if (subs.length === 0) { console.log('  ✗ no sub-payloads'); return null; }

    const d = subs[0];
    console.log(`  sub-payload len = ${d.length}`);
    console.log('  SUB-PAYLOAD:');
    console.log(hexdump(d));

    if (d.length >= 12) {
        console.log(`  echo cmd = ${[...d.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        console.log(`  d[6..11] = ${[...d.slice(6, 12)].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }

    const zeros = d.length >= 12 && d.slice(6, 12).every(b => b === 0);
    if (!zeros) {
        console.log(`  ✗ ERROR RESPONSE — err_no = ${d.readInt16BE(6)} (0x${(d.readInt16BE(6) >>> 0).toString(16)})`);
        return null;
    }
    if (d.length < 14) { console.log('  ✗ no length field'); return null; }

    const dataLen = d.readUInt16BE(12);
    const data    = d.slice(14);
    console.log(`  >>> declared dataLen = ${dataLen}, actual data bytes = ${data.length}` +
                (dataLen === data.length ? '  (consistent)' : '  <-- MISMATCH'));

    console.log('\n  ANALYSIS OF DATA PORTION:');
    analyse(data);
    return { dataLen, data };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`FOCAS alarm probe → ${IP}:${PORT}`);
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log('connected. sysinfo =', f.sysinfo);

    h('BASELINE — statinfo (0x19)');
    const st = await f.statinfo();
    console.log('  ', JSON.stringify(st));
    if (st) console.log(`   alarm field = ${st.alarm}  (raw) → ${['none', 'ALARM', 'BATTERY LOW', 'FAN', 'PS WARNING', 'FSSB WARNING', 'INSULATE', 'ENCODER', 'PMC ALARM'][st.alarm] ?? '?'}`);

    h('BASELINE — getalarmstatus via func 0x22 (cnc_alarm)');
    try {
        const a = await f._reqSingle(1, 1, 0x22, 0);
        console.log('  ', JSON.stringify(a));
    } catch (e) { console.log('  ✗', e.message); }

    // cnc_rdalmmsg (0x23) — vary the argument packing to find what the controller accepts.
    const VARIANTS = [
        ['type=1, num=10, withtext=1, textlen=32   (what the node sends)', [1, 10, 1, 32]],
        ['type=1, num=1,  withtext=1, textlen=32   (single record)',       [1, 1, 1, 32]],
        ['type=1, num=10, withtext=1, textlen=36',                         [1, 10, 1, 36]],
        ['type=1, num=10, withtext=1, textlen=44',                         [1, 10, 1, 44]],
        ['type=1, num=10, withtext=0, textlen=0    (no text)',             [1, 10, 0, 0]],
        ['type=1, num=10                            (2-arg form)',         [1, 10, 0, 0]],
        ['type=0, num=10, withtext=1, textlen=32   (all groups)',          [0, 10, 1, 32]],
        ['type=2, num=10, withtext=1, textlen=32',                         [2, 10, 1, 32]],
        ['type=256, num=10, withtext=1, textlen=32',                       [256, 10, 1, 32]],
    ];

    for (const [label, args] of VARIANTS) {
        try {
            await probe(f, label, 1, 1, 0x23, args);
        } catch (e) {
            console.log(`  ✗ probe threw: ${e.message}`);
            // _recv leaves its listeners attached on timeout; re-key the socket.
            try { f.socket.removeAllListeners('data'); f.socket.removeAllListeners('error'); } catch (_) {}
        }
    }

    h('DONE');
    await f.disconnect();
})().catch(e => {
    console.error('\nFATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
});