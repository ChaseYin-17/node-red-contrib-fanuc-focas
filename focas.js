'use strict';
/**
 * focas.js — Pure Node.js FOCAS2 TCP client
 * Port of diohpix/pyfanuc with all known bug-fixes applied.
 *
 * Protocol constants match pyfanuc.py exactly.
 * Wire behaviour is verified against the FANUC FOCAS2 SDK shipped in docs/FANUC_Focas_API
 * (see Document/SpecE/Misc/*.xml for per-function specs, ERRCODE.HTM for status codes).
 * All methods return Promises.
 */
const net = require('net');

// ── Frame type constants ──────────────────────────────────────────────────────
const FTYPE_OPN_REQU = 0x0101;
const FTYPE_OPN_RESP = 0x0102;
// Sent in place of the open response when the controller will not take the session —
// observed when every slot is already in use. The payload is not documented in the
// SDK, so the raw bytes are carried into the error instead of being interpreted.
const FTYPE_OPN_REFUTED = 0x0103;
const FTYPE_VAR_REQU = 0x2101;
const FTYPE_VAR_RESP = 0x2102;
const FTYPE_CLS_REQU = 0x0201;
const FTYPE_CLS_RESP = 0x0202;

const FRAMEHEAD = Buffer.from([0xa0, 0xa0, 0xa0, 0xa0]);
const FRAME_DST = Buffer.from([0x00, 0x02]);
const ALLAXIS   = -1;

// ── Load-meter function codes ─────────────────────────────────────────────────
// Taken from the official FOCAS2 library's own traffic (captured with a TCP proxy:
// see tools/probe-dll-opcode.py). These are NOT diagnostics — cnc_diagnoss (0x30)
// is a different, separately-licensed function that answers EW_FUNC on controllers
// which do not implement it.
const FN_SVMETER = 0x56;   // cnc_rdsvmeter — servo load meter
const FN_SPMETER = 0x40;   // cnc_rdspmeter — spindle load meter / motor speed
const FN_AXISNUM = 0xa4;   // axis or spindle count, selected by `type`
const FN_SVNAME  = 0x89;   // cnc_rdaxisname  — servo axis names
const FN_SPNAME  = 0x8a;   // cnc_rdspdlname  — spindle names

const AXNUM_SPINDLE  = 1;  // FN_AXISNUM type: spindle count
const AXNUM_SERVO    = 2;  // FN_AXISNUM type: servo axis count
const SPMETER_LOAD   = 0;  // FN_SPMETER type: spindle load meter (data_num entry)
const SPMETER_SPEED  = 1;  // FN_SPMETER type: spindle motor speed

// FN_SVMETER carries a reading selector in its first argument. 1 is the documented
// cnc_rdsvmeter (load meter, %); 3 is the load current in Ampere that the vendor
// library reaches through cnc_rdaxisdata(cls=2, type=2) — that function has no
// opcode of its own, it decomposes into this one. See docs/notes.md. The two
// differ only in the scale the controller reports alongside the value.
const SVMETER_LOAD    = 1; // FN_SVMETER reading: load meter / load current (%)
const SVMETER_CURRENT = 3; // FN_SVMETER reading: load current (Ampere)

// Every load-meter reading is one 8-byte record; cnc_rdspmeter packs two records
// per spindle (load meter, then motor speed). The decimal position sits at +6 —
// the official library decodes it there (it reports dec=0 for a load meter, where
// the field at +4 would have given 10).
const LOADELM_STRIDE = 8;
const SPMETER_STRIDE = 16;

// ── Tool-life function codes ──────────────────────────────────────────────────
// Captured from the vendor library's own traffic with tools/probe-dll-opcode.py —
// like the load meters, these are not in the SDK headers. All four sit behind the
// CNC's "tool life management" option: without it the controller still answers the
// request (so the opcode is right) with EW_NOOPT (6) instead of an empty table.
const FN_RDUSEGRPID = 0x48;    // cnc_rdusegrpid — in-use / next / selected group
const FN_RDNGRP     = 0x4a;    // cnc_rdngrp     — groups with >=1 tool registered
const FN_RDGRPINFO4 = 0x1c1;   // cnc_rdgrpinfo4 — args: grp_no, direction, num_to_read
const FN_RDTLINFO   = 0x1c4;   // cnc_rdtlinfo   — management limits

// Wire sizes / offsets. The wire does NOT match the SDK's C layout: it widens every
// field to a 4-byte long (IODBTGI4's `short grp_no` becomes a long, and its 2-byte pad
// disappears — still 28 bytes a record). cnc_rdtlinfo additionally carries one leading
// long before the four limits. Measured against a controller with the option on; see
// docs/notes.md.
const ODBTLINFO_BYTES = 20;    // leading long + max_group, max_tool, max_minute, max_cycle
const ODBTLIFE2_BYTES = 8;     // long count + 4 trailing bytes
const ODBUSEGR_BYTES  = 12;    // long next, use, slct (the "not used" shorts are dropped)
const IODBTGI4_BYTES  = 28;    // 7 * long: grp_no, n_tool, life, counter, type, opt, rest

// cnc_rdprogdir's wire record: number(i32) | length(i32) | comment[64]. Measured
// 2026-11-12 on the 31i at 10.192.233.166 — see listprog() and docs/notes.md.
const PROGDIR_RECORD_BYTES = 72;

// ── Tool-offset function codes ────────────────────────────────────────────────
// Captured from the vendor library with tools/probe-dll-tofs.py on the 31i at
// 10.192.233.166 (2026-11-13). The codes that look adjacent to the other Ncdata reads
// (0x2c/0x2d/0x2e) are NOT these functions: they answer, but with the same bytes for
// every offset number and type — the signature of a wrong opcode. See docs/notes.md.
//
//     cnc_rdtofs     0x08   c1=1 c2=1   args (number, number, 1000+type)
//     cnc_rdtofsr    0x08   c1=1 c2=1   args (s_number, e_number, type)
//     cnc_rdtofsinfo 0x0a   c1=1 c2=1   no arguments
//
// cnc_rdtofs and cnc_rdtofsr are the SAME opcode, told apart by the argument pattern.
const FN_RDTOFS     = 0x08;   // cnc_rdtofs / cnc_rdtofsr
const FN_RDTOFSINFO = 0x0a;   // cnc_rdtofsinfo

// Every one of these answers a plain run of 8-byte records — value(i32) | dec(i16) |
// unit(i16) — with NO header, not the ODBTOFS/IODBTO C struct. Measured: cnc_rdtofsr
// type=0 offsets 1..5 returned 129.907, 136.379, 97.846, 125.361, 99.581 mm.
const TOFS_RECORD_BYTES = 8;

// cnc_rdtofs's third argument is 1000 + type, not a length. The vendor library sends
// `args=1 1 1002` for cnc_rdtofs(1, type=2).
const TOFS_SINGLE_BASE = 1000;

// The single form's `type` follows the spec's M-series enum (0 cutter-radius wear,
// 1 cutter-radius geometry, 2 tool-length wear, 3 tool-length geometry). The RANGE
// form uses a different numbering: measured on the same machine, range type 0 is the
// same values as single type 3, range type 1 = single type 2, range type 3 = single
// type 0. Only the single form is exposed, so the spec's enum applies.
const TOFS_TYPES_M = {
    0: 'cutter radius wear', 1: 'cutter radius geometry',
    2: 'tool length wear',   3: 'tool length geometry',
    6: 'imaginary tool nose wear', 7: 'imaginary tool nose geometry',
    10: 'corner R wear',     11: 'corner R geometry',
};
const TOFS_TYPES_T = {
    0: 'X wear', 1: 'X geometry', 2: 'Z wear', 3: 'Z geometry',
    4: 'nose R wear', 5: 'nose R geometry',
    6: 'imaginary tool nose wear', 7: 'imaginary tool nose geometry',
    8: 'Y wear', 9: 'Y geometry',
    30: '4th axis wear', 31: '4th axis geometry',
    32: '5th axis wear', 33: '5th axis geometry',
};

// How many groups to ask for in one cnc_rdgrpinfo4 call. The controller has an
// undocumented ceiling on num_to_read — on the 31i measured 2026-09-28 the request is
// answered normally up to 103 and rejected with EW_PROTOCOL on frame type 0x2103 from
// 104 up (the vendor DLL sidesteps it by clamping to 51). Read groups in pages instead
// of guessing a controller's capacity; see readgrpinfo4() and docs/notes.md.
const TOOL_GROUP_PAGE = 64;

// ── Tier-1/2 read function codes ──────────────────────────────────────────────
// Captured 2026-11-13 with `python tools/probe-dll-opcode.py --stub --tier12` — the
// vendor library's own traffic, no controller needed. The response layouts were then
// pinned against the 31i at 10.192.232.189 with tools/probe-tier12-layout.js and
// tools/probe-tier12-verify.js. See docs/notes.md.
//
// None of these pauses CNC-side history sampling: their SpecE pages carry no
// `stop sampling` / `cnc_stopophis` / `stop logging`. The functions that DO
// (cnc_rdalmhistry*, cnc_rdophistry*, cnc_rdalmhisno, cnc_rdophisno4, cnc_rdomhis*)
// are deliberately absent from this file.
//
// cnc_rdexecprog (0x20) is also absent. Its opcode is captured, but its spec page says
// the execution pointer moves to the next block under single-block operation and that
// has not been disproved on a machine that could be watched. Do not add it without
// that check — see docs/notes.md.
const FN_RDCNCID    = 0x0e8;   // cnc_rdcncid    — machine identity
const FN_RDZOFSINFO = 0x0d;    // cnc_rdzofsinfo — work-zero offset count
const FN_RDZOFS     = 0x0b;    // cnc_rdzofs     — one work-zero offset
const FN_RDSEQNUM   = 0x1d;    // cnc_rdseqnum   — sequence number under execution
const FN_RDCOMMAND  = 0x97;    // cnc_rdcommand  — modal / commanded F,S,T,B
const FN_RDPROGINFO = 0x07;    // cnc_rdproginfo — program memory
const FN_RDPM_ITEM  = 0xbe;    // cnc_rdpm_item  — maintenance items
const FN_RDBLKCOUNT = 0x35;    // cnc_rdblkcount — block counter
const FN_GETTIMER   = 0x45;    // cnc_gettimer   — CNC calendar
const FN_PMC_RDPMCRNG = 0x8001; // pmc_rdpmcrng — PMC data window

