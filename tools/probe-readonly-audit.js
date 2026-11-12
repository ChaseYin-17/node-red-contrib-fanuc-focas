'use strict';
/**
 * tools/probe-readonly-audit.js — READ-ONLY audit of the calls this project makes.
 *
 * Every request below is a read. There is no write, no reset, no clear, no mode change,
 * and no function that could alter CNC state — the opcode list is exactly the one
 * focas.js issues, plus the read-only variants needed to pin a layout.
 *
 * Purpose: collect the measurements the SDK spec leaves open, so the decoders in
 * focas.js can be corrected against captured traffic instead of against the C structs.
 *
 *   - cnc_rdalmmsg record layout: is the wire 16-byte header + text, or the C struct?
 *   - does 0x23 accept a 64-character text length, or must cnc_rdalmmsg2 be used?
 *   - cnc_rdparam3: which valtype does the CNC report for a bit / byte / word / real
 *     parameter, and what does the data block look like for each?
 *   - cnc_rdaxisname / cnc_rdspdlname: 2-byte or 4-byte records?
 *   - cnc_rdusegrpid / cnc_rdngrp: 12/16 and 4/8-byte layouts
 *   - cnc_rdprogdir (0x06): what does the payload actually look like?
 *   - cnc_rdmacro (0x15): argument order and record width
 *   - cnc_rddynamic2 (0x26): what do the sub-selectors return?
 *
 * Usage: node tools/probe-readonly-audit.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.233.166';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex = b => b ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : '-';
const i16 = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : '-';
const u16 = (b, o) => (o + 2 <= b.length) ? b.readUInt16BE(o) : '-';

const h = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

// One read-only request. Never retries, never writes.
async function read(f, c3, args = [], label = '') {
    try {
        const st = await f._reqSingle(1, 1, c3, ...args);
        const err = st.error !== undefined ? st.error : 0;
        console.log(`  ${label.padEnd(46)} func=0x${c3.toString(16).padStart(4, '0')}` +
                    ` args=[${args.join(',')}]  err=${err}  len=${st.len}`);
        if (st.data && st.data.length) console.log(`      ${hex(st.data)}`);
        return st;
    } catch (e) {
        console.log(`  ${label.padEnd(46)} THREW ${e.message}`);
        try { f.socket.removeAllListeners('data'); f.socket.removeAllListeners('error'); } catch (_) {}
        return null;
    }
}

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    const si = f.sysinfo;
    console.log(`connected ${IP}:${PORT}`);
    console.log(`  cnc_type=${JSON.stringify(si.cnctype)} mt_type=${JSON.stringify(si.mttype)}` +
                ` series=${JSON.stringify(si.series)} version=${JSON.stringify(si.version)}` +
                ` maxaxis=${si.maxaxis} axes=${JSON.stringify(si.axes)} addinfo=${si.addinfo}`);

    // ── 1. Alarm messages: the record layout ─────────────────────────────────
    h('1. cnc_rdalmmsg (0x23) — record layout, and whether 64-char text is accepted');
    // The C signature is (type, num, ODBALMMSG*). The project sends two extra words.
    // Send both forms so the difference is visible rather than assumed.
    for (const [label, args] of [
        ['type=-1 num=10            (C signature only)', [-1, 10]],
        ['type=-1 num=10 withtext=1 textlen=32',        [-1, 10, 1, 32]],
        ['type=-1 num=10 withtext=1 textlen=64',        [-1, 10, 1, 64]],
        ['type=-1 num=10 withtext=1 textlen=44',        [-1, 10, 1, 44]],
        ['type=-1 num=1  withtext=1 textlen=32',        [-1, 1, 1, 32]],
    ]) {
        const st = await read(f, 0x23, args, label);
        if (st && st.data && st.data.length) {
            const n = st.data.length;
            console.log(`      len=${n}  divisors 8..128: ` +
                Array.from({ length: 121 }, (_, i) => i + 8).filter(s => n % s === 0).join(','));
            // Decode as the project does today: 16-byte header + textlen.
            for (const tl of [32, 64]) {
                const stride = 16 + tl;
                if (n % stride === 0) {
                    console.log(`      → ${n / stride} record(s) at stride ${stride} (16+${tl})`);
                    for (let p = 0; p + stride <= n; p += stride) {
                        console.log(`         alm_no=${i32(st.data, p)} type=${i32(st.data, p + 4)}` +
                                    ` axis=${i32(st.data, p + 8)} msg_len=${i32(st.data, p + 12)}` +
                                    ` text=${JSON.stringify(st.data.slice(p + 16, p + 16 + tl).toString('latin1').replace(/\0.*$/, ''))}`);
                    }
                }
            }
            // Decode as the C struct: alm_no(4) type(2) axis(2) dummy(2) msg_len(2) text(32).
            if (n % 44 === 0) {
                console.log(`      → ${n / 44} record(s) at stride 44 (C ODBALMMSG)`);
                for (let p = 0; p + 44 <= n; p += 44) {
                    console.log(`         alm_no=${i32(st.data, p)} type=${i16(st.data, p + 4)}` +
                                ` axis=${i16(st.data, p + 6)} dummy=${i16(st.data, p + 8)}` +
                                ` msg_len=${i16(st.data, p + 10)}` +
                                ` text=${JSON.stringify(st.data.slice(p + 12, p + 44).toString('latin1').replace(/\0.*$/, ''))}`);
                }
            }
        }
    }

    // ── 2. Alarm status ──────────────────────────────────────────────────────
    h('2. cnc_alarm / cnc_alarm2 (0x1a) — status word');
    await read(f, 0x1a, [], 'cnc_alarm2');

    // ── 3. Parameter types ───────────────────────────────────────────────────
    h('3. cnc_rdparam3 (0x8d) — valtype per parameter, and the data block shape');
    // A spread of parameter numbers chosen to hit different attributes:
    //   6711/6712 = 2-word (the part counters the node reads)
    //   6750..6758 = 2-word (the timers)
    //   1000/1001/1002 = bit / byte / word on most series
    //   1020 = axis-name bit parameter (bit with axis)
    //   1825 = servo loop gain (word with axis)
    //   5001 = real parameter on 30i/0i-D/F
    for (const n of [6711, 6712, 6750, 1000, 1001, 1002, 1020, 1825, 5001]) {
        const st = await read(f, 0x8d, [n, n, -1], `param ${n} (number,number,ALL_AXES)`);
        if (st && st.data && st.data.length >= 8) {
            const d = st.data;
            console.log(`      datano=${u16(d, 0)} type=0x${u16(d, 2).toString(16)}` +
                        ` (upper=type ${u16(d, 2) >> 8}, lower=axis ${(u16(d, 2) & 0xff)})` +
                        `  block=${d.length} bytes`);
            console.log(`      data @8..: ${hex(d.slice(8, Math.min(d.length, 40)))}`);
            console.log(`      as i32: ${[8, 12, 16, 20, 24].map(o => i32(d, o)).join(', ')}` +
                        `   as i16: ${[8, 10, 12, 14, 16].map(o => i16(d, o)).join(', ')}` +
                        `   as bytes: ${[8, 9, 10, 11].map(o => d[o]).join(', ')}`);
        }
    }

    // ── 4. Axis / spindle names ──────────────────────────────────────────────
    h('4. cnc_rdaxisname (0x89) / cnc_rdspdlname (0x8a) — record width');
    const axnum = await read(f, 0xa4, [2], 'cnc_axisnum type=2 (servo axes)');
    const spnum = await read(f, 0xa4, [1], 'cnc_axisnum type=1 (spindles)');
    const nAx = axnum && axnum.data ? i16(axnum.data, 0) : 0;
    const nSp = spnum && spnum.data ? i16(spnum.data, 0) : 0;
    console.log(`      → ${nAx} servo axes, ${nSp} spindles`);
    for (const [label, c3, args] of [
        ['axisname data_num=0',   0x89, [0]],
        ['axisname data_num=nAx', 0x89, [nAx]],
        ['spdlname data_num=-1',  0x8a, [-1]],
        ['spdlname data_num=nSp', 0x8a, [nSp]],
    ]) {
        const st = await read(f, c3, args, label);
        if (st && st.data && st.data.length) {
            console.log(`      len=${st.data.length}  /${nAx || nSp} = ` +
                        `${(st.data.length / (nAx || nSp || 1)).toFixed(2)} bytes per entry`);
            console.log(`      as 2-byte: ${Array.from({ length: Math.floor(st.data.length / 2) },
                (_, i) => JSON.stringify(st.data.slice(i * 2, i * 2 + 2).toString('latin1'))).join(' ')}`);
            console.log(`      as 4-byte: ${Array.from({ length: Math.floor(st.data.length / 4) },
                (_, i) => JSON.stringify(st.data.slice(i * 4, i * 4 + 4).toString('latin1'))).join(' ')}`);
        }
    }

    // ── 5. Tool life layouts ─────────────────────────────────────────────────
    h('5. tool life — cnc_rdngrp / cnc_rdtlinfo / cnc_rdusegrpid / cnc_rdgrpinfo4');
    await read(f, 0x4a, [], 'cnc_rdngrp');
    await read(f, 0x1c4, [], 'cnc_rdtlinfo');
    await read(f, 0x48, [], 'cnc_rdusegrpid');
    await read(f, 0x1c1, [1, 0, 10], 'cnc_rdgrpinfo4 grp=1 dir=0 n=10');

    // ── 6. Program directory ─────────────────────────────────────────────────
    h('6. cnc_rdprogdir (0x06) — what the payload actually is');
    for (const [label, args] of [
        ['start=1 type=0x13 len=2  (what the node sends)', [1, 0x13, 2]],
        ['type=1 datano_s=1 datano_e=9999 len=256',        [1, 1, 9999, 256]],
        ['type=0 datano_s=1 datano_e=9999 len=256',        [0, 1, 9999, 256]],
    ]) {
        const st = await read(f, 0x06, args, label);
        if (st && st.data && st.data.length) {
            console.log(`      as text: ${JSON.stringify(st.data.toString('latin1').slice(0, 200))}`);
        }
    }

    // ── 7. Macro ─────────────────────────────────────────────────────────────
    h('7. cnc_rdmacro (0x15) — argument order and record width');
    await read(f, 0x15, [1, 1], 'number=1 length=1   (what the node sends)');
    await read(f, 0x15, [1, 10], 'number=1 length=10');
    await read(f, 0x15, [100, 10], 'number=100 length=10');

    // ── 8. Dynamic data ──────────────────────────────────────────────────────
    h('8. cnc_rddynamic2 (0x26) — sub-selectors the node sends');
    for (const sub of [4, 6, 1, 8, 7]) {
        await read(f, 0x26, [sub, -1], `sub=${sub} axis=ALL`);
    }
    await read(f, 0x26, [-1, 0], 'axis=ALL length=0 (C signature)');

    // ── 9. Feed / spindle ────────────────────────────────────────────────────
    h('9. cnc_actf (0x24) / cnc_acts (0x25)');
    await read(f, 0x24, [], 'cnc_actf');
    await read(f, 0x25, [], 'cnc_acts');

    // ── 10. Load meters ──────────────────────────────────────────────────────
    h('10. cnc_rdsvmeter (0x56) / cnc_rdspmeter (0x40)');
    await read(f, 0x56, [1], 'svmeter reading=1 (%)');
    await read(f, 0x56, [3], 'svmeter reading=3 (A)');
    await read(f, 0x40, [0, -1], 'spmeter type=0 (load)');
    await read(f, 0x40, [1, -1], 'spmeter type=1 (speed)');

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
