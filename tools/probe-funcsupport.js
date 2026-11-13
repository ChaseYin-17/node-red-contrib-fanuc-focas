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
 * Usage: node tools/probe-funcsupport.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);

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

// name, c3, args — every read the node issues, plus the load-meter variants it could.
//
// There is no row for cnc_rdaxisdata: the 64-bit library has no opcode of its own for
// it. Captured with tools/probe-dll-opcode.py, cls=2 decomposes into 0xa4 + 0x89 +
// 0x56[type] — so its servo load meter is the 0x56 row below, and its "load current
// (Ampere)" is the same opcode with 3 in place of 1. See docs/notes.md.
const CASES = [
    ['cnc_rdprogdir   (listprog)',        0x06, [1, 3, 2]],
    ['cnc_rdmacro     (readmacro)',       0x15, [1, 1]],
    ['cnc_sysinfo',                       0x18, []],
    ['cnc_statinfo',                      0x19, [0]],
    ['cnc_rdprgnum    (readprognum)',     0x1c, []],
    // 0x1a for both cnc_alarm and cnc_alarm2 — captured from the vendor library,
    // which sends a byte-identical request for the two (see focas.js). 0x22 used to
    // be listed here as cnc_alarm; that label was never verified and is wrong.
    ['cnc_alarm',                         0x1a, [0]],
    ['cnc_rdalmmsg    (alarm_messages)',  0x23, [-1, 1, 1, 32]],
    ['cnc_rdactfeed   (readactfeed)',     0x24, []],
    ['cnc_rdactspdspeed(readspindlespeed)',0x25, []],
    ['cnc_rddynamic2  (readaxes)',        0x26, [4, -1, 0, 0]],
    ['cnc_rdspmeter   (spindle load, %)', 0x40, [0, -1]],
    ['cnc_rdsvmeter   (servo load, %)',   0x56, [1]],
    ['cnc_rdsvmeter   (load current, A)', 0x56, [3]],
    // data_num is sent as 0 — that is what the vendor library puts on the wire, and
    // the real count is rejected (0x89[5] on a 5-axis machine is EW_ATTRIB). See
    // docs/notes.md.
    ['cnc_rdaxisname  (servo axis names)',0x89, [0]],
    ['cnc_rdspdlname  (spindle names)',   0x8a, [0]],
    ['cnc_rdaxisnum   (servo axcount)',   0xa4, [2]],
    // cnc_rdparam3's wire arguments are (number, number, axis), not the C
    // (number, axis, length, absolute) — captured from the vendor library.
    ['cnc_rdparam3     (readparam3)',     0x8d, [6711, 6711, -1]],
    ['cnc_rdparam      (readparam3 fall)',0x0e, [6711, 6711, -1]],
    // Tool offsets. 0x08 is BOTH cnc_rdtofs and cnc_rdtofsr, told apart by the argument
    // pattern: (number, number, 1000+type) reads one, (s, e, type) reads a range.
    // Captured with tools/probe-dll-tofs.py — the 0x2c/0x2d/0x2e that look adjacent to
    // the other Ncdata reads are other functions and answer the same bytes for every
    // argument. See docs/notes.md.
    ['cnc_rdtofsinfo  (tool offsets)',    0x0a, []],
    ['cnc_rdtofs      (one offset)',      0x08, [1, 1, 1003]],
    ['cnc_rdtofsr     (offset range)',    0x08, [1, 5, 0]],
    // Tool life. All four need the CNC's "tool life management" option; without it
    // the controller answers EW_NOOPT (6) — the request itself is still correct.
    ['cnc_rdusegrpid  (tool life group)', 0x48,  []],
    ['cnc_rdngrp      (tool life count)', 0x4a,  []],
    ['cnc_rdgrpinfo4  (tool life groups)',0x1c1, [1, 0, 10]],
    ['cnc_rdtlinfo    (tool life limits)',0x1c4, []],
];

(async () => {
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    console.log(`connected to ${IP}:${PORT}   cnctype=${JSON.stringify(f.sysinfo.cnctype)}` +
                `  series=${JSON.stringify(f.sysinfo.series)}  maxaxis=${f.sysinfo.maxaxis}\n`);
    console.log('func  name                                    status      len  note');
    console.log('────  ──────────────────────────────────────  ──────────  ───  ────');
    for (const [name, c3, args] of CASES) {
        let st;
        try {
            st = await f._reqSingle(1, 1, c3, ...args);
        } catch (e) {
            console.log(`0x${c3.toString(16).padStart(2, '0')}  ${name.padEnd(38)}  THREW       -    ${e.message}`);
            try { f.socket.removeAllListeners('data'); f.socket.removeAllListeners('error'); } catch (_) {}
            continue;
        }
        const err  = st.error !== undefined ? st.error : 0;
        const stat = `${FOCAS_ERRORS[String(err)] || 'EW_UNKNOWN'} (${err})`;
        console.log(`0x${c3.toString(16).padStart(2, '0')}  ${name.padEnd(38)}  ${stat.padEnd(10)}  ${String(st.len).padStart(3)}  ` +
                    (st.len < 0 ? 'malformed frame' : st.len === 0 ? 'answered, no data' : `${st.len} bytes`));
    }
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });