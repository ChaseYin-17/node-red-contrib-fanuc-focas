'use strict';
/**
 * tools/probe-funcsupport.js — which FOCAS function codes does this CNC actually answer?
 *
 * readservoload()/readspindleload() swallow every failure into `null`, so the only way
 * to tell "unsupported function" from "empty result" from "layout mismatch" is to ask
 * the controller directly and read the EW_* status word.
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
    ['cnc_rdprogdir   (listprog)',        0x06, [1, 0x13, 2]],
    ['cnc_rdmacro     (readmacro)',       0x15, [1, 1]],
    ['cnc_sysinfo',                       0x18, []],
    ['cnc_statinfo',                      0x19, [0]],
    ['cnc_rdprgnum    (readprognum)',     0x1c, []],
    ['cnc_alarm',                         0x22, [0]],
    ['cnc_rdalmmsg    (alarm_messages)',  0x23, [-1, 1, 1, 32]],
    ['cnc_rdactfeed   (readactfeed)',     0x24, []],
    ['cnc_rdactspdspeed(readspindlespeed)',0x25, []],
    ['cnc_rddynamic2  (readaxes)',        0x26, [4, -1, 0, 0]],
    ['cnc_diagnoss    (RETIRED path)',    0x30, [400, 400, -1]],
    ['cnc_rdspmeter   (spindle load, %)', 0x40, [0, -1]],
    ['cnc_rdsvmeter   (servo load, %)',   0x56, [1]],
    ['cnc_rdsvmeter   (load current, A)', 0x56, [3]],
    ['cnc_rdaxisname  (servo axis names)',0x89, [0]],
    ['cnc_rdspdlname  (spindle names)',   0x8a, [-1]],
    ['cnc_rdaxisnum   (servo axcount)',   0xa4, [2]],
    ['cnc_rdparam3     (readparam3)',     0x8d, [6711, 6711, -1]],
    ['cnc_rdparam      (readparam3 fall)',0x0e, [6711, 6711, -1]],
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