// cnc_statinfo2 is a COMPOSITE call: the library puts three sub-requests in one frame.
//
// The assembly is NOT `sub1 + sub2 = ODBST2 in declaration order`. Measured 2026-11-13
// on the 31i at 10.192.232.189, back to back with the plain cnc_statinfo:
//
//     cnc_statinfo (0x19) : 1 3 1 0 0 0 0            (aut run motion mstb emergency alarm edit)
//     statinfo2 sub1 (e2) : 1 3 1 0 0 0 0 0 0 0 0    (11 shorts)
//     statinfo2 sub2 (e1) : 0 3                      (2 shorts)
//
// sub1's first seven shorts are byte-identical to cnc_statinfo's seven, so **sub1
// starts at `aut`** — not at `hdck`. sub2 is then `hdck`/`tmmode`, which ODBST2 puts
// FIRST in its declaration. Reading sub1 as if it began with hdck/tmmode shifts every
// field by two, which is what made an earlier version report run=**** / motion=Stopped
// while the machine was in STaRt/Moving.
//
// 0x98 answers 2 bytes and is NOT part of the struct — do not request it.
const FN_STATINFO2_A = 0x0e2;
const FN_STATINFO2_B = 0x0e1;

// pmc_rdpmcrng's command pair is 2/1, like pmc_rdalmmsg — the second word is a
// path/unit selector, so 1/2 is answered EW_PATH (11). Its arguments are also not the
// C order: the wire is (s_number, e_number, adr_type, data_type, 0) and `length` never
// goes on the wire at all.
const PMC_RDPMCRNG_C1 = 2;
const PMC_RDPMCRNG_C2 = 1;

// FwSymbol.h: PMC_BYTE 0, PMC_WORD 1, PMC_LONG 2. The SpecE page's prose says the same
// thing but its length formula is written against a different numbering; reading
// dtype=2 as a word is what made the first capture look contradictory.
const PMC_BYTE = 0;
const PMC_WORD = 1;
const PMC_LONG = 2;
const PMC_WIDTH = { [PMC_BYTE]: 1, [PMC_WORD]: 2, [PMC_LONG]: 4 };

// PMC address areas, in the order pmc_rdpmcrng's adr_type numbers them.
const PMC_AREAS = {
    G: 0, F: 1, Y: 2, X: 3, A: 4, R: 5, T: 6, K: 7, C: 8, D: 9,
};

// ── Alarm / PMC alarm function codes ──────────────────────────────────────────
// Captured with tools/probe-dll-opcode.py — the vendor library driven through a
// local proxy with both directions hexdumped, which is how cnc_rdsvmeter = 0x56
// and cnc_rdspmeter = 0x40 were read off. Taken 2026-10-12 on two 31i controllers
// (10.192.233.95:8193 and 192.168.100.128:8193), which agreed on every frame below;
// cnc_rdsvmeter ran first on both as the control and its 0x56 was present, so both
// captures are sound. See docs/notes.md for the full table.
//
//     cnc_alarm             0x1a    c1=1 c2=1, no arguments
//     cnc_alarm2            0x1a    identical request, see below
//     pmc_rdalmmsg          0x8010  c1=2 c2=1, args (s_number, read_num)
//
// cnc_alarm2 is NOT a second opcode: the library puts a byte-for-byte identical
// request on the wire for both APIs and only the caller's struct width differs.
// Both reads below therefore use 0x1a and differ in how much of the returned status
// they keep — 16 bits for cnc_alarm (ODBALM.data is a short), 32 for cnc_alarm2.
//
// pmc_rdalmmsg is the one call here whose command pair is not 1/1, and it is 2/1 —
// not 1/2. The two words of that request were read off the hexdump in the wrong
// order, and the transposition was carried into this file as `PMC_RDALMMSG_C2 = 2`
// with c1 left at 1. It is not a harmless difference: the controller takes the
// second word of the pair as a path/unit selector, so (1,2) is answered EW_PATH (11)
// — a *path* error for a function that has no path argument — while (2,1) is answered
// normally. Found by putting both requests on the same controller and diffing them,
// the 31i at 192.168.100.128 (2026-10-12); see docs/notes.md.
//
// NOTE 0x22 is not cnc_alarm. tools/probe-funcsupport.js and tools/probe-alarms.js
// used to label it that way; the label was never verified and this capture shows it
// is wrong. 0x22 belongs to some other function, and nothing here knows which.
const FN_ALARM        = 0x1a;     // cnc_alarm / cnc_alarm2
const FN_PMC_RDALMMSG = 0x8010;   // pmc_rdalmmsg
const PMC_RDALMMSG_C1 = 2;        // ... which the controller only answers with c1=2,
const PMC_RDALMMSG_C2 = 1;        //     c2=1 — see above, the pair is not 1/1.

// pmc_rdalmmsg's `exist` out-parameter (FwSymbol.h: PMC_ALARM_NO / _ALL_READ / _STILL).
// 0 — everything asked for was read — needs no name; it is the `more === false` path.
const PMC_ALARM_NO     = -1;      // there is no alarm
const PMC_ALARM_STILL  = 1;       // more alarms than were asked for

// cnc_rdalmmsg's text field is 32 characters, full stop. The spec says so and points at
// cnc_rdalmmsg2 for the 30i family; this call has no text-length argument in its C
// signature. See readalarmcode() and docs/notes.md.
const ALM_TEXT_MAX = 32;

// ── Low-level framing ─────────────────────────────────────────────────────────
function encap(ftype, payload, fvers = 1) {
    if (ftype === FTYPE_VAR_REQU) {
        if (Array.isArray(payload)) {
            const parts = payload.map(p => {
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeUInt16BE(p.length + 2);
                return Buffer.concat([lenBuf, p]);
            });
            const countBuf = Buffer.alloc(2);
            countBuf.writeUInt16BE(parts.length);
            payload = Buffer.concat([countBuf, ...parts]);
        } else {
            const hdr = Buffer.alloc(4);
            hdr.writeUInt16BE(1, 0);
            hdr.writeUInt16BE(payload.length + 2, 2);
            payload = Buffer.concat([hdr, payload]);
        }
    }
    const hdr = Buffer.alloc(6);
    hdr.writeUInt16BE(fvers,         0);
    hdr.writeUInt16BE(ftype,         2);
    hdr.writeUInt16BE(payload.length, 4);
    return Buffer.concat([FRAMEHEAD, hdr, payload]);
}

function decap(data) {
    if (data.length < 10) return { len: -1 };
    if (data[0] !== 0xa0 || data[1] !== 0xa0 || data[2] !== 0xa0 || data[3] !== 0xa0)
        return { len: -1 };
    const fvers = data.readUInt16BE(4);
    const ftype = data.readUInt16BE(6);
    const len1  = data.readUInt16BE(8);
    if (len1 + 10 !== data.length) return { len: -1 };
    if (len1 === 0) return { len: 0, ftype, fvers, data: Buffer.from([0x30]) };

    const body = data.slice(10);
    if (ftype === FTYPE_VAR_RESP) {
        const qu = body.readUInt16BE(0);
        let n = 2, re = [];
        for (let t = 0; t < qu; t++) {
            const le = body.readUInt16BE(n);
            re.push(body.slice(n + 2, n + le));
            n += le;
        }
        return { len: len1, ftype, fvers, data: re };
    }
    return { len: len1, ftype, fvers, data: body };
}

// ── Decode 8-byte value (feedrate/spindle) ────────────────────────────────────
// The wire record is value(i32) | format(i16) | dec(i16), so the decimal position is
// the byte at +7 and the format selector the byte at +5. Measured 2026-11-12 on the
// 31i at 10.192.233.166: cnc_actf answered `00 00 00 c8 00 0a 00 00` = 200 at dec 0
// and cnc_acts `00 00 09 c4 00 0a 00 00` = 2500 at dec 0. See docs/notes.md.
function decode8(val) {
    const flag = val[5];
    if (flag === 2 || flag === 10) {
        if (val[6] === 0xff && val[7] === 0xff) return null;
        const raw = val.readInt32BE(0);
        return raw / Math.pow(flag, val[7]);
    }
    return null;
}

// ── Parse parameter response body (cnc_rdparam3) ─────────────────────────────
// The wire is NOT the IODBPSD C struct, and its attribute enum is not the one the
// spec documents. Captured from the vendor library on the 31i at 10.192.233.166
// (2026-11-12, tools/probe-dll-param.py + tools/probe-param-types.js):
//
//     datano(i32) | type(i16) | attr(i16) | record[MAX_AXIS] of 8 bytes
//                                              value(i32) | dec(i32)
//
// `type` read 0xffff for every parameter on that controller, so it carries nothing;
// the attribute is the word at +6. Its enum is measured, not documented:
//
//     attr 0  byte / word / 2-word   value = i32 at +0
//     attr 1  bit                    value = the byte at +3
//     attr 2  word with axis         value = i32 at +0
//     attr 3  2-word with axis       value = i32 at +0
//     attr 4  real                   value = i32 at +0, decimals = i32 at +4
//
// The old decoder read 4-byte records out of an 8-byte stride, took the attribute
// from `type` (always 0xffff here) and had bit/byte swapped, so a bit parameter came
// back as a byte and a real parameter came back as `undefined`.
const PARAM_RECORD_BYTES = 8;
const PARAM_ATTR_BIT      = 1;
const PARAM_ATTR_REAL     = 4;

function parseParamBody(data, maxaxis) {
    const stride = maxaxis * PARAM_RECORD_BYTES + 8;
    const r = {};
    for (let pos = 0; pos + 8 <= data.length; pos += stride) {
        const varname = data.readUInt32BE(pos);
        const attr    = data.readUInt16BE(pos + 6);
        const values  = { type: attr, axis: -1, data: [] };

        // Bound by the buffer as well as by the stride: a controller that answers a
        // short block must not make this read past the end.
        const end = Math.min(pos + stride, data.length);
        for (let n = pos + 8; n + PARAM_RECORD_BYTES <= end; n += PARAM_RECORD_BYTES) {
            const chunk = data.slice(n, n + PARAM_RECORD_BYTES);
            let value;
            if (attr === PARAM_ATTR_BIT) {
                // The bit parameter is one byte, and the wire puts it in the low byte
                // of the record's first word: 1020 read `88 89 90 42 88` = X Y Z B X2.
                value = chunk[3];
            } else if (attr === PARAM_ATTR_REAL) {
                // Real parameter = prm_val * 10 ** (-dec_val), the same identity the
                // spec gives for REALPRM. 5001 read value 64 with dec 0.
                const prm = chunk.readInt32BE(0);
                const dec = chunk.readInt32BE(4);
                value = prm / Math.pow(10, dec);
            } else {
                value = chunk.readInt32BE(0);
            }
            values.data.push(value);
        }
        r[varname] = values;
    }
    return r;
}

