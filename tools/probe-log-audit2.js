'use strict';
/**
 * tools/probe-log-audit2.js — READ-ONLY: cross-check the fields in
 * logs/real-data-1.json that cannot be verified from the payload alone.
 *
 * Four things need an independent read:
 *
 *   1. tool_life.using_group is null while the machine is cutting. cnc_rdusegrpid
 *      returned next=0 use=0 slct=23 earlier, so "no group in use" may be real — but
 *      it is worth confirming against the raw block and against the selected group.
 *
 *   2. axes_data.distance_to_go has 320.992 on X and -160.496 on Z while the machine
 *      is in STaRt/Moving. That is a large distance-to-go for a block that is running;
 *      it may be the next block's travel, or a stale read.
 *
 *   3. calendar says 18:10 while the poll timestamp is 15:57 local — the same ~133
 *      minute CNC clock offset seen before. Confirm it is stable, not drifting.
 *
 *   4. part_count.required_parts == lifetime_total == 9256. Two different counters
 *      reading the same value is plausible but worth a second look.
 *
 * Every request here is a read.
 *
 * Usage: node tools/probe-log-audit2.js [ip] [port]
 */
const { Focas } = require('../focas');

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

const hex = b => b && b.length ? b.toString('hex').replace(/(..)/g, '$1 ').trim() : '(none)';
const i32 = (b, o) => (o + 4 <= b.length) ? b.readInt32BE(o) : null;
const h   = s => console.log(`\n${'═'.repeat(78)}\n${s}\n${'═'.repeat(78)}`);

(async () => {
    const f = new Focas(IP, PORT, 8000);
    await f.connect();
    console.log(`connected ${IP}:${PORT}  cnc_type=${JSON.stringify(f.sysinfo.cnctype)}`);

    // ── 1. tool life: is any group actually in use? ──────────────────────────
    h('1 — cnc_rdusegrpid: next / use / slct, and what the groups say');
    const ug = await f._reqSingle(1, 1, 0x48);
    console.log(`  raw: ${hex(ug.data)}  (${ug.len} bytes)`);
    const next = i32(ug.data, 0), use = i32(ug.data, 4), slct = i32(ug.data, 8);
    console.log(`  next=${next}  use=${use}  slct=${slct}`);
    console.log(`  → using_group is ${use > 0 ? use : 'null (the controller reports 0)'}`);
    console.log(`  → selected_group is ${slct > 0 ? slct : 'null'}`);

    const st = await f.statinfo();
    console.log(`  machine: aut=${st.aut} run=${st.run} motion=${st.motion}`);
    console.log('  NOTE: tool life management counts a group as "in use" only while the');
    console.log('        CNC has selected one for the current tool. A warm-up program');
    console.log('        that never calls a T code leaves use=0 — that is a real answer.');

    // ── 2. distance to go while running ──────────────────────────────────────
    h('2 — cnc_rddynamic2: distance-to-go on a running block');
    // Read the same selector the node uses (sub 7 = DIST) twice, a second apart.
    for (let round = 1; round <= 2; round++) {
        const d = await f._reqSingle(1, 1, 0x26, 7, -1);
        const vals = [];
        for (let o = 0; o + 8 <= d.data.length; o += 8) {
            const raw = d.data.readInt32BE(o);
            const dec = d.data.readInt16BE(o + 6);
            vals.push(raw / Math.pow(10, dec));
        }
        console.log(`  round ${round}: ${vals.slice(0, 5).join(' | ')}`);
        if (round === 1) await new Promise(r => setTimeout(r, 1000));
    }
    const st2 = await f.statinfo();
    console.log(`  machine after: run=${st2.run} motion=${st2.motion}`);
    console.log('  NOTE: distance-to-go is the remaining travel of the CURRENT block.');
    console.log('        A non-zero value on a running machine is normal; it is not a');
    console.log('        position and must not be added to one.');

    // ── 3. the CNC clock offset ──────────────────────────────────────────────
    h('3 — cnc_gettimer vs the host clock, twice');
    for (let round = 1; round <= 2; round++) {
        const d = await f._reqSingle(1, 1, 0x45, 0);
        const t = await f._reqSingle(1, 1, 0x45, 1);
        const date = [0, 2, 4].map(o => d.data.readInt16BE(o));
        const time = [6, 8, 10].map(o => t.data.readInt16BE(o));
        const host = new Date();
        console.log(`  round ${round}: CNC ${date.join('-')} ${time.map(v => String(v).padStart(2, '0')).join(':')}` +
                    `   host ${host.getHours()}:${String(host.getMinutes()).padStart(2, '0')}:` +
                    `${String(host.getSeconds()).padStart(2, '0')}`);
        if (round === 1) await new Promise(r => setTimeout(r, 3000));
    }
    console.log('  → if both rounds show the same offset, the CNC clock is set that way;');
    console.log('    a drifting offset would mean a decode fault instead.');

    // ── 4. part count: two parameters that read the same ─────────────────────
    h('4 — cnc_rdparam3: 6711 (required) and 6712 (lifetime)');
    // Use the node's own readparam3 rather than decoding the block here. The record
    // layout is `datano(i32) | type(i16) | attr(i16) | record[MAX_AXIS] of
    // value(i32) | dec(i32)`, but **only attr 4 (real) has a meaningful dec** — for
    // every other attribute the second word of the record is not a decimal position.
    // An earlier version of this probe read it unconditionally and printed
    // `dec=655360`, which is that word being interpreted as something it is not.
    // parseParamBody() in focas.js already applies the per-attribute rule and is
    // covered by tools/verify-decoders-offline.js, so reuse it.
    for (const n of [6711, 6712]) {
        const r = await f.readparam3(-1, n);
        const rec = r && r[n];
        if (!rec) { console.log(`  ${n}: no record returned`); continue; }
        // attr 4 is the only one where data[0] is already scaled by its dec.
        console.log(`  ${n}: attr=${rec.type} data[0]=${rec.data[0]}` +
                    (rec.type === 4 ? '  (real: already scaled by dec)' : '  (integer value)'));
    }
    console.log('  → 6711 is the target part count and 6712 the running total. They are');
    console.log('    equal when the machine has just been reset to a new batch.');

    h('DONE — every request above was a read');
    await f.disconnect();
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
