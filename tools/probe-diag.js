'use strict';
/**
 * tools/probe-diag.js — one-shot diagnostic for the diagnostic-data read (func 0x30)
 *
 * Purpose: readservoload() / readspindleload() both return null, and the current
 * implementation cannot say *why* — it collapses three distinct failures
 * (FOCAS error, empty frame, unexpected record layout) into the same null.
 * This probe dumps the RAW response for each candidate calling convention so the
 * real one can be picked from evidence instead of guessed.
 *
 * Usage:
 *     node tools/probe-diag.js [ip] [port]
 *     node tools/probe-diag.js 192.168.100.128 8193
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

// ── Candidate record decoders for the data portion ────────────────────────────
// The shape readparam3() proved for parameter reads, reused for diagnostics:
//   varname u32 | axiscount i16 | valtype u16 | maxaxis × 4-byte values
// cnc_diagnoss's ODBDGN is struct-compatible in spirit, so the same widened
// (datano, attrib, valtype, values[MAX_AXIS]) layout is the first thing to try.
function tryDecode(data, maxaxis) {
    const stride = maxaxis * 4 + 8;
    console.log(`  assumed stride = maxaxis(${maxaxis})*4 + 8 = ${stride}`);
    console.log(`  data length = ${data.length}  →  ${data.length % stride === 0
        ? `${data.length / stride} exact record(s)`
        : `NOT a whole number of records (leftover ${data.length % stride})`}`);
    for (let pos = 0; pos + 8 <= data.length; pos += stride) {
        const varname   = data.readUInt32BE(pos);
        const axiscount = data.readInt16BE(pos + 4);
        const valtype   = data.readUInt16BE(pos + 6);
        const vals = [];
        for (let n = pos + 8; n < Math.min(pos + stride, data.length); n += 4) {
            vals.push(data.readInt32BE(n));
        }
        console.log(`    @${pos}: datano=${varname} axiscount=${axiscount} valtype=${valtype}` +
                    ` values(i32)=[${vals.slice(0, 12).join(', ')}${vals.length > 12 ? ', …' : ''}]` +
                    `  values(u8@+3)=[${vals.slice(0, 12).map(v => (v >>> 24) & 0xff).join(', ')}…]`);
    }
}

// ── Probe one calling convention, dumping the raw frame ───────────────────────
async function probe(focas, label, c1, c2, c3, args, maxaxis) {
    h(`${label}   →  func 0x${c3.toString(16).padStart(2, '0')}   args=[${args.join(', ')}]`);
    let raw;
    try {
        await focas._send(frame(cmdPayload(c1, c2, c3, args)));
        raw = await focas._recv();
    } catch (e) {
        console.log(`  ✗ transport failure: ${e.message}`);
        try { focas.socket.removeAllListeners('data'); focas.socket.removeAllListeners('error'); } catch (_) {}
        return null;
    }

    console.log('  RAW FRAME:');
    console.log(hexdump(raw));

    if (raw.length < 10) { console.log('  ✗ frame too short'); return null; }
    const ftype = raw.readUInt16BE(6);
    if (ftype !== FTYPE_VAR_RESP) { console.log(`  ✗ not a variable-response frame (ftype=0x${ftype.toString(16)})`); return null; }

    const body = raw.slice(10);
    const qu   = body.readUInt16BE(0);
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
    if (d.length < 12) { console.log('  ✗ sub-payload too short'); return null; }

    const zeros = d.slice(6, 12).every(b => b === 0);
    if (!zeros) {
        const err = d.readInt16BE(6);
        console.log(`  ✗ ERROR RESPONSE — err_no = ${err}  (${err < 0 ? 'negative: not a FOCAS status' : ''})`);
        return null;
    }
    if (d.length < 14) { console.log('  ✗ no length field'); return null; }

    const dataLen = d.readUInt16BE(12);
    const data    = d.slice(14);
    console.log(`  >>> declared dataLen = ${dataLen}, actual data bytes = ${data.length}` +
                (dataLen === data.length ? '  (consistent)' : '  <-- MISMATCH'));
    if (data.length === 0) { console.log('  (empty data portion)'); return null; }

    console.log('  DATA PORTION:');
    console.log(hexdump(data));
    console.log('\n  DECODE ATTEMPT:');
    tryDecode(data, maxaxis);
    return { dataLen, data };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`FOCAS diag probe → ${IP}:${PORT}`);
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log('connected. sysinfo =', f.sysinfo);
    const maxaxis = f.sysinfo.maxaxis;

    h('BASELINE — sysinfo sanity (0x18)');
    console.log(`  maxaxis = ${maxaxis}  cnctype = ${JSON.stringify(f.sysinfo.cnctype)} ` +
                ` mttype = ${JSON.stringify(f.sysinfo.mttype)}  series = ${JSON.stringify(f.sysinfo.series)}` +
                ` axes = ${JSON.stringify(f.sysinfo.axes)}`);

    // cnc_diagnoss(handle, number, axis, length, ODBDGN*) — the C order is
    // (number, axis, length), but readparam3 proves the wire order need not match
    // the C order. Enumerate the plausible packings for diagno 400 (servo load).
    const VARIANTS = [
        ['what the node sends now            (400, 400, -1)   ', [400, 400, -1]],
        ['(number, axis=-1, length=1)        (400, -1, 1)    ', [400, -1, 1]],
        ['(number, axis=-1, length=0)        (400, -1, 0)    ', [400, -1, 0]],
        ['(number, length=1, axis=-1)        (400, 1, -1)    ', [400, 1, -1]],
        ['(number, axis=1, length=1)         (400, 1, 1)     ', [400, 1, 1]],
        ['(start=400, end=400, axis=-1)      (400, 400, -1)  ', [400, 400, -1]],
        ['(number only)                      (400, 0, 0)     ', [400, 0, 0]],
        ['(number, axis=-1)                  (400, -1, 0) 2-a', [400, -1, 0, 0]],
    ];

    for (const [label, args] of VARIANTS) {
        await probe(f, `DIAG 400 (servo load)  ${label}`, 1, 1, 0x30, args, maxaxis);
    }

    h('DIAG 300 (spindle load) — same packings, number swapped');
    for (const [label, args] of [
        ['(number, axis=-1, length=1)   ', [300, -1, 1]],
        ['(number, axis=1, length=1)    ', [300, 1, 1]],
        ['(number, axis=-1, length=0)   ', [300, -1, 0]],
    ]) {
        await probe(f, `DIAG 300 (spindle load)  ${label}`, 1, 1, 0x30, args, maxaxis);
    }

    h('DONE');
    await f.disconnect();
})().catch(e => {
    console.error('\nFATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
});