// ── Tier-1/2 response decoders ────────────────────────────────────────────────
// Every one of these widens `short` to a 4-byte long and drops the C `dummy` fields,
// the same treatment ODBALM and ODBUSEGR get. The C struct is not the wire. Layouts
// measured 2026-11-13 on the 31i at 10.192.232.189 — see docs/notes.md.

// cnc_rdcommand's ODBCMD record: adrs(u8) | num(u8) | flag(u16) | cmd_val(i32) |
// dec_val(i32) = 12 bytes, which IS the C struct. flag bit 0x0800 is set on every
// populated record and clear on the empty M2..M5 slots, so it is what tells "no
// command" from "command is zero".
const ODBCMD_BYTES = 12;
const ODBCMD_FLAG_PRESENT = 0x0800;

function decodeCommand(data) {
    const out = [];
    for (let pos = 0; pos + ODBCMD_BYTES <= data.length; pos += ODBCMD_BYTES) {
        const flag = data.readUInt16BE(pos + 2);
        const val  = data.readInt32BE(pos + 4);
        const dec  = data.readInt32BE(pos + 8);
        out.push({
            address: String.fromCharCode(data[pos]),
            number:  data[pos + 1],
            flag,
            present: (flag & ODBCMD_FLAG_PRESENT) !== 0,
            raw:     val,
            dec,
            // A dec outside 0..9 is not a decimal position; keep the raw value rather
            // than dividing by a nonsense power of ten.
            value:   (dec >= 0 && dec <= 9) ? val / Math.pow(10, dec) : val,
        });
    }
    return out;
}

// cnc_rdpm_item's IODBPMAINTE: name[64] | type(i32) | total(i32) | remain(i32) |
// stat(i32) = 80 bytes. The C struct declares name[62]; the wire pads it to 64, which
// is why the stride is 80 and not 78. Confirmed by asking for 1/2/3/10 items — the
// reply is exactly 80·N every time.
const IODBPMAINTE_BYTES = 80;
const IODBPMAINTE_NAME  = 64;

function decodeMaintenanceItems(data) {
    const out = [];
    for (let pos = 0; pos + IODBPMAINTE_BYTES <= data.length; pos += IODBPMAINTE_BYTES) {
        let name = data.slice(pos, pos + IODBPMAINTE_NAME);
        const nul = name.indexOf(0);
        if (nul !== -1) name = name.slice(0, nul);
        const text = name.toString('latin1').trim();
        out.push({
            // An unconfigured item has an empty name. null, not '', so a caller can
            // tell "no name set" from "a name that is blank".
            name:   text || null,
            type:   data.readInt32BE(pos + 64),
            total:  data.readInt32BE(pos + 68),
            remain: data.readInt32BE(pos + 72),
            stat:   data.readInt32BE(pos + 76),
        });
    }
    return out;
}

// cnc_gettimer answers 12 bytes of six shorts: year/month/day then hour/minute/second.
// The spec says date and time are separate calls selected by `type`, and that is
// exactly what the wire does — but the reply is always the full 12 bytes, and the
// half that was NOT asked for keeps whatever was in the buffer:
//
//     type=0 (date) → 2026 11 13 8269 18228 12353   ← tail is stale
//     type=1 (time) → 2026 11 13 17 18 26           ← head is the last date read
//
// So the two halves must be read separately and each taken from the call that asked
// for it. Reading `type=0` twice does not help: the tail is never filled by it.
// Measured 2026-11-13 on the 31i at 10.192.232.189.
const IODBTIMER_BYTES = 12;

function decodeTimerDate(data) {
    if (data.length < IODBTIMER_BYTES) return null;
    return { year: data.readInt16BE(0), month: data.readInt16BE(2), day: data.readInt16BE(4) };
}

function decodeTimerTime(data) {
    if (data.length < IODBTIMER_BYTES) return null;
    return { hour: data.readInt16BE(6), minute: data.readInt16BE(8), second: data.readInt16BE(10) };
}

// cnc_rdproginfo answers 16 bytes: FOUR longs, not the C ODBNC union's
// `short reg_prg | short unreg_prg | long used_mem | long unused_mem`.
//
// Measured 2026-11-13 on the 31i at 10.192.232.189: `00 00 00 81 | 00 00 03 70 |
// 00 02 bd 2c | 00 7e ca fc` = 129 | 880 | 179500 | 8309500. Read as two shorts then
// two longs it gives registered=0, which is wrong — that machine has 112 programs in
// its directory and 129 registered. The wire widens the two shorts to longs, the same
// treatment every other record here gets.
const ODBNC_BYTES = 16;

function decodeProgramInfo(data) {
    if (data.length < ODBNC_BYTES) return null;
    return {
        registered:  data.readInt32BE(0),
        available:   data.readInt32BE(4),
        used_mem:    data.readInt32BE(8),
        unused_mem:  data.readInt32BE(12),
    };
}

// cnc_rdopmsg3 (0xd0) is NOT implemented, and there is no decoder for it here.
//
// Its opcode was captured, but on the 31i at 10.192.232.189 the reply is not an
// OPMSG3 at all: 268 bytes whose content is the cnc_sysinfo block (`G40A`, `60.0`,
// `05` — that machine's series, version and axis count) followed by zeros, identical
// across every `type` and every call. That is the signature docs/notes.md records for
// a wrong opcode — an answer that does not change with its arguments — and the machine
// had no operator message set, so the real layout could not be measured either way.
// Do not add a decoder until a controller with a message typed on screen can be probed.

// cnc_rdzofs answers the same 8-byte value(i32) | unit(i16) | dec(i16) record the tool
// offsets use, with no header — not the IODBZOFS C struct.
function decodeZofsRecord(data) {
    if (data.length < 8) return null;
    const raw  = data.readInt32BE(0);
    const unit = data.readInt16BE(4);
    const dec  = data.readInt16BE(6);
    return { raw, unit, dec, value: raw / Math.pow(10, dec) };
}

// pmc_rdpmcrng answers raw PMC bytes with no header. The byte path is LITTLE-endian
// within each 2-byte word: reading the same 8 bytes three ways on the 31i at
// 10.192.232.189 gave
//
//     byte : 22 05 03 14 00 22 05 03
//     word : 05 22 14 03 22 00 03 05
//     long : 14 03 05 22 03 05 22 00
//
// and reversing each 2-byte group of the byte read reproduces the word read exactly.
// Confirmed directly: D100 as a word is 0x0522 while D100/D101 as bytes are 0x22/0x05,
// so D100 holds the LOW half. The same held on the K area, so it is not a D-table quirk.
//
// The node therefore reads PMC at BYTE width and assembles wider values here, which
// keeps one ordering rule instead of three.
function decodePmcBytes(data, dataType) {
    const width = PMC_WIDTH[dataType] ?? 1;
    const out = [];
    for (let pos = 0; pos + width <= data.length; pos += width) {
        if (width === 1)      out.push(data[pos]);
        else if (width === 2) out.push(data.readUInt16LE(pos));
        else                  out.push(data.readUInt32LE(pos));
    }
    return out;
}

// ── FOCAS status codes ────────────────────────────────────────────────────────
// FOCAS2 spec: docs/FANUC_Focas_API/Document/SpecE/ERRCODE.HTM
const FOCAS_ERRORS = {
    '-17':'EW_PROTOCOL', '-16':'EW_SOCKET', '-15':'EW_NODLL', '-11':'EW_BUS',
    '-10':'EW_SYSTEM2',   '-9':'EW_HSSB',    '-8':'EW_HANDLE', '-7':'EW_VERSION',
     '-6':'EW_UNEXP',     '-5':'EW_SYSTEM',  '-4':'EW_PARITY', '-3':'EW_MMCSYS',
     '-2':'EW_RESET',     '-1':'EW_BUSY',      '0':'EW_OK',      '1':'EW_FUNC',
      '2':'EW_LENGTH',     '3':'EW_NUMBER',    '4':'EW_ATTRIB',  '5':'EW_DATA',
      '6':'EW_NOOPT',      '7':'EW_PROT',      '8':'EW_OVRFLOW', '9':'EW_PARAM',
     '10':'EW_BUFFER',    '11':'EW_PATH',     '12':'EW_MODE',   '13':'EW_REJECT',
     '14':'EW_DTSRVR',    '15':'EW_ALARM',    '16':'EW_STOP',   '17':'EW_PASSWD',
};

// The PMC Data Window has its OWN status table (ERRCODE.HTM, "PMC Data Window"), and
// three of its codes mean something different from the CNC table above: 1 is EW_NOPMC
// (not EW_FUNC), 3 is EW_RANGE (not EW_NUMBER) and 4 is EW_TYPE (not EW_ATTRIB). A PMC
// call reported through the CNC table names the wrong fault.
const PMC_ERRORS = {
    '-17':'EW_PROTOCOL', '-16':'EW_SOCKET', '-15':'EW_NODLL', '-11':'EW_BUS',
    '-10':'EW_SYSTEM2',   '-9':'EW_HSSB',    '-8':'EW_HANDLE', '-7':'EW_VERSION',
     '-6':'EW_UNEXP',     '-5':'EW_SYSTEM',  '-4':'EW_PARITY', '-3':'EW_MMCSYS',
     '-2':'EW_RESET',     '-1':'EW_BUSY',      '0':'EW_OK',      '1':'EW_NOPMC',
      '2':'EW_LENGTH',     '3':'EW_RANGE',     '4':'EW_TYPE',    '5':'EW_DATA',
      '6':'EW_NOOPT',     '10':'EW_BUFFER',   '17':'EW_PASSWD',
};

function focasErrName(code, table = FOCAS_ERRORS) {
    return table[String(code)] || 'EW_UNKNOWN';
}

// The wire protocol gives no error text on a bad handshake, so the only way to tell
// "the controller answered with something else" from "our stream is out of sync" is
// to keep the first bytes of the offending reply in the message.
function hexDump(buf, n = 16) {
    const s = buf.slice(0, Math.min(buf.length, n)).toString('hex');
    return s.length ? s.match(/../g).join(' ') : '(empty)';
}

