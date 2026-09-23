'use strict';
/**
 * tools/verify-type-all.js — test `type = -1` ("all type") per the official FOCAS2 spec.
 *
 * Official type enums (Document/SpecE/Misc/cnc_rdalmmsg.xml):
 *
 *   Series 30i/31i/32i, 0i-D/F, PMi-A            Series 16i/18i/21i, 0i-A/B/C     Series 15i
 *   0  Parameter switch on     (SW)              0  P/S100                          0  Background P/S   (BG)
 *   1  Power off parameter set (PW)              1  P/S000                          1  Foreground P/S   (PS)
 *   2  I/O error               (IO)              2  P/S101                          2  Overheat         (OH)
 *   3  Foreground P/S          (PS)              3  P/S alarm except above          3  Sub-CPU error    (SB)
 *   4  Overtravel,External data(OT)              4  Overtravel alarm                 4  Syncronized err  (SN)
 *   5  Overheat alarm          (OH)              5  Overheat alarm                   5  Parameter switch (SW)
 *   6  Servo alarm             (SV)              6  Servo alarm                      6  Overtravel       (OT)
 *   7  Data I/O error          (SR)              7  System alarm                     7  PMC error        (PC)
 *   8  Macro alarm             (MC)              8  APC alarm                        8  External msg(1)  (EX)
 *   9  Spindle alarm           (SP)              9  Spindle alarm                    9  (not used)
 *   10 Other alarm             (DS)              10 P/S alarm(No.5000..)             10 Serious P/S     (SR)
 *   11 Malfunction prevent     (IE)              11 Laser alarm                     11 (not used)
 *   12 Background P/S          (BG)              12 (not used)                      12 Servo alarm      (SV)
 *   13 Syncronized error       (SN)              13 Rigid tap alarm                 13 I/O error        (IO)
 *   14 (reserved)                               14 (not used)                      14 Power off param  (PW)
 *   15 External alarm message  (EX)              15 External alarm message          15 System alarm     (SY)
 *   16-18 (reserved)                                                               16-18 External msg (2..4)
 *   19 PMC error               (PC)                                                19 Macro alarm      (MC)
 *   -1 All type                                 -1 All type                        20 Spindle alarm    (SP)
 *                                                                                  -1 All type
 *
 * Usage: node tools/verify-type-all.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '192.168.100.128';
const PORT = parseInt(process.argv[3] || '8193', 10);

const TYPE_30i = {
    0:'Parameter switch on (SW)', 1:'Power off parameter set (PW)', 2:'I/O error (IO)',
    3:'Foreground P/S (PS)', 4:'Overtravel,External data (OT)', 5:'Overheat alarm (OH)',
    6:'Servo alarm (SV)', 7:'Data I/O error (SR)', 8:'Macro alarm (MC)', 9:'Spindle alarm (SP)',
    10:'Other alarm (DS)', 11:'Malfunction prevent (IE)', 12:'Background P/S (BG)',
    13:'Syncronized error (SN)', 14:'(reserved)', 15:'External alarm message (EX)',
    16:'(reserved)', 17:'(reserved)', 18:'(reserved)', 19:'PMC error (PC)',
};
const TYPE_16i = {
    0:'P/S100', 1:'P/S000', 2:'P/S101', 3:'P/S alarm except above', 4:'Overtravel alarm',
    5:'Overheat alarm', 6:'Servo alarm', 7:'System alarm', 8:'APC alarm', 9:'Spindle alarm',
    10:'P/S alarm(No.5000..)', 11:'Laser alarm', 13:'Rigid tap alarm', 15:'External alarm message',
};
const label = (t, tbl) => tbl[t] !== undefined ? tbl[t] : (t === -1 ? 'All type' : `(unknown ${t})`);

function parse(data, textLen) {
    const stride = 16 + textLen;
    const recs = [];
    for (let p = 0; p + stride <= data.length; p += stride) {
        let t = data.slice(p + 16, p + stride);
        const nul = t.indexOf(0);
        if (nul !== -1) t = t.slice(0, nul);
        recs.push({
            alm_no:  data.readInt32BE(p),
            type:    data.readInt32BE(p + 4),
            axis:    data.readInt32BE(p + 8),
            msg_len: data.readInt32BE(p + 12),
            text:    t.toString('latin1').trim(),
        });
    }
    return recs;
}

async function tryIt(f, label_, args, textLen) {
    try {
        const st = await f._reqSingle(1, 1, 0x23, ...args);
        if (st.len === 0) {
            // _reqSingle returns NO `error` field for a clean success with zero data.
            return console.log(st.error === undefined
                ? `  ${label_.padEnd(40)} ○  success, 0 records (no active alarm in this category)`
                : `  ${label_.padEnd(40)} ✗  error ${st.error} (${st.error === 4 ? 'EW_ATTRIB: alarm type spec is wrong' : 'see ERRCODE.HTM'})`);
        }
        if (st.len < 0)    return console.log(`  ${label_.padEnd(40)} ✗  bad frame`);
        console.log(`  ${label_.padEnd(40)} ✓ dataLen=${st.len} records=${parse(st.data, textLen).length}`);
        parse(st.data, textLen).forEach(r => console.log(
            `        alm_no=${r.alm_no} type=${r.type} axis=${r.axis} msg_len=${r.msg_len} text=${JSON.stringify(r.text)}`));
    } catch (e) {
        console.log(`  ${label_.padEnd(40)} ✗ ${e.message}`);
        try { f.socket.removeAllListeners('data'); f.socket.removeAllListeners('error'); } catch (_) {}
    }
}

const h = (s) => console.log(`\n${'─'.repeat(72)}\n${s}\n${'─'.repeat(72)}`);

(async () => {
    const f = new Focas(IP, PORT, 6000);
    await f.connect();
    const si = f.sysinfo;
    console.log(`connected ${IP}:${PORT}  cnc_type=${si.cnctype.trim()} series=${si.series.trim()} axes=${si.axes.trim()}`);
    const st = await f.statinfo();
    console.log(`statinfo.alarm = ${st.alarm}`);

    h('A. type = -1 ("All type") — the value the official spec says returns everything');
    await tryIt(f, 'type=-1, num=10, withtext=1, textlen=32', [-1, 10, 1, 32], 32);
    await tryIt(f, 'type=-1, num=10, withtext=1, textlen=64', [-1, 10, 1, 64], 64);

    h('B. per-category sweep with type=-1 semantics confirmed');
    for (const t of [0, 1, 3, 6, 12]) {
        await tryIt(f, `type=${t}  ${label(t, TYPE_30i)}`, [t, 10, 1, 32], 32);
    }
    await tryIt(f, 'type=32  (out of range → EW_ATTRIB)', [32, 10, 1, 32], 32);

    h('C. what the node sends today');
    await tryIt(f, 'type=1,  num=10, withtext=1, textlen=32', [1, 10, 1, 32], 32);

    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });