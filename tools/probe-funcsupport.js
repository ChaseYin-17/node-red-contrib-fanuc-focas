'use strict';
/**
 * tools/probe-funcsupport.js — which FOCAS function codes does this CNC actually answer?
 *
 * The node reports only the calls it already makes, and raises on a rejected one, so
 * asking a controller directly is the only way to tell "unsupported function" from
 * "empty result" from "layout mismatch" for a code the node does not send yet — and to
 * see the whole per-controller support map in one pass, from the EW_* status word.
 *
 * Every code below is one this node already issues for a READ (or is a documented read
 * entry point), so nothing here can modify the controller.
 *
 * Usage: node tools/probe-funcsupport.js [ip] [port] [--include-execprog]
 *
 * --include-execprog
 *     Adds cnc_rdexecprog (0x20). It is NOT in the default set: its spec page says the
 *     execution pointer moves to the next block under single-block operation, and that
 *     has not been disproved on a machine that could be watched. Do not pass this flag
 *     against a controller that is cutting. See docs/notes.md.
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);
const FLAGS = new Set(process.argv.slice(4).filter(a => a.startsWith('--')));
const INCLUDE_EXECPROG = FLAGS.has('--include-execprog');

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

// name, c3, args, c1, c2 — c1/c2 default to 1/1, which every CNC function here uses
// except the PMC ones. That pair is NOT a constant: pmc_rdalmmsg and pmc_rdpmcrng are
// both 2/1, and sending 1/2 is answered EW_PATH (11) — a path error for a function with
// no path argument. See docs/notes.md.
//
// There is no row for cnc_rdaxisdata: the 64-bit library has no opcode of its own for
// it. Captured with tools/probe-dll-opcode.py, cls=2 decomposes into 0xa4 + 0x89 +
// 0x56[type] — so its servo load meter is the 0x56 row below, and its "load current
// (Ampere)" is the same opcode with 3 in place of 1.
//
// The `node` column marks the calls fanuc-focas.js already makes, so a failure there is
// a regression rather than a new finding.
const CASES = [
    // ── already implemented in the node ──────────────────────────────────────
    ['cnc_rdprogdir   (listprog)',        0x06, [1, 3, 2],      1, 1, true],
    ['cnc_rdmacro     (readmacro)',       0x15, [1, 1],         1, 1, true],
    ['cnc_sysinfo',                       0x18, [],             1, 1, true],
    ['cnc_statinfo',                      0x19, [0],            1, 1, true],
    ['cnc_rdprgnum    (readprognum)',     0x1c, [],             1, 1, true],
    // 0x1a for both cnc_alarm and cnc_alarm2 — captured from the vendor library,
    // which sends a byte-identical request for the two (see focas.js). 0x22 used to
    // be listed here as cnc_alarm; that label was never verified and is wrong.
    ['cnc_alarm',                         0x1a, [0],            1, 1, true],
    ['cnc_rdalmmsg    (alarm_messages)',  0x23, [-1, 1, 1, 32],  1, 1, true],
    ['cnc_rdactfeed   (readactfeed)',     0x24, [],             1, 1, true],
    ['cnc_rdactspdspeed(readspindlespeed)',0x25, [],            1, 1, true],
    ['cnc_rddynamic2  (readaxes)',        0x26, [4, -1, 0, 0],  1, 1, true],
    ['cnc_rdspmeter   (spindle load, %)', 0x40, [0, -1],        1, 1, true],
    ['cnc_rdsvmeter   (servo load, %)',   0x56, [1],            1, 1, true],
    ['cnc_rdsvmeter   (load current, A)', 0x56, [3],            1, 1, true],
    // data_num is sent as 0 — that is what the vendor library puts on the wire, and
    // the real count is rejected (0x89[5] on a 5-axis machine is EW_ATTRIB). See
    // docs/notes.md.
    ['cnc_rdaxisname  (servo axis names)',0x89, [0],            1, 1, true],
    ['cnc_rdspdlname  (spindle names)',   0x8a, [0],            1, 1, true],
    ['cnc_rdaxisnum   (servo axcount)',   0xa4, [2],            1, 1, true],
    // cnc_rdparam3's wire arguments are (number, number, axis), not the C
    // (number, axis, length, absolute) — captured from the vendor library.
    ['cnc_rdparam3     (readparam3)',     0x8d, [6711, 6711, -1], 1, 1, true],
    // 0x0e is the 16/18/21i form of cnc_rdparam3, which the node tries only when 0x8d
    // comes back empty. EW_FUNC here on a 30i/0i-D is the expected answer, not a fault.
    ['cnc_rdparam      (readparam3 fall)',0x0e, [6711, 6711, -1], 1, 1, false],
    // Tool offsets. 0x08 is BOTH cnc_rdtofs and cnc_rdtofsr, told apart by the argument
    // pattern: (number, number, 1000+type) reads one, (s, e, type) reads a range.
    // Captured with tools/probe-dll-tofs.py — the 0x2c/0x2d/0x2e that look adjacent to
    // the other Ncdata reads are other functions and answer the same bytes for every
    // argument. See docs/notes.md.
    ['cnc_rdtofsinfo  (tool offsets)',    0x0a, [],             1, 1, true],
    ['cnc_rdtofs      (one offset)',      0x08, [1, 1, 1003],    1, 1, true],
    ['cnc_rdtofsr     (offset range)',    0x08, [1, 5, 0],       1, 1, true],
    // Tool life. All four need the CNC's "tool life management" option; without it
    // the controller answers EW_NOOPT (6) — the request itself is still correct.
    ['cnc_rdusegrpid  (tool life group)', 0x48,  [],            1, 1, true],
    ['cnc_rdngrp      (tool life count)', 0x4a,  [],            1, 1, true],
    ['cnc_rdgrpinfo4  (tool life groups)',0x1c1, [1, 0, 10],    1, 1, true],
    ['cnc_rdtlinfo    (tool life limits)',0x1c4, [],            1, 1, true],

    // ── tier-1/2 candidates: opcodes captured 2026-11-13 with
    //    `python tools/probe-dll-opcode.py --stub --tier12` (see docs/notes.md) ──
    //
    // None of these pauses CNC-side history sampling: their SpecE pages carry no
    // `stop sampling` / `cnc_stopophis` / `stop logging`. The functions that DO
    // (cnc_rdalmhistry*, cnc_rdophistry*, cnc_rdalmhisno, cnc_rdophisno4,
    // cnc_rdomhis*) are deliberately absent from this file.
    ['cnc_rdcncid      (machine id)',     0x0e8, [],            1, 1, false],
    ['cnc_rdzofsinfo   (work zero count)',0x0d,  [],            1, 1, false],
    // cnc_rdzofs's wire arguments are (number, number, axis) — the second slot repeats
    // the offset number, the same shape cnc_rdparam3 uses. The C order
    // (number, axis, length) is answered EW_ATTRIB; that is what made this look
    // unimplementable until the capture showed the repeat.
    ['cnc_rdzofs       (work zero offset)',0x0b, [1, 1, 1],     1, 1, false],
    ['cnc_rdseqnum     (sequence number)',0x1d,  [],            1, 1, false],
    ['cnc_rdcommand    (modal F/S/T)',    0x97,  [-1, 1],       1, 1, false],
    ['cnc_rdcommand    (commanded F/S/T)',0x97,  [-2, 1],       1, 1, false],
    // cnc_rdopmsg3's wire arguments are (0, type, 1): a leading zero, then the message
    // kind, then the count. The C signature is (type, *number, OPMSG3*).
    ['cnc_rdopmsg3     (operator message)',0x0d0, [0, -1, 1],   1, 1, false],
    // cnc_statinfo2 is a COMPOSITE call: one frame carrying three sub-requests
    // (0xe2, 0xe1, 0x98). Listed as three rows so a partial answer is visible.
    ['cnc_statinfo2    (ext status, sub1)',0x0e2, [],            1, 1, false],
    ['cnc_statinfo2    (ext status, sub2)',0x0e1, [],            1, 1, false],
    ['cnc_statinfo2    (ext status, sub3)',0x098, [],            1, 1, false],
    // cnc_rdproginfo puts NO arguments on the wire — the type/length are library-side.
    ['cnc_rdproginfo   (program memory)', 0x07,  [],            1, 1, false],
    ['cnc_rdpm_item    (maintenance)',    0x0be, [1, 10],       1, 1, false],
    // cnc_rdalminfo shares 0x23 with cnc_rdalmmsg: the library sends
    // (type=-1, maxmsgs, withtext, textlen). withtext=0 is the "without message" form.
    ['cnc_rdalminfo    (alarm detail)',   0x23,  [-1, 25, 0, 32], 1, 1, false],
    // cnc_rdspgear / cnc_rdspload / cnc_rdspmaxrpm are ALL 0x40 — the same opcode as
    // cnc_rdspmeter, selected by the first argument. 2 is the gear ratio; it is not in
    // cnc_rdspmeter's documented 0/1/-1 enum, so it is the one to watch here.
    ['cnc_rdspgear     (spindle gear)',   0x40,  [2, -1],       1, 1, false],
    ['cnc_rdspload     (spindle load)',   0x40,  [0, -1],       1, 1, false],
    ['cnc_rdspmaxrpm   (spindle max rpm)',0x40,  [1, -1],       1, 1, false],
    ['cnc_rdblkcount   (block counter)',  0x35,  [],            1, 1, false],
    ['cnc_gettimer     (calendar date)',  0x45,  [0],           1, 1, false],
    ['cnc_gettimer     (calendar time)',  0x45,  [1],           1, 1, false],
    // PMC data window. c1/c2 is 2/1 like pmc_rdalmmsg, and the wire arguments are
    // (s_number, e_number, adr_type, data_type, 0) — NOT the C order
    // (adr_type, data_type, s_number, e_number, length). length never goes on the wire.
    // adr_type 9 = D (data table), data_type 2 = word; D100..D103 is two words.
    ['pmc_rdpmcrng     (PMC D100 word)',  0x8001, [100, 103, 9, 2, 0], 2, 1, false],
    ['pmc_rdpmcrng     (PMC R0 bit)',     0x8001, [0, 0, 5, 1, 0],     2, 1, false],
];

// Opt-in only — see the header. Kept out of CASES so a plain run can never reach it.
const EXECPROG_CASE = ['cnc_rdexecprog   (executing block)', 0x20, [256, 0, 0, 0, 0], 1, 1, false];

(async () => {
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log(`connected to ${IP}:${PORT}   cnctype=${JSON.stringify(f.sysinfo.cnctype)}` +
                `  series=${JSON.stringify(f.sysinfo.series)}  maxaxis=${f.sysinfo.maxaxis}\n`);

    const cases = INCLUDE_EXECPROG ? CASES.concat([EXECPROG_CASE]) : CASES;
    if (INCLUDE_EXECPROG) {
        console.log('!! --include-execprog: cnc_rdexecprog may move the execution pointer.');
        console.log('!! Do not run this against a controller that is cutting.\n');
    }

    console.log('func    name                                    status      len  note');
    console.log('──────  ──────────────────────────────────────  ──────────  ───  ────');

    const results = [];
    for (const [name, c3, args, c1, c2, inNode] of cases) {
        let st;
        try {
            st = await f._reqSingle(c1, c2, c3, ...args);
        } catch (e) {
            console.log(`0x${c3.toString(16).padStart(4, '0')}  ${name.padEnd(38)}  THREW       -    ${e.message}`);
            results.push({ name, c3, c1, c2, err: 'THREW', len: -1, inNode });
            try { f.socket.removeAllListeners('data'); f.socket.removeAllListeners('error'); } catch (_) {}
            continue;
        }
        const err  = st.error !== undefined ? st.error : 0;
        const stat = `${FOCAS_ERRORS[String(err)] || 'EW_UNKNOWN'} (${err})`;
        const note = st.len < 0 ? 'malformed frame'
                   : st.len === 0 ? 'answered, no data'
                   : `${st.len} bytes`;
        console.log(`0x${c3.toString(16).padStart(4, '0')}  ${name.padEnd(38)}  ${stat.padEnd(10)}  ${String(st.len).padStart(3)}  ${note}`);
        results.push({ name, c3, c1, c2, err, len: st.len, inNode });
    }

    // A summary that separates "the node already relies on this" from "this is new",
    // so a regression on the first group is not read as a finding about the second.
    const bad = results.filter(r => r.err !== 0 && r.err !== 6);
    const noopt = results.filter(r => r.err === 6);
    console.log('\n── summary ─────────────────────────────────────────────────────────────');
    console.log(`  ${results.length} probes, ${results.length - bad.length - noopt.length} EW_OK, ` +
                `${noopt.length} EW_NOOPT (option not fitted), ${bad.length} other`);
    if (noopt.length) {
        console.log('  EW_NOOPT — the request is right, the CNC option is not fitted:');
        for (const r of noopt) console.log(`    ${r.name}`);
    }
    if (bad.length) {
        console.log('  Not EW_OK / EW_NOOPT:');
        for (const r of bad) {
            const tag = r.inNode ? 'REGRESSION (node uses this)' : 'new';
            console.log(`    ${r.name}  → ${FOCAS_ERRORS[String(r.err)] || r.err}  [${tag}]`);
        }
    }

    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