// Turn a rejected `_reqSingle` result into the message it deserves. Both failure
// shapes have to name the function and the CNC's reason: an EW_* status is a real
// answer from the controller and must never be mistaken for "no data".
function reqErr(fnName, st, detail, table = FOCAS_ERRORS) {
    const suffix = detail ? ` ${detail}` : '';
    if (st.error !== undefined)
        return `${fnName}: CNC returned ${focasErrName(st.error, table)} (${st.error})${suffix}`;
    // A reply in an unexpected frame type (e.g. 0x2103, which the controller uses to
    // reject an out-of-range request) is not a malformed frame — say which one it was
    // and keep the head, instead of reporting every non-answer the same way.
    if (st.ftype !== undefined)
        return `${fnName}: unexpected reply frame 0x${st.ftype.toString(16).padStart(4, '0')}` +
               `${st.raw ? ` (head=${hexDump(st.raw)})` : ''}${suffix}`;
    return `${fnName}: malformed or empty response frame${suffix}`;
}

// ── Main client class ─────────────────────────────────────────────────────────
class Focas {
    constructor(ip, port = 8193, timeout = 5000) {
        this.ip      = ip;
        this.port    = port;
        this.timeout = timeout;
        this.socket  = null;
        this.sysinfo = null;
    }

    // ── Socket helpers ────────────────────────────────────────────────────────
    _send(buf) {
        return new Promise((resolve, reject) => {
            this.socket.write(buf, err => err ? reject(err) : resolve());
        });
    }

    _recv() {
        return new Promise((resolve, reject) => {
            const socket  = this.socket;
            let buf       = Buffer.alloc(0);
            let settled   = false;
            let timer     = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                socket.removeListener('data',  onData);
                socket.removeListener('error', onErr);
                socket.removeListener('close', onClose);
                socket.removeListener('end',   onEnd);
            };
            const fail = err => { if (settled) return; settled = true; cleanup(); reject(err); };
            const done = raw => { if (settled) return; settled = true; cleanup(); resolve(raw); };

            const onData = chunk => {
                buf = Buffer.concat([buf, chunk]);
                if (buf.length < 10) return;
                const expected = buf.readUInt16BE(8) + 10;
                if (buf.length >= expected) done(buf.slice(0, expected));
            };
            const onErr   = err => fail(err);
            // A controller that turns a session away commonly drops the connection
            // rather than replying. Without these two that is a silent full-length hang
            // reported as a generic timeout, which hides the real cause.
            const onClose = () => fail(new Error('FOCAS connection closed by controller'));
            const onEnd   = () => fail(new Error('FOCAS connection ended by controller'));

            timer = setTimeout(() => {
                fail(new Error('FOCAS recv timeout'));
                // A partial frame may already have been consumed, so the stream is
                // desynchronised and this socket cannot be reused. Destroying it here
                // also stops a timed-out poll from holding a session on the controller.
                this.destroy();
            }, this.timeout);

            socket.on('data',  onData);
            socket.on('error', onErr);
            socket.on('close', onClose);
            socket.on('end',   onEnd);
        });
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────
    // Drop the socket without the CLS handshake. Safe to call repeatedly and on a
    // socket that is already dead.
    destroy() {
        const sock = this.socket;
        this.socket = null;
        if (!sock) return;
        sock.setTimeout(0);
        sock.unref();
        sock.destroy();
    }

    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;
            // Every failure path has to tear the socket down. A socket left ESTABLISHED
            // after a refused handshake still occupies one of the controller's session
            // slots, and those do not come back until this process releases it — which,
            // with a poll opening a fresh session each time, means the next polls fail
            // too for a reason that has nothing to do with them.
            const done = err => {
                if (settled) return;
                settled = true;
                if (err) { this.destroy(); reject(err); }
                else     { resolve(); }
            };

            this.socket = new net.Socket();
            this.socket.setTimeout(this.timeout);
            this.socket.connect(this.port, this.ip, async () => {
                try {
                    await this._send(encap(FTYPE_OPN_REQU, FRAME_DST));
                    const raw = await this._recv();
                    const res = decap(raw);
                    if (res.ftype === FTYPE_OPN_REFUTED) {
                        return done(new Error(
                            'Open refused by controller — every FOCAS session is in use' +
                            ` (ftype 0x0103, bytes=${raw.length}, head=${hexDump(raw)})`
                        ));
                    }
                    if (res.ftype !== FTYPE_OPN_RESP) {
                        const got = res.ftype === undefined
                            ? 'no valid frame'
                            : `0x${res.ftype.toString(16).padStart(4, '0')}`;
                        return done(new Error(
                            `Open handshake failed — expected ftype 0x0102, got ${got}` +
                            ` (bytes=${raw.length}, head=${hexDump(raw)})`
                        ));
                    }
                    await this._getsysinfo();
                    done();
                } catch (e) { done(e); }
            });
            // Kept attached after a successful connect on purpose: an 'error' with no
            // listener is an uncaught exception, and this is a no-op once settled.
            this.socket.on('error', done);
            this.socket.on('timeout', () => {
                if (settled) return;      // set up already — _recv owns the timeout now
                done(new Error('Connection timeout'));
            });
        });
    }

    async disconnect() {
        if (!this.socket) return;
        const sock = this.socket;
        this.socket = null;       // ← clear ref first — prevents double-disconnect if new poll fires
        try {
            sock.write(encap(FTYPE_CLS_REQU, Buffer.alloc(0)));
            // ← NO await recv — controller's response stays unread in kernel buffer
        } catch (_) {}
        sock.setTimeout(0);       // cancel any pending timeout
        sock.setKeepAlive(false); // no keepalive probes on exit
        sock.unref();             // don't block process exit
        sock.destroy();           // close(fd) with unread data in buffer → Linux sends RST → no TIME_WAIT
    }

    // ── Request primitives ────────────────────────────────────────────────────
    async _reqSingle(c1, c2, c3, v1=0, v2=0, v3=0, v4=0, v5=0, pl=Buffer.alloc(0)) {
        const cmd = Buffer.alloc(6);
        cmd.writeUInt16BE(c1, 0); cmd.writeUInt16BE(c2, 2); cmd.writeUInt16BE(c3, 4);
        const args = Buffer.alloc(20);
        args.writeInt32BE(v1,  0); args.writeInt32BE(v2,  4);
        args.writeInt32BE(v3,  8); args.writeInt32BE(v4, 12); args.writeInt32BE(v5, 16);
        await this._send(encap(FTYPE_VAR_REQU, Buffer.concat([cmd, args, pl])));
        const raw = await this._recv();
        const t   = decap(raw);
        // Carry the frame type and the head into the failure so reqErr can name a reply
        // the controller sent in a frame type we do not handle (0x2103 on an over-range
        // request), rather than calling it malformed.
        if (t.len === 0)                return { len: -1, ftype: t.ftype, raw: t.data };
        if (t.ftype !== FTYPE_VAR_RESP) return { len: -1, ftype: t.ftype, raw: t.data };
        const d = t.data[0];
        if (d.slice(0, 6).equals(cmd) && d[6] === 0 && d[7] === 0 && d[8] === 0 && d[9] === 0 && d[10] === 0 && d[11] === 0) {
            return { len: d.readUInt16BE(12), data: d.slice(14) };
        }
        if (d.slice(0, 6).equals(cmd)) {
            return { len: 0, data: d.slice(6), error: d.readInt16BE(6) };
        }
        return { len: -1 };
    }

    async _reqMulti(list) {
        await this._send(encap(FTYPE_VAR_REQU, list));
        const raw = await this._recv();
        const t   = decap(raw);
        if (t.len === 0 || t.ftype !== FTYPE_VAR_RESP) return { len: -1 };
        if (list.length !== t.data.length) return { len: -1 };
        for (let x = 0; x < t.data.length; x++) {
            if (t.data[x].slice(0, 6).equals(list[x].slice(0, 6))) {
                // Same sub-payload layout as _reqSingle: echo(6) | status(6) | len(2) | data.
                // The length prefix is stripped here so `data` means the same thing from
                // both request helpers — reading it as a record count is not possible.
                const zeros = t.data[x].slice(6, 12).every(b => b === 0);
                t.data[x] = zeros
                    ? [0, t.data[x].slice(14)]
                    : [t.data[x].readInt16BE(6), t.data[x].slice(14)];
            } else {
                return { len: -1 };
            }
        }
        return t;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async _getsysinfo() {
        const st = await this._reqSingle(1, 1, 0x18);
        if (st.len !== 0x12) throw new Error('getsysinfo: unexpected response length');
        this.sysinfo = {
            addinfo: st.data.readUInt16BE(0),
            maxaxis: st.data.readUInt16BE(2),
            cnctype: st.data.slice(4,  6).toString('ascii'),
            mttype:  st.data.slice(6,  8).toString('ascii'),
            series:  st.data.slice(8,  12).toString('ascii'),
            version: st.data.slice(12, 16).toString('ascii'),
            axes:    st.data.slice(16, 18).toString('ascii'),
        };
    }

    async statinfo() {
        const st = await this._reqSingle(1, 1, 0x19, 0);
        const t  = this.sysinfo.cnctype.trim();
        // Series 15/15i has its own ODBST: `dummy[2]` then aut, manual, run, edit,
        // motion, mstb, emergency, write, labelskip, alarm, warning, battery — 26 bytes
        // in the C struct. It is a different shape from the 16/18/21/0i/30i block, so it
        // is decoded separately rather than being forced through the same offsets.
        if (t === '15') {
            if (st.len < 0x0e) return null;
            const d = st.data;
            return {
                aut:       d.readUInt16BE(0),
                manual:    d.readUInt16BE(2),
                run:       d.readUInt16BE(4),
                edit:      d.readUInt16BE(6),
                motion:    d.readUInt16BE(8),
                mstb:      d.readUInt16BE(10),
                emegency:  d.readUInt16BE(12),
                alarm:     d.readUInt16BE(14),
                warning:   d.readUInt16BE(16),
                battery:   d.readUInt16BE(18),
            };
        }
        const is16 = ['16','31','18','0i','30',' 0','0 '].includes(t) ||
                     t === '0';   // 0i-D returns bare '0'
        if (is16 && st.len === 0x0e) {
            // The wire drops ODBST's leading `hdck`/`tmmode` (18 bytes in the C struct,
            // 14 here), so the 7 shorts that remain start at `aut` — which the C struct
            // puts at +4, not +0. Measured 2026-11-12 on the 31i at 10.192.233.166:
            // `00 01 00 03 00 01 00 00 00 00 00 00 00 00` = MEMory / STaRt / motion.
            const d = st.data;
            return {
                aut:       d.readUInt16BE(0),
                run:       d.readUInt16BE(2),
                motion:    d.readUInt16BE(4),
                mstb:      d.readUInt16BE(6),
                emegency:  d.readUInt16BE(8),
                alarm:     d.readUInt16BE(10),
                edit:      d.readUInt16BE(12),
            };
        }
        return null;
    }

    async readprognum() {
        const st = await this._reqSingle(1, 1, 0x1c);
        if (st.len < 8) return null;
        return {
            run:  st.data.readInt32BE(0),
            main: st.data.readInt32BE(4),
        };
    }

    // cnc_rdprogdir — the program directory. The wire is NOT the PRGDIR ASCII text the
    // spec describes: it is a fixed 72-byte record per program,
    //
    //     number(i32) | length(i32) | comment[64]
    //
    // and the arguments are (start, count, format), not the C (type, datano_s,
    // datano_e, length). Measured 2026-11-12 on the 31i at 10.192.233.166: asking for
    // (1, 3, 2) returned 216 bytes decoding as 903/28000/"(19237-0903_REVC_150670003)",
    // 8000/500/"(RENISHAW VECTOR CAL)", 8001/1500/"()"; the C argument order is
    // answered EW_ATTRIB. See docs/notes.md.
    //
    // The loop is bounded three ways because a controller that keeps answering with a
    // short or malformed block would otherwise spin forever: a malformed frame ends it,
    // an empty page ends it, and a page that does not advance `start` ends it.
    async listprog(start = 1) {
        const ret = {};
        const PAGE = 19;                 // what the node has always asked for
        for (;;) {
            const st = await this._reqSingle(1, 1, 0x06, start, PAGE, 2);
            // A malformed frame is `len: -1`. The old test was `st.len < -1`, which is
            // never true, so a malformed reply fell through to the record loop, which
            // did not run, which left `start` where it was — an infinite request loop.
            if (st.len < 0) return Object.keys(ret).length ? ret : null;
            if (st.len === 0) return ret;

            const records = Math.floor(st.len / PROGDIR_RECORD_BYTES);
            let advanced = false;
            for (let t = 0; t + PROGDIR_RECORD_BYTES <= st.len; t += PROGDIR_RECORD_BYTES) {
                const number = st.data.readUInt32BE(t);
                let comment  = st.data.slice(t + 8, t + PROGDIR_RECORD_BYTES);
                const nullIdx = comment.indexOf(0);
                if (nullIdx !== -1) comment = comment.slice(0, nullIdx);
                // latin1, not ascii: the comment is whatever the CNC's language setting
                // writes, and ascii decoding turns every non-ASCII byte into '?'.
                ret[number] = { comment: comment.toString('latin1') };
                if (number + 1 > start) { start = number + 1; advanced = true; }
            }
            // A page that did not move `start` forward would re-request the same block.
            if (!advanced) return ret;
            // A short page is the last one. This has to be checked on the record count,
            // not on the byte length: a page of 19 records is 1368 bytes, and comparing
            // the byte length against PAGE would never match.
            if (records < PAGE) return ret;
        }
    }

    async readparam3(axis, first, last = 0) {
        if (last === 0) last = first;
        // Try 0x8d (0i/30i), fall back to 0x0e (16/18/21i) if response empty
        let st = await this._reqSingle(1, 1, 0x8d, first, last, axis);
        if (st.len <= 0) {
            st = await this._reqSingle(1, 1, 0x0e, first, last, axis);
        }
        if (st.len <= 0) return null;
        return parseParamBody(st.data, this.sysinfo.maxaxis);
    }

    async readactfeed() {
        const st = await this._reqSingle(1, 1, 0x24);
        return (st.len === 8) ? decode8(st.data) : null;
    }

    async readactspindlespeed() {
        const st = await this._reqSingle(1, 1, 0x25);
        return (st.len === 8) ? decode8(st.data) : null;
    }

    /**
     * cnc_rdalmmsg (0x23) — the alarm messages currently arising on the CNC.
     *
     * `type` is an alarm *category*, not a bitmask, and the enum is different on every
     * CNC series (FOCAS2 spec: Document/SpecE/Misc/cnc_rdalmmsg.xml). -1 means "all type"
     * on all series, which is what callers almost always want.
     *
     * The wire record is (16 + textlength) bytes — alm_no(i32) type(i32) axis(i32)
     * msg_len(i32) text. The C ODBALMMSG struct is only 44 bytes because the three short
     * attribute fields are widened to 4 bytes and `dummy` is dropped on the wire.
     *
     * **The text field is capped at 32 characters.** The spec says so outright and points
     * at cnc_rdalmmsg2 for the 30i family; this call has no text-length argument in its C
     * signature at all. The old code sent a fourth argument asking for 64 and computed a
     * 80-byte stride from it, which would misalign every record if the controller ignored
     * the argument and answered 32 — silently, because nothing checked that the payload
     * divided by the stride. The stride is now validated instead.
     *
     * Throws on a real FOCAS error (e.g. EW_ATTRIB for an out-of-range type) rather than
     * returning [] — an empty array means "no alarms", nothing else.
     */
    async readalarmcode(type = -1, withtext = 1, maxmsgs = -1, textlength = ALM_TEXT_MAX) {
        if (maxmsgs <= 0) maxmsgs = (this.sysinfo && this.sysinfo.maxaxis) || 32;
        // Clamp rather than trust the caller: anything above 32 is not this function.
        const textlen = Math.min(Math.max(1, textlength | 0), ALM_TEXT_MAX);
        const st = await this._reqSingle(1, 1, 0x23, type, maxmsgs, withtext, textlen);
        if (st.len < 0)
            throw new Error(reqErr('cnc_rdalmmsg', st));
        if (st.len === 0) {
            // _reqSingle omits `error` entirely for a clean success carrying no data.
            if (st.error !== undefined)
                throw new Error(reqErr('cnc_rdalmmsg', st, `for type=${type}`));
            return [];
        }
        const stride = 4 * 4 + textlen;
        // A payload that is not a whole number of records means the layout is not what
        // this decoder assumes. Say so instead of slicing plausible-looking garbage.
        if (st.len % stride !== 0)
            throw new Error(
                `cnc_rdalmmsg: ${st.len} bytes is not a whole number of ` +
                `${stride}-byte alarm records (type=${type}, textlen=${textlen})`
            );
        const ret = [];
        for (let pos = 0; pos + stride <= st.len; pos += stride) {
            const entry = {
                alarmcode: st.data.readInt32BE(pos),
                alarmtype: st.data.readInt32BE(pos + 4),
                axis:      st.data.readInt32BE(pos + 8),
            };
            const txlen = st.data.readInt32BE(pos + 12);
            if (txlen > 0 && withtext > 0) {
                let text = st.data.slice(pos + 16, pos + 16 + textlen);
                const nullIdx = text.indexOf(0);
                if (nullIdx !== -1) text = text.slice(0, nullIdx);
                // latin1, not ascii: the spec says the message is Shift-JIS, GB2312,
                // Code Page 949/1251/1254 or Western European depending on the CNC's
                // language setting, and ascii decoding turns every one of those into '?'.
                entry.text = text.toString('latin1').trim();
            } else {
                entry.text = '';
            }
            ret.push(entry);
        }
        return ret;
    }

    /**
     * cnc_alarm (0x1a) — the CNC's alarm *status* word, as opposed to the alarm
     * messages readalarmcode() returns. This is the cheap "is anything wrong"
     * poll: one request, no text.
     *
     * The bit meanings are per-series and are the same table cnc_rdalmmsg's `type`
     * indexes (SpecE/Misc/cnc_alarm.xml) — e.g. #07 is PMC error (PC) and #08 is
     * external alarm message (EX) on Series 15i, while 30i puts EX at #15 and
     * PMC error at #19. Nothing here labels them; the node layer owns the tables.
     *
     * The wire block is 4 bytes — ODBALM's `short dummy[2]` is dropped and `data` is
     * widened to a long, the same treatment ODBALMMSG gets in readalarmcode. Only the
     * low 16 bits are kept, because ODBALM.data is a short; use readalarmstatus2()
     * when the upper half matters.
     */
    async readalarmstatus() {
        return this._readalmstat('cnc_alarm', 0xffff);
    }

    /**
     * cnc_alarm2 — the same status word, all 32 bits.
     *
     * This is the one to use on Series 15i, 30i, 0i-D/F and PMi-A: cnc_alarm's 16-bit
     * struct cannot carry the upper alarm bits there (SpecE/Misc/cnc_alarm2.xml),
     * which is the whole reason the second API exists. On the wire it is not a second
     * function — the library sends the identical 0x1a request for both and the
     * difference is only the width the caller asked for.
     */
    async readalarmstatus2() {
        return this._readalmstat('cnc_alarm2', 0xffffffff);
    }

    async _readalmstat(fnName, mask) {
        const st = await this._reqSingle(1, 1, FN_ALARM);
        if (st.len < 0) throw new Error(reqErr(fnName, st));
        if (st.len === 0) {
            // As in readalarmcode: a clean success carrying no data omits `error`.
            if (st.error !== undefined) throw new Error(reqErr(fnName, st));
            return { status: 0, bits: [] };
        }
        // A 2-byte block is the C width, which the capture says this controller does
        // not use — accept it anyway rather than misread a short as the low half.
        const word = st.len >= 4
            ? st.data.readUInt32BE(st.len - 4)
            : st.data.readUInt16BE(0);
        const status = (word & mask) >>> 0;
        const bits = [];
        for (let i = 0; i < 32; i++) if (status & (1 << i)) bits.push(i);
        return { status, bits };
    }

    /**
     * pmc_rdalmmsg (0x8010) — the PMC's *own* alarm messages: the ERxx/WNxx rows of
     * the vendor library's fwpmcalm.ini (ROM parity, I/O allocation errors, ladder
     * size errors, …). These are the PMC software/hardware failing, NOT the ladder's
     * external (EX) messages — those arrive as alarms on the CNC and are read with
     * readalarmcode(). The text is served by the library from that ini, so the
     * message bodies live on the PC, not on the machine.
     *
     * `sNumber` is the 1-based alarm to start at and `readNum` how many to ask for.
     * The reply opens with the two in/out parameters the C API hands back, as two
     * longs: read_num (how many records follow) and `exist`. Records are sliced out
     * of whatever is left, so their width never has to be assumed — but the width is
     * also not confirmed, because the capture machine had no PMC alarm to read.
     *
     * Returns { alarms, read_num, exist, more }. Page by calling again with
     * `sNumber + read_num` while `more` is true (FwSymbol.h: PMC_ALARM_STILL).
     */
    async readpmcalarm(sNumber = 1, readNum = 10) {
        const st = await this._reqSingle(PMC_RDALMMSG_C1, PMC_RDALMMSG_C2,
                                        FN_PMC_RDALMMSG, sNumber, readNum);
        // PMC calls answer with the PMC status table, not the CNC one — EW_NOPMC (1),
        // EW_RANGE (3) and EW_TYPE (4) mean something else there.
        if (st.len < 0) throw new Error(reqErr('pmc_rdalmmsg', st, '', PMC_ERRORS));
        if (st.len === 0) {
            if (st.error !== undefined) throw new Error(reqErr('pmc_rdalmmsg', st, '', PMC_ERRORS));
            return { alarms: [], read_num: 0, exist: PMC_ALARM_NO, more: false };
        }
        if (st.len < 8)
            throw new Error(`pmc_rdalmmsg: ${st.len}-byte reply, expected at least the ` +
                            '8-byte read_num/exist header');
        const readNumGot = st.data.readInt32BE(0);
        const exist      = st.data.readInt32BE(4);
        const body       = st.data.slice(8);
        const stride     = readNumGot > 0 ? Math.floor(body.length / readNumGot) : 0;

        const alarms = [];
        for (let i = 0; i < readNumGot && stride > 0; i++) {
            let text = body.slice(i * stride, (i + 1) * stride);
            const nullIdx = text.indexOf(0);
            if (nullIdx !== -1) text = text.slice(0, nullIdx);
            // latin1: the message comes from fwpmcalm.ini, which is not ASCII-only.
            alarms.push({ message: text.toString('latin1').trim() });
        }
        return { alarms, read_num: readNumGot, exist, more: exist === PMC_ALARM_STILL };
    }

    // ── Axes position data ────────────────────────────────────────────────────
    // what bitmask: ABS=1, REL=2, REF=4 (machine pos), DIST=16
    async readaxes(what = 1, axis = ALLAXIS) {
        const axvalues = [
            { name:'ABS',  flag:1,  sub:4 },
            { name:'REL',  flag:2,  sub:6 },
            { name:'REF',  flag:4,  sub:1 },
            { name:'SKIP', flag:8,  sub:8 },
            { name:'DIST', flag:16, sub:7 },
        ];
        const cmds = axvalues
            .filter(a => what & a.flag)
            .map(a => {
                const b = Buffer.alloc(26);
                b.writeUInt16BE(1, 0); b.writeUInt16BE(1, 2); b.writeUInt16BE(0x26, 4);
                b.writeInt32BE(a.sub, 6); b.writeInt32BE(axis, 10);
                return b;
            });
        if (cmds.length === 0) return null;
        const st = await this._reqMulti(cmds);
        if (!st || st.len < 0) return null;

        // The CNC sizes every block for the maximum axis count and leaves the slots
        // past the axes it actually controls undefined — the spec says only "the data
        // for current controlled axes are valid". Those slots still carry a decimal
        // flag, so decoding them yields plausible-looking numbers that are not
        // positions (the official library hands back the same integers at the same
        // indices and leaves it to the caller not to look at them). Bound the sweep
        // by the real axis count, never by the buffer length.
        const recs = axis === ALLAXIS ? await this.readaxiscount(AXNUM_SERVO) : 1;

        const result = {};
        let idx = 0;
        for (const a of axvalues) {
            if (!(what & a.flag)) continue;
            const d = st.data[idx++];
            if (!d || d[0] !== 0) { result[a.name] = null; continue; }
            const body = d[1];
            const vals = [];
            for (let p = 0; p + 8 <= body.length && vals.length < recs; p += 8)
                vals.push(decode8(body.slice(p, p + 8)));
            result[a.name] = vals;
        }
        return result;
    }

    // ── Macro variables ───────────────────────────────────────────────────────
    // cnc_rdmacro's second argument is an END variable number, not a count: the vendor
    // library sends `0x15 args=<number> <number>` for a single read (captured with
    // tools/probe-dll-param.py on the 31i at 10.192.233.166, 2026-11-12), and the raw
    // wire answers `(100, 100)` with one record and `(100, 101)` with two. Sending a
    // count instead — `(100, 10)` — is answered with a malformed frame.
    //
    // The record is the same 8-byte shape decode8() handles: mcr_val(i32) |
    // format(i16) | dec_val(i16). Measured: `07 27 0e 00 00 0a 00 05` = 120000000 at
    // dec 5 = 1200, and a vacant variable is `00 00 00 00 00 0a ff ff` = dec -1, which
    // decode8() already reports as null.
    async readmacro(first, last = 0) {
        if (last === 0) last = first;
        const st = await this._reqSingle(1, 1, 0x15, first, last);
        if (st.len <= 0) return null;
        const r = {};
        let n = first;
        for (let pos = 0; pos + 8 <= st.len; pos += 8) {
            r[n++] = decode8(st.data.slice(pos, pos + 8));
        }
        return r;
    }

    // ── Load meters ───────────────────────────────────────────────────────────
    // Each 8-byte record holds value(i32 BE) then the decimal position(i16 BE) at +6,
    // so the reading is value / 10^dec — the official library reports dec=0 for a
    // load meter (unit: 0 = %, 1 = rpm). The response is always sized for the maximum
    // axis count, not the live one, and the tail beyond the real axes is stale buffer
    // contents, so the count from cnc_rdaxisnum — never maxaxis — bounds the loop.
    _loadReadings(data, stride, count) {
        const out = [];
        for (let i = 0; i < count && (i + 1) * stride <= data.length; i++) {
            const value = data.readInt32BE(i * stride);
            const dec   = data.readInt16BE(i * stride + 6);
            out.push(value / Math.pow(10, dec));
        }
        return out;
    }

    async readaxiscount(type) {
        const st = await this._reqSingle(1, 1, FN_AXISNUM, type);
        if (st.len < 2) throw new Error(reqErr('cnc_rdaxisnum', st, `for type=${type}`));
        return st.data.readInt16BE(0);
    }

    // One record per servo axis, reported as a magnitude. The reading selector picks the
    // unit and the controller reports the matching decimal position with it — LOAD gives
    // dec 0 (per cent), CURRENT gives dec 2, so the Ampere value arrives as a hundredth.
    async readsvmeter(reading = SVMETER_LOAD) {
        const count = await this.readaxiscount(AXNUM_SERVO);
        const st = await this._reqSingle(1, 1, FN_SVMETER, reading);
        if (st.len <= 0) throw new Error(reqErr('cnc_rdsvmeter', st, `for reading=${reading}`));
        return this._loadReadings(st.data, LOADELM_STRIDE, count).map(Math.abs);
    }

    // Two records per spindle (load meter, then motor speed); only the named one is kept.
    // Reported as a magnitude like the servo meter: the readings are signed on the wire
    // (measured 2026-11-12 on the 31i at 10.192.233.166 — `0x56[1]` answered
    // -12, 33, -10, 0, -24), and a regenerating spindle should not read negative here
    // while the servo meter reads positive.
    async readspmeter(type = SPMETER_LOAD) {
        const count = await this.readaxiscount(AXNUM_SPINDLE);
        const st = await this._reqSingle(1, 1, FN_SPMETER, type, ALLAXIS);
        if (st.len <= 0) throw new Error(reqErr('cnc_rdspmeter', st, `for type=${type}`));
        return this._loadReadings(st.data, SPMETER_STRIDE, count).map(Math.abs);
    }

    // ── Tool offsets (read-only) ──────────────────────────────────────────────
    // Tool compensation is a separate CNC option on some machines; without it these
    // answer EW_NOOPT (6) and the caller sees that rather than a table of zeroes.
    //
    // Only the READ side is implemented. The write calls (cnc_wrtofs 0x09,
    // cnc_wrtofsr, cnc_wrzofs 0x0c) are deliberately absent: a wrong write opcode
    // changes a machine's offsets, and none of them has been captured. See
    // docs/notes.md before adding one.

    // cnc_rdtofsinfo — the offset table's shape. The wire is 8 bytes of four shorts,
    // NOT two longs: `00 00 00 63 00 02 00 00` reads as ofs_type 0 (memory A) and
    // use_no 99, which is what the spec's enum allows. Read as two longs it would say
    // ofs_type 99 — a value the enum does not contain — so the shorts are the right
    // reading. Measured 2026-11-13 on the 31i at 10.192.233.166.
    async readtofsinfo() {
        const st = await this._reqSingle(1, 1, FN_RDTOFSINFO);
        if (st.error !== undefined || st.len < 4)
            throw new Error(reqErr('cnc_rdtofsinfo', st));
        const ofsType = st.data.readInt16BE(0);
        const useNo   = st.data.readInt16BE(2);
        return {
            ofs_type: ofsType,
            // 0 = memory A, 1 = memory B, 2 = memory C, 10 = milling+turning (30i).
            memory:   ofsType === 10 ? 'milling+turning' : `memory ${'ABC'[ofsType] ?? '?'}`,
            use_no:   useNo,
        };
    }

    // cnc_rdtofs — one offset value. The third argument is 1000 + type, not a length:
    // the vendor library sends `args=1 1 1002` for cnc_rdtofs(1, type=2).
    //
    // The reply is ONE 8-byte record — value(i32) | dec(i16) | unit(i16) — with no
    // header, not ODBTOFS's `short datano | short type | long data`. Measured:
    // number=1 type=3 → 129.907 mm (tool length geometry).
    async readtofs(number, type = 0) {
        const st = await this._reqSingle(1, 1, FN_RDTOFS, number, number,
                                         TOFS_SINGLE_BASE + type);
        if (st.error !== undefined)
            throw new Error(reqErr('cnc_rdtofs', st, `for number=${number} type=${type}`));
        if (st.len < TOFS_RECORD_BYTES)
            throw new Error(reqErr('cnc_rdtofs', st, `for number=${number} type=${type}`));
        return this._tofsRecord(st.data, 0);
    }

    // cnc_rdtofsr — a range of offsets, same opcode 0x08 with the (s, e, type) pattern.
    // The reply is a plain run of 8-byte records with NO header — IODBTO's
    // `datano_s | type | datano_e` prefix is not on the wire. Reading a header out of
    // the first record turns the first offset into a "datano" and shifts every value
    // after it, and the numbers still look plausible, so the count is taken from the
    // payload length and nothing else.
    //
    // NOTE the range form's `type` numbering is NOT the single form's: measured on the
    // same machine, range type 0 returned the same values as single type 3. Callers
    // that want the spec's enum should use readtofs() per number.
    async readtofsr(sNumber, eNumber, type = 0) {
        const st = await this._reqSingle(1, 1, FN_RDTOFS, sNumber, eNumber, type);
        if (st.error !== undefined)
            throw new Error(reqErr('cnc_rdtofsr', st,
                `for s=${sNumber} e=${eNumber} type=${type}`));
        if (st.len < TOFS_RECORD_BYTES)
            throw new Error(reqErr('cnc_rdtofsr', st,
                `for s=${sNumber} e=${eNumber} type=${type}`));
        const n = Math.floor(st.len / TOFS_RECORD_BYTES);
        const out = [];
        for (let i = 0; i < n; i++) out.push(this._tofsRecord(st.data, i * TOFS_RECORD_BYTES));
        return out;
    }

    // One 8-byte offset record: value(i32) | dec(i16) | unit(i16). The unit word read
    // 10 on every record measured, which is not the LOADELM unit enum — it is carried
    // through raw rather than interpreted.
    _tofsRecord(data, off) {
        const raw  = data.readInt32BE(off);
        const unit = data.readInt16BE(off + 4);
        const dec  = data.readInt16BE(off + 6);
        return { value: raw / Math.pow(10, dec), raw, dec, unit };
    }

    // The offset types this machine's M/T mode actually has, for labelling a payload.
    // The enum is per-series (cnc_rdtofs.xml); the controller's mt_type picks it.
    tofsTypeName(type) {
        const t = String((this.sysinfo && this.sysinfo.mttype) || '').trim();
        const table = t === 'T' || t === 'TT' || t === 'MT' ? TOFS_TYPES_T : TOFS_TYPES_M;
        return table[type] ?? `type ${type}`;
    }

    // ── Axis / spindle names ──────────────────────────────────────────────────
    // 4-byte records with the name in byte 0 ("X", "S"); the remaining bytes are
    // not useful on the wire. Measured 2026-11-12 on the 31i at 10.192.233.166:
    // 0x89 answered `58 00 6e 10 | 59 00 6e 10 | ...` = X, Y, Z, B, X2 at 4 bytes each.
    //
    // `data_num` is sent as 0, which is what the vendor library puts on the wire for
    // both calls (captured with tools/probe-dll-param.py: `0x89 args=0 0 0 0 0`). The
    // spec says 0 or less is EW_LENGTH, but this controller answers 0 with every name
    // and rejects the real count — `0x89[5]` on a 5-axis machine is EW_ATTRIB (4) — so
    // 0 is the form that works. The count only bounds how many records are kept.
    _names(st, count) {
        if (!st || st.len <= 0) return [];
        const n = Math.min(count, Math.floor(st.data.length / 4));
        const out = [];
        for (let i = 0; i < n; i++)
            out.push(st.data.slice(i * 4, i * 4 + 4).toString('latin1').split('\0')[0].trim());
        return out;
    }

    async readaxisnames(count) {
        return this._names(await this._reqSingle(1, 1, FN_SVNAME, 0), count);
    }

    async readspindlenames(count) {
        return this._names(await this._reqSingle(1, 1, FN_SPNAME, 0), count);
    }

    async readservoload() {
        return this.readsvmeter();
    }

    async readservocurrent() {
        return this.readsvmeter(SVMETER_CURRENT);
    }

    async readspindleload() {
        const values = await this.readspmeter();
        return values.length ? values[0] : null;
    }

    // ── Tool life ─────────────────────────────────────────────────────────────
    // Tool-life management is a separate CNC option. When it is off the controller
    // answers every call below with EW_NOOPT (6) — and answers it rather than
    // returning zeroes — so these throw instead of degrading to an empty table,
    // which is what makes "no option" distinguishable from "no tools registered".

    // cnc_rdtlinfo — management limits, used to size the group read and to compute
    // usage percentages. The block opens with one long that is not part of ODBTLINFO,
    // so the four limits start at +4 (checked against a run where the grouping of
    // 30/128/8/60000 only lines up this way). Re-measured 2026-11-12 on the 31i at
    // 10.192.233.166: 20 bytes, `14 | 100 | 4 | 100000 | 99999999`.
    //
    // A 16-byte reply is the C ODBTLINFO with no leading long. Accept it rather than
    // reporting a malformed frame — the two layouts differ only by that prefix.
    async readtlinfo() {
        const st = await this._reqSingle(1, 1, FN_RDTLINFO);
        if (st.error !== undefined || st.len < 16)
            throw new Error(reqErr('cnc_rdtlinfo', st));
        const d = st.data;
        const off = st.len >= ODBTLINFO_BYTES ? 4 : 0;
        return {
            max_group:  d.readInt32BE(off),
            max_tool:   d.readInt32BE(off + 4),
            max_minute: d.readInt32BE(off + 8),
            max_cycle:  d.readInt32BE(off + 12),
        };
    }

    // cnc_rdngrp — how many tool groups have at least one tool registered. The count is
    // the first long; reading at +4 (the C struct's `dummy[2]` offset) returns the max
    // group count instead. Measured 2026-11-12 on the 31i at 10.192.233.166: 20 bytes,
    // `14 | 100 | 4 | 100000 | 99999999` — the same block cnc_rdtlinfo returns.
    //
    // The C ODBTLIFE2 is `short dummy[2]` + `long data`, i.e. 8 bytes with the count at
    // +4. A controller that answers that shape would have its count read as 0 here, so
    // the 8-byte form is decoded at +4 instead of being silently reported as "no groups".
    async readngrp() {
        const st = await this._reqSingle(1, 1, FN_RDNGRP);
        if (st.error !== undefined || st.len < ODBTLIFE2_BYTES)
            throw new Error(reqErr('cnc_rdngrp', st));
        return st.data.readInt32BE(st.len >= ODBTLINFO_BYTES ? 0 : 4);
    }

    // cnc_rdusegrpid — the group currently in use, the next one, and the selected one.
    // The wire is just three longs: ODBUSEGR's leading `datano`/`type` are documented
    // "not used" and are not sent, so next/use/slct start at +0 (+4/+8/+12 would run off
    // the end of the 12-byte payload). Measured 2026-11-12 on the 31i at
    // 10.192.233.166: 12 bytes, `0 | 2 | 2`.
    //
    // A 16-byte reply is the C ODBUSEGR with its two leading shorts. Decoding that at +0
    // would report `datano|type` as the next group, so the width picks the offset.
    async readusegrpid() {
        const st = await this._reqSingle(1, 1, FN_RDUSEGRPID);
        if (st.error !== undefined || st.len < ODBUSEGR_BYTES)
            throw new Error(reqErr('cnc_rdusegrpid', st));
        const d = st.data;
        const off = st.len >= 16 ? 4 : 0;
        return {
            next: d.readInt32BE(off),
            use:  d.readInt32BE(off + 4),
            slct: d.readInt32BE(off + 8),
        };
    }

    // cnc_rdgrpinfo4 — one IODBTGI4 record per group, ascending from grpNo. The
    // struct is fixed-length (no trailing var array), so reading a whole block in
    // one call is safe. Keep numToRead at or below TOOL_GROUP_PAGE: the controller
    // rejects a large read outright (see that constant), so callers that want every
    // group should page through with grpNo rather than ask for a big number once.
    async readgrpinfo4(grpNo = 1, numToRead = TOOL_GROUP_PAGE) {
        const st = await this._reqSingle(1, 1, FN_RDGRPINFO4, grpNo, 0, numToRead);
        if (st.error !== undefined || st.len <= 0)
            throw new Error(reqErr('cnc_rdgrpinfo4', st));
        if (st.len % IODBTGI4_BYTES !== 0)
            throw new Error(
                `cnc_rdgrpinfo4: ${st.len} bytes is not a whole number of ` +
                `${IODBTGI4_BYTES}-byte group records`
            );
        const groups = [];
        for (let p = 0; p + IODBTGI4_BYTES <= st.data.length; p += IODBTGI4_BYTES) {
            groups.push({
                // grp_no is a 4-byte long on the wire, not the C struct's short: reading
                // 16 bits there returns the top half of the number (0 for groups 1..255).
                grp_no:      st.data.readInt32BE(p),
                n_tool:      st.data.readInt32BE(p + 4),
                count_value: st.data.readInt32BE(p + 8),
                counter:     st.data.readInt32BE(p + 12),
                count_type:  st.data.readInt32BE(p + 16),
                opt_grpno:   st.data.readInt32BE(p + 20),
                life_rest:   st.data.readInt32BE(p + 24),
            });
        }
        return groups;
    }

    // ── Tier-1/2 reads ────────────────────────────────────────────────────────
    // All read-only. None of them pauses CNC-side history sampling — see the
    // function-code block near the top of this file for the audit that established
    // that, and docs/notes.md for the measured layouts.

    /**
     * cnc_rdcncid (0x0e8) — the machine's stable identity: four unsigned longs.
     *
     * This is the only identifier here that survives a software upgrade, so it is
     * what a multi-machine deployment should key on. `cnc_sysinfo`'s series/version
     * are shared by every machine of the same model.
     *
     * The wire is 16 bytes and DOES match the C struct — unusual for this project.
     */
    async readcncid() {
        const st = await this._reqSingle(1, 1, FN_RDCNCID);
        if (st.error !== undefined) throw new Error(reqErr('cnc_rdcncid', st));
        if (st.len < 16)
            throw new Error(`cnc_rdcncid: ${st.len}-byte reply, expected 16`);
        const id = [0, 1, 2, 3].map(i => st.data.readUInt32BE(i * 4));
        return {
            // Hex is the form to quote in a ticket; decimal is what the SDK returns.
            hex:     id.map(v => v.toString(16).padStart(8, '0')).join('-'),
            values:  id,
        };
    }

    /**
     * cnc_rdzofsinfo (0x0d) — how many work-zero offsets the table has.
     *
     * The wire answers 4 bytes (one long), not `sizeof(short)`: the same widening
     * cnc_rdtofsinfo shows. Measured 307 on the 31i at 10.192.232.189.
     */
    async readzofsinfo() {
        const st = await this._reqSingle(1, 1, FN_RDZOFSINFO);
        if (st.error !== undefined || st.len < 4)
            throw new Error(reqErr('cnc_rdzofsinfo', st));
        return { use_no: st.data.readInt32BE(0) };
    }

    /**
     * cnc_rdzofs (0x0b) — one work-zero offset value.
     *
     * The wire arguments are (number, number, axis): the second slot REPEATS the
     * offset number, the same shape cnc_rdparam3 uses. Sending the C order
     * (number, axis, length) is answered EW_ATTRIB, which is what made this look
     * unimplementable until the capture showed the repeat.
     *
     * The reply is one 8-byte value(i32) | unit(i16) | dec(i16) record with no
     * header, not the IODBZOFS C struct.
     */
    async readzofs(number, axis) {
        const st = await this._reqSingle(1, 1, FN_RDZOFS, number, number, axis);
        if (st.error !== undefined)
            throw new Error(reqErr('cnc_rdzofs', st, `for number=${number} axis=${axis}`));
        const rec = decodeZofsRecord(st.data || Buffer.alloc(0));
        if (!rec)
            throw new Error(reqErr('cnc_rdzofs', st, `for number=${number} axis=${axis}`));
        return { number, axis, ...rec };
    }

    /**
     * cnc_rdseqnum (0x1d) — the sequence number of the block being executed.
     *
     * A program with no N numbers leaves this at the last one it saw, so it is a
     * progress hint, not an exact position. The wire is one long; ODBSEQ's
     * `dummy[2]` is dropped.
     */
    async readseqnum() {
        const st = await this._reqSingle(1, 1, FN_RDSEQNUM);
        if (st.error !== undefined || st.len < 4)
            throw new Error(reqErr('cnc_rdseqnum', st));
        return st.data.readInt32BE(0);
    }

    /**
     * cnc_rdcommand (0x97) — modal or commanded F/S/T/B.
     *
     * `type` -1 reads all modal data, -2 all commanded data; 0..29 and 100..129 read
     * one item each. `block` 0/1/2 is previous/active/next.
     *
     * Each record carries `present`, taken from flag bit 0x0800, which is set on every
     * populated record and clear on the empty M2..M5 slots. That is what separates
     * "no command" from "command is zero" — the distinction the payload contract
     * requires, and the reason this returns records rather than a flat map.
     *
     * Not available on Series 15, 16i/18i/21i, 0i-A/B/C or Power Mate i; those need
     * cnc_modal, which is a different struct and a different type enum.
     */
    async readcommand(type = -1, block = 1) {
        const st = await this._reqSingle(1, 1, FN_RDCOMMAND, type, block);
        if (st.error !== undefined) throw new Error(reqErr('cnc_rdcommand', st, `for type=${type}`));
        if (st.len <= 0) return [];
        if (st.len % ODBCMD_BYTES !== 0)
            throw new Error(
                `cnc_rdcommand: ${st.len} bytes is not a whole number of ` +
                `${ODBCMD_BYTES}-byte ODBCMD records (type=${type})`
            );
        return decodeCommand(st.data);
    }

    /**
     * cnc_rdproginfo (0x07) — program memory: registered/available programs and
     * used/unused memory.
     *
     * The request puts NO arguments on the wire — the type and length are
     * library-side. The reply is 16 bytes: a 4-byte prefix then
     * reg_prg(i16) | unreg_prg(i16) | used_mem(i32) | unused_mem(i32).
     */
    async readproginfo() {
        const st = await this._reqSingle(1, 1, FN_RDPROGINFO);
        if (st.error !== undefined) throw new Error(reqErr('cnc_rdproginfo', st));
        const info = decodeProgramInfo(st.data || Buffer.alloc(0));
        if (!info) throw new Error(`cnc_rdproginfo: ${st.len}-byte reply, expected ${ODBNC_BYTES}`);
        return info;
    }

    /**
     * cnc_rdpm_item (0xbe) — the CNC's maintenance items (1..10).
     *
     * Each record is name[64] | type | total | remain | stat = 80 bytes. The C struct
     * declares name[62]; the wire pads it to 64, which is why the stride is 80.
     *
     * `total`/`remain` are in the unit `type` selects (0 invalid, 1 all-time, 2 power-on,
     * …) and the interface does not return that unit, so the raw numbers are kept.
     */
    async readpm_item(start = 1, num = 10) {
        const st = await this._reqSingle(1, 1, FN_RDPM_ITEM, start, num);
        if (st.error !== undefined) throw new Error(reqErr('cnc_rdpm_item', st));
        if (st.len <= 0) return [];
        if (st.len % IODBPMAINTE_BYTES !== 0)
            throw new Error(
                `cnc_rdpm_item: ${st.len} bytes is not a whole number of ` +
                `${IODBPMAINTE_BYTES}-byte IODBPMAINTE records`
            );
        return decodeMaintenanceItems(st.data);
    }

    /**
     * cnc_rdblkcount (0x35) — the block counter.
     *
     * Needs the program-restarting option; without it the controller answers
     * EW_NOOPT (6), which is "not fitted", not a fault.
     */
    async readblkcount() {
        const st = await this._reqSingle(1, 1, FN_RDBLKCOUNT);
        if (st.error !== undefined || st.len < 4)
            throw new Error(reqErr('cnc_rdblkcount', st));
        return st.data.readInt32BE(0);
    }

    /**
     * cnc_gettimer (0x45) — the CNC calendar.
     *
     * Date and time are two calls, and each fills only its own half of the 12-byte
     * reply; the other half keeps whatever was in the buffer. So this reads `type=0`
     * for the date and `type=1` for the time and takes each from the call that asked
     * for it. Reading one type twice does not work — the unasked half is never filled.
     *
     * The CNC clock carries no timezone. Do not label it UTC or local.
     */
    async gettimer() {
        const d = await this._reqSingle(1, 1, FN_GETTIMER, 0);
        if (d.error !== undefined) throw new Error(reqErr('cnc_gettimer', d, 'for type=0 (date)'));
        const t = await this._reqSingle(1, 1, FN_GETTIMER, 1);
        if (t.error !== undefined) throw new Error(reqErr('cnc_gettimer', t, 'for type=1 (time)'));

        const date = decodeTimerDate(d.data || Buffer.alloc(0));
        const time = decodeTimerTime(t.data || Buffer.alloc(0));
        if (!date || !time)
            throw new Error(`cnc_gettimer: ${d.len}/${t.len}-byte reply, expected ${IODBTIMER_BYTES}`);
        return { ...date, ...time };
    }

    /**
     * cnc_statinfo2 (0xe2 + 0xe1) — the extended run status.
     *
     * A COMPOSITE call: the library puts three sub-requests in one frame. **sub1
     * starts at `aut`**, not at `hdck` — its first seven shorts are byte-identical to
     * cnc_statinfo's seven, which is how the order was pinned. sub2 supplies
     * `hdck`/`tmmode`, the two fields ODBST2 declares first. 0x98 is not part of the
     * struct and is not requested.
     *
     * Only 0i-D/F and 30i-A/B support this; on 15/16/18/21/0i-A/B/C it is EW_FUNC.
     */
    async statinfo2() {
        const a = await this._reqSingle(1, 1, FN_STATINFO2_A);
        if (a.error !== undefined) throw new Error(reqErr('cnc_statinfo2', a, 'sub 0xe2'));
        const b = await this._reqSingle(1, 1, FN_STATINFO2_B);
        if (b.error !== undefined) throw new Error(reqErr('cnc_statinfo2', b, 'sub 0xe1'));
        if (a.len < 22 || b.len < 4)
            throw new Error(`cnc_statinfo2: ${a.len}+${b.len} bytes, expected 22+4`);

        // sub1: aut run motion mstb emergency alarm edit warning o3dchk ext_opt restart
        const w = [];
        for (let o = 0; o + 2 <= 22; o += 2) w.push(a.data.readInt16BE(o));
        const [aut, run, motion, mstb, emergency, alarm, edit,
               warning, o3dchk, ext_opt, restart] = w;
        // sub2: hdck tmmode — the two ODBST2 declares first.
        const hdck   = b.data.readInt16BE(0);
        const tmmode = b.data.readInt16BE(2);

        return { hdck, tmmode, aut, run, motion, mstb, emergency,
                 alarm, edit, warning, o3dchk, ext_opt, restart };
    }

    /**
     * pmc_rdpmcrng (0x8001) — the PMC data window.
     *
     * The command pair is 2/1, like pmc_rdalmmsg: the second word is a path/unit
     * selector, so 1/2 is answered EW_PATH (11) — a path error for a function with no
     * path argument. The wire arguments are (s_number, e_number, adr_type, data_type, 0)
     * and `length` never goes on the wire; the library computes it.
     *
     * `s`/`e` are BYTE addresses at every width, and the element count is
     * (e - s + 1) / width. This always reads at BYTE width and assembles wider values
     * in decodePmcBytes, because the byte path is little-endian within each 2-byte word
     * and mixing widths would mean carrying three ordering rules instead of one.
     *
     * `area` is one of PMC_AREAS' keys (G F Y X A R T K C D). `dataType` is
     * PMC_BYTE / PMC_WORD / PMC_LONG.
     */
    async readpmc(area, s, e, dataType = PMC_BYTE) {
        const adr = PMC_AREAS[area];
        if (adr === undefined)
            throw new Error(`pmc_rdpmcrng: unknown area ${JSON.stringify(area)}`);
        const width = PMC_WIDTH[dataType];
        if (width === undefined)
            throw new Error(`pmc_rdpmcrng: unknown data type ${dataType}`);
        if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s)
            throw new Error(`pmc_rdpmcrng: bad range ${s}..${e}`);
        if ((e - s + 1) % width !== 0)
            throw new Error(
                `pmc_rdpmcrng: ${e - s + 1} bytes is not a whole number of ` +
                `${width}-byte ${dataType === PMC_BYTE ? 'byte' : dataType === PMC_WORD ? 'word' : 'long'} values`
            );

        const st = await this._reqSingle(PMC_RDPMCRNG_C1, PMC_RDPMCRNG_C2,
                                         FN_PMC_RDPMCRNG, s, e, adr, PMC_BYTE, 0);
        // PMC calls answer with the PMC status table, not the CNC one.
        if (st.error !== undefined) throw new Error(reqErr('pmc_rdpmcrng', st, '', PMC_ERRORS));
        if (st.len <= 0) return [];
        if (st.len !== e - s + 1)
            throw new Error(
                `pmc_rdpmcrng: ${st.len} bytes for ${e - s + 1} addresses ` +
                `(${area}${s}..${area}${e})`
            );
        return decodePmcBytes(st.data, dataType);
    }
}

module.exports = {
    Focas, ALLAXIS, TOOL_GROUP_PAGE, ALM_TEXT_MAX, PMC_ERRORS, FOCAS_ERRORS,
    PMC_AREAS, PMC_BYTE, PMC_WORD, PMC_LONG,
};
