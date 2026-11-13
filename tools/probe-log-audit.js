'use strict';
/**
 * tools/probe-log-audit.js — READ-ONLY: check the fields a captured All Data log
 * looked wrong on, against the controller that produced it.
 *
 * Three things in logs/20261113-log.json did not look right:
 *
 *   1. program_memory.registered_programs = 0, but the machine has programs
 *      (O8002 is running, and listprog returns 903/8000/8001/8002). The raw block
 *      was `00 00 00 81 | 00 00 03 70 | 00 02 bd 2c | 00 7e ca fc`, which reads as
 *      FOUR longs (129, 880, 179500, 8309500) — not two shorts then two longs.
 *
 *   2. machine_state said run=STaRt / motion=Moving while machine_state_ext said
 *      run=**** / motion=Stopped. Two reads of one machine should not disagree that
 *      way, so the statinfo2 assembly is suspect: its sub1 block may start at `aut`
 *      rather than at `hdck`.
 *
 *   3. calendar said 17:35 while the poll timestamp was 15:22 local. That may be a
 *      real CNC clock offset, or a decode fault.
 *
 * Every request here is a read.
 *
 * Usage: node tools/probe-log-audit.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex = b => b && b.length ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const i16 = (b, o) => (o + 2 <= b.length) ? b.readInt16BE(o) : null;
const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : null;
const h   = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}`);

    // ── 1. cnc_rdproginfo: four longs, or two shorts then two longs? ─────────
    h('1 — cnc_rdproginfo: is the block four longs?');
    const pi = await f._reqSingle(1, 1, 0x07);
    console.log(`  raw: ${hex(pi.data)}  (${pi.len} bytes)`);
    console.log(`  as 4 longs : ${[0, 4, 8, 12].map(o => i32(pi.data, o)).join(' | ')}`);
    console.log(`  as 8 shorts: ${[0, 2, 4, 6, 8, 10, 12, 14].map(o => i16(pi.data, o)).join(' | ')}`);

    // The number of programs actually registered, from the directory. This is the
    // independent count the decode has to agree with.
    const dir = await f.listprog(1);
    const progCount = dir ? Object.keys(dir).length : 0;
    console.log(`  listprog found ${progCount} programs: ${dir ? Object.keys(dir).join(',') : '(none)'}`);

    const asLongs = [0, 4, 8, 12].map(o => i32(pi.data, o));
    const asShorts = [0, 2, 4, 6].map(o => i16(pi.data, o));
    console.log(`\n  → four-long reading : registered=${asLongs[0]} available=${asLongs[1]}` +
                ` used=${asLongs[2]} unused=${asLongs[3]}`);
    console.log(`  → current reading   : registered=${asShorts[1]} available=${asShorts[3]}` +
                ` used=${asLongs[2]} unused=${asLongs[3]}`);
    console.log(`  → which registered count is plausible against ${progCount} programs on disk?`);

    // ── 2. cnc_statinfo2: does sub1 start at aut or at hdck? ─────────────────
    h('2 — cnc_statinfo2: does sub1 start at `aut` (like cnc_statinfo) or at `hdck`?');
    // Read the plain statinfo and the two sub-requests back to back. If sub1's first
    // seven shorts equal statinfo's seven, sub1 starts at `aut` and the current
    // decode (which puts hdck/tmmode in front) is shifted by two.
    const base = await f._reqSingle(1, 1, 0x19, 0);
    const s1   = await f._reqSingle(1, 1, 0x0e2);
    const s2   = await f._reqSingle(1, 1, 0x0e1);

    const baseW = Array.from({ length: Math.floor(base.len / 2) }, (_, i) => i16(base.data, i * 2));
    const s1W   = Array.from({ length: Math.floor(s1.len / 2) },   (_, i) => i16(s1.data, i * 2));
    const s2W   = Array.from({ length: Math.floor(s2.len / 2) },   (_, i) => i16(s2.data, i * 2));

    console.log(`  cnc_statinfo (0x19) : ${baseW.join(' ')}   (${base.len} bytes)`);
    console.log(`  statinfo2 sub1 (e2) : ${s1W.join(' ')}   (${s1.len} bytes)`);
    console.log(`  statinfo2 sub2 (e1) : ${s2W.join(' ')}   (${s2.len} bytes)`);

    const n = Math.min(baseW.length, s1W.length);
    const samePrefix = baseW.slice(0, n).every((v, i) => v === s1W[i]);
    console.log(`\n  sub1[0..${n - 1}] == statinfo[0..${n - 1}] ? ${samePrefix}`);
    if (samePrefix) {
        console.log('  → sub1 starts at `aut`: the 11 shorts are');
        console.log('    aut run motion mstb emergency alarm edit warning o3dchk ext_opt restart');
        console.log(`    = ${s1W.join(' ')}`);
        console.log(`  → sub2 (${s2W.join(' ')}) is then hdck/tmmode, which ODBST2 puts FIRST`);
    } else {
        console.log('  → sub1 does NOT start at aut; the current decode may be right');
    }

    // ── 3. cnc_gettimer vs the host clock ────────────────────────────────────
    h('3 — cnc_gettimer vs the host clock');
    const d = await f._reqSingle(1, 1, 0x45, 0);
    const t = await f._reqSingle(1, 1, 0x45, 1);
    const dateW = [0, 2, 4].map(o => i16(d.data, o));
    const timeW = [6, 8, 10].map(o => i16(t.data, o));
    const host = new Date();
    console.log(`  type=0 raw: ${hex(d.data)}  → ${dateW.join('-')}`);
    console.log(`  type=1 raw: ${hex(t.data)}  → ${timeW.join(':')}`);
    console.log(`  host local : ${host.getFullYear()}-${String(host.getMonth() + 1).padStart(2, '0')}-` +
                `${String(host.getDate()).padStart(2, '0')} ` +
                `${String(host.getHours()).padStart(2, '0')}:` +
                `${String(host.getMinutes()).padStart(2, '0')}:` +
                `${String(host.getSeconds()).padStart(2, '0')}`);
    const cncSec = dateW[0] * 31536000 + dateW[1] * 2592000 + dateW[2] * 86400 +
                   timeW[0] * 3600 + timeW[1] * 60 + timeW[2];
    const hostSec = host.getFullYear() * 31536000 + (host.getMonth() + 1) * 2592000 +
                    host.getDate() * 86400 + host.getHours() * 3600 +
                    host.getMinutes() * 60 + host.getSeconds();
    const diffMin = Math.round((cncSec - hostSec) / 60);
    console.log(`  → CNC clock is ${diffMin} minutes ${diffMin >= 0 ? 'ahead of' : 'behind'} the host`);
    console.log('    (a real offset is a machine setting; a decode fault would show as a');
    console.log('     nonsense hour, not a plausible one)');

    // ── 4. tool life: is any group in use while the machine cuts? ────────────
    h('4 — cnc_rdusegrpid: using / next / selected');
    const ug = await f._reqSingle(1, 1, 0x48);
    console.log(`  raw: ${hex(ug.data)}  (${ug.len} bytes)`);
    console.log(`  as 3 longs: next=${i32(ug.data, 0)} use=${i32(ug.data, 4)} slct=${i32(ug.data, 8)}`);
    const st = await f.statinfo();
    console.log(`  machine state: aut=${st.aut} run=${st.run} motion=${st.motion}`);

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
