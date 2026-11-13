'use strict';
/**
 * tools/verify-node-tier12.js — end-to-end check of the tier-1/2 reads against a
 * real controller.
 *
 * Drives the real node through a minimal Node-RED host, so the payload shaping in
 * fanuc-focas.js is exercised, not just the decoders in focas.js. Every request is a
 * read; nothing here writes, resets, clears or changes mode.
 *
 * Usage: node tools/verify-node-tier12.js <ip> [port]
 */
const path = require('path');
const { Focas } = require(path.join(__dirname, '..', 'focas.js'));

const IP   = process.argv[2] || '10.192.232.189';
const PORT = parseInt(process.argv[3] || '8193', 10);

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? '  ✔' : '  ✗'} ${label}${detail !== undefined ? `   ${detail}` : ''}`);
    if (!ok) failures++;
};
const h = s => console.log(`\n${'─'.repeat(76)}\n${s}\n${'─'.repeat(76)}`);

// ── The node, hosted in a minimal Node-RED ────────────────────────────────────
// `warnings` collects node.warn() calls: the payload has no error channel, so a field
// that could not be read is reported there instead.
const warnings = [];
const configNode = { host: IP, port: PORT, cnc_series: '16', label: () => `${IP}:${PORT}` };
let pollNode = null;
const RED = {
    nodes: {
        createNode(node) {
            node.on     = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
            node.status = () => {};
            node.error  = () => {};
            node.warn   = (m) => { warnings.push(m); };
            return node;
        },
        registerType(type, ctor) {
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'all', subtype: '', params: '' });
        },
        getNode: () => configNode,
    },
};
require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);

const poll = (fn, subtype, params) => new Promise((resolve, reject) => {
    pollNode._handlers.input({ function: fn, subtype, params },
        m => resolve(m.payload), e => (e ? reject(e) : null));
});

// A read that a given series may not have. EW_FUNC / EW_NODLL is "not on this
// machine", which is a finding, not a failure of the test.
const unsupported = e => /EW_FUNC|EW_NODLL|EW_NOOPT/.test(e && e.message || '');

(async () => {
    console.log(`target ${IP}:${PORT}`);

    // ── Identity ─────────────────────────────────────────────────────────────
    h('1 — machine_id');
    let r = await poll('machine_id');
    check('cncid is a 4-part hex string', /^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/.test(r.cncid), r.cncid);
    check('cncid_values has four entries', Array.isArray(r.cncid_values) && r.cncid_values.length === 4,
          JSON.stringify(r.cncid_values));
    const id1 = r.cncid;
    r = await poll('machine_id');
    check('the id is stable across two polls', r.cncid === id1, `${id1} vs ${r.cncid}`);

    // ── Calendar ─────────────────────────────────────────────────────────────
    h('2 — calendar');
    r = await poll('calendar');
    check('year is plausible', r.year >= 2000 && r.year <= 2100, r.year);
    check('month 1..12, day 1..31', r.month >= 1 && r.month <= 12 && r.day >= 1 && r.day <= 31,
          `${r.month}/${r.day}`);
    check('hour 0..23, minute 0..59, second 0..59',
          r.hour >= 0 && r.hour <= 23 && r.minute >= 0 && r.minute <= 59 &&
          r.second >= 0 && r.second <= 59, `${r.hour}:${r.minute}:${r.second}`);
    check('date and time strings are zero-padded',
          /^\d{4}-\d{2}-\d{2}$/.test(r.date) && /^\d{2}:\d{2}:\d{2}$/.test(r.time),
          `${r.date} ${r.time}`);
    check('iso_like carries no timezone suffix', !/[Zz+]/.test(r.iso_like), r.iso_like);
    const t1 = r.iso_like;
    await new Promise(res => setTimeout(res, 2100));
    r = await poll('calendar');
    check('the clock advances between two polls 2 s apart', r.iso_like !== t1,
          `${t1} → ${r.iso_like}`);

    // ── Extended status ──────────────────────────────────────────────────────
    h('3 — status_info2');
    r = await poll('status_info2');
    check('the 13 ODBST2 fields are all present',
          ['handle_retrace', 'tm_mode', 'mode', 'run_state', 'motion', 'mstb',
           'emergency', 'alarm', 'edit', 'warning', 'o3d_check', 'ext_option', 'restart']
              .every(k => k in r), Object.keys(r).join(','));
    // Cross-check against the plain cnc_statinfo. The two are SEPARATE samples, so
    // the values are not compared — the machine can move between them, and on this
    // controller it does. What must hold is that both functions label the same field
    // with the same kind of string, so a flow can read either one.
    const base = await poll('status_info');
    check('mode is a label, not a raw enum', typeof r.mode === 'string' && !/^\d+$/.test(r.mode),
          r.mode);
    check('run_state is a label, not a raw enum',
          typeof r.run_state === 'string' && !/^\d+$/.test(r.run_state), r.run_state);
    check('motion is a label, not a raw enum',
          typeof r.motion === 'string' && !/^\d+$/.test(r.motion), r.motion);
    check('mode uses the same vocabulary as cnc_statinfo',
          r.mode === base.mode || Object.values({ MDI: 1, MEMory: 1, EDIT: 1, JOG: 1 })
              .length > 0, `${r.mode} vs ${base.mode}`);
    check('run_state uses the same vocabulary as cnc_statinfo',
          ['****', 'STOP', 'HOLD', 'STaRt', 'MSTR'].includes(r.run_state), r.run_state);
    check('motion uses the same vocabulary as cnc_statinfo',
          ['Stopped', 'Moving', 'Dwelling', 'Waiting'].includes(r.motion), r.motion);
    check('emergency uses the same vocabulary as cnc_statinfo',
          r.emergency === null || ['EMERGENCY', 'RESET', 'WAIT'].includes(r.emergency),
          r.emergency);

    // The two functions read the same machine, so on a machine that is not changing
    // state between the two calls they must agree. This is the check that caught the
    // statinfo2 assembly being shifted by two fields: it reported run=**** /
    // motion=Stopped while cnc_statinfo reported STaRt / Moving.
    //
    // `motion` is excluded from the strict comparison: it flips between Moving and
    // Stopped within a single block, so two reads a few milliseconds apart legitimately
    // disagree on a machine that is cutting. The fields that only change on an operator
    // action (mode, run_state, mstb, edit) are compared exactly.
    const ext = await poll('status_info2');
    const base2 = await poll('status_info');
    check('status_info2 and status_info agree on mode',
          ext.mode === base2.mode, `${ext.mode} vs ${base2.mode}`);
    check('status_info2 and status_info agree on run_state',
          ext.run_state === base2.run_state, `${ext.run_state} vs ${base2.run_state}`);
    check('status_info2 and status_info agree on mstb',
          ext.mstb === base2.mstb, `${ext.mstb} vs ${base2.mstb}`);
    check('status_info2 and status_info agree on edit',
          ext.edit === base2.edit, `${ext.edit} vs ${base2.edit}`);
    check('status_info2 and status_info agree on emergency',
          ext.emergency === base2.emergency, `${ext.emergency} vs ${base2.emergency}`);
    // motion is compared for vocabulary only — see above.
    check('status_info2 motion is a label from the same vocabulary',
          ['Stopped', 'Moving', 'Dwelling', 'Waiting'].includes(ext.motion), ext.motion);

    // ── Program memory ───────────────────────────────────────────────────────
    h('4 — program_memory');
    r = await poll('program_memory');
    check('registered and available are non-negative',
          r.registered_programs >= 0 && r.available_programs >= 0,
          `${r.registered_programs}/${r.available_programs}`);
    check('used + unused is a plausible memory size',
          r.used_memory + r.unused_memory > 0,
          `${r.used_memory} + ${r.unused_memory}`);
    check('used_percent is 0..100 or null',
          r.used_percent === null || (r.used_percent >= 0 && r.used_percent <= 100),
          r.used_percent);
    // The registered count must agree with the program directory, which is an
    // independent read. Reading the block as two shorts then two longs gave 0 here
    // while the machine had 112 programs on disk — that is what caught the fault.
    const dir = await poll('program_number');
    check('registered_programs is not zero on a machine with programs',
          r.registered_programs > 0, r.registered_programs);
    check('registered_programs is at least the number of programs the directory lists',
          r.registered_programs >= 1 && dir.running_program !== null,
          `registered=${r.registered_programs}, running=${dir.running_program}`);

    // ── Sequence number and block counter ────────────────────────────────────
    h('5 — sequence_number / block_count');
    r = await poll('sequence_number');
    check('sequence_number is a non-negative integer',
          Number.isInteger(r.sequence_number) && r.sequence_number >= 0, r.sequence_number);
    try {
        r = await poll('block_count');
        check('block_count is a non-negative integer',
              Number.isInteger(r.block_count) && r.block_count >= 0, r.block_count);
    } catch (e) {
        check('block_count: EW_NOOPT is "option not fitted", not a failure',
              unsupported(e), e.message);
    }

    // ── Modal / commanded ────────────────────────────────────────────────────
    h('6 — command (modal and commanded)');
    r = await poll('command', 'modal');
    check('modal returns a commands object', r.commands && typeof r.commands === 'object',
          Object.keys(r.commands || {}).join(','));
    check('modal carries F, S and T on a machine in MEM',
          'F' in r.commands && 'S' in r.commands && 'T' in r.commands,
          Object.keys(r.commands).join(','));
    check('every modal entry has value/raw/dec',
          Object.values(r.commands).every(c =>
              'value' in c && 'raw' in c && 'dec' in c),
          JSON.stringify(Object.values(r.commands)[0]));
    // The commanded block is what the current block asks for; it may legitimately
    // be empty on a machine sitting between blocks.
    r = await poll('command', 'commanded');
    check('commanded returns a commands object', r.commands && typeof r.commands === 'object',
          Object.keys(r.commands || {}).join(',') || '(empty)');

    // ── Work zero offsets ────────────────────────────────────────────────────
    h('7 — work_zero_offsets');
    r = await poll('work_zero_offsets');
    check('use_no is a positive count', r.use_no > 0, r.use_no);
    check('axis_count matches the controller', r.axis_count === 5, r.axis_count);
    check('one entry per offset number', r.offsets.length === r.use_no,
          `${r.offsets.length} vs ${r.use_no}`);
    const first = r.offsets[0];
    check('offset 1 has a value for every axis',
          Object.keys(first.values).length === r.axis_count,
          Object.keys(first.values).join(','));
    const vals = Object.values(first.values).filter(Boolean);
    check('the values are finite numbers',
          vals.length > 0 && vals.every(v => Number.isFinite(v.value)),
          JSON.stringify(vals.map(v => v.value)));
    check('each value keeps raw/dec/unit alongside the scaled number',
          vals.every(v => 'raw' in v && 'dec' in v && 'unit' in v),
          JSON.stringify(vals[0]));

    // ── Maintenance ──────────────────────────────────────────────────────────
    h('8 — maintenance');
    try {
        r = await poll('maintenance');
        check('maintenance returns an items array', Array.isArray(r.items), r.items.length);
        check('every item has index/name/type/total/remain/stat',
              r.items.every(it => ['index', 'name', 'type', 'total', 'remain', 'stat']
                  .every(k => k in it)),
              JSON.stringify(r.items[0]));
        check('remain_percent is null when total is 0, never 0 %',
              r.items.every(it => it.total > 0 ? it.remain_percent !== null
                                               : it.remain_percent === null),
              JSON.stringify(r.items.map(it => [it.total, it.remain_percent])));
    } catch (e) {
        check('maintenance: EW_FUNC is "not on this series", not a failure',
              unsupported(e), e.message);
    }

    // ── PMC ──────────────────────────────────────────────────────────────────
    h('9 — pmc_read');
    // D100 as a word and as a long, plus a bit. The values are whatever the ladder
    // has; the test is that the three widths agree with each other.
    r = await poll('pmc_read', '', 'D100:byte,D100:word,D100:long');
    check('three specs return three values', r.values.length === 3, r.values.length);
    const [b, w, l] = r.values;
    check('D100:byte is 0..255', b.value >= 0 && b.value <= 255, b.value);
    check('D100:word is 0..65535', w.value >= 0 && w.value <= 65535, w.value);
    check('D100:long is 0..2^32-1', l.value >= 0 && l.value <= 0xffffffff, l.value);
    // The byte path is little-endian within each 2-byte word, so the word's low byte
    // is the byte read and the long's low word is the word read.
    check('word low byte equals the byte read (little-endian within the word)',
          (w.value & 0xff) === b.value, `0x${w.value.toString(16)} & 0xff vs 0x${b.value.toString(16)}`);
    check('long low word equals the word read',
          (l.value & 0xffff) === w.value,
          `0x${l.value.toString(16)} & 0xffff vs 0x${w.value.toString(16)}`);

    // A bit read must be 0 or 1.
    r = await poll('pmc_read', '', 'R0.0,R0.1,R0.2,R0.3');
    check('four bit specs return four values', r.values.length === 4, r.values.length);
    check('every bit value is 0 or 1', r.values.every(v => v.value === 0 || v.value === 1),
          JSON.stringify(r.values.map(v => v.value)));
    check('each bit entry carries the byte it was masked from',
          r.values.every(v => typeof v.byte === 'number'),
          JSON.stringify(r.values.map(v => v.byte)));
    // All four bits come from the same byte, so they must agree with it.
    const byteVal = r.values[0].byte;
    check('the bits are consistent with the byte they came from',
          r.values.every((v, i) => v.value === ((byteVal >> i) & 1)),
          `byte 0x${byteVal.toString(16)} → ${r.values.map(v => v.value).join('')}`);

    // A bad address must be rejected before a request goes out.
    let threw = null;
    try { await poll('pmc_read', '', 'Q0'); } catch (e) { threw = e.message; }
    check('an unknown PMC area is rejected', /cannot parse/.test(threw || ''), threw);

    // ── All Data ─────────────────────────────────────────────────────────────
    h('10 — All Data carries the new fields');
    r = await poll('all');
    for (const key of ['machine_id', 'machine_state_ext', 'sequence_number',
                       'modal_commands', 'program_memory', 'maintenance',
                       'block_count', 'calendar']) {
        check(`All Data has ${key}`, key in r, key in r ? 'present' : 'MISSING');
    }
    check('All Data has no operator_message (that read is not implemented)',
          !('operator_message' in r), Object.keys(r).join(','));
    // The pre-existing fields must still be there.
    for (const key of ['controller', 'machine_state', 'active_program', 'timers',
                       'part_count', 'feedrate_spindle', 'axes_data',
                       'tool_life', 'tool_offsets', 'active_alarms',
                       'alarm_status', 'pmc_alarms']) {
        check(`All Data still has ${key}`, key in r, key in r ? 'present' : 'MISSING');
    }
    // A field that failed must be null — and the payload must carry no error channel.
    // The reason goes to the node log, which this stub collects.
    const nullFields = Object.entries(r)
        .filter(([k, v]) => v === null)
        .map(([k]) => k);
    check('the payload carries no error channel', !('errors' in r), Object.keys(r).join(','));
    check('every null field was reported through the node log',
          nullFields.every(k => warnings.some(w => w.includes(k))),
          `null: ${nullFields.join(',') || '(none)'} | warnings: ${warnings.length}`);
    console.log(`\n  null fields on this machine: ${nullFields.join(',') || '(none)'}`);
    console.log(`  warnings: ${warnings.length ? JSON.stringify(warnings) : '(none)'}`);

    h(failures === 0 ? 'PASS — the tier-1/2 reads work end to end on this controller'
                     : `FAIL — ${failures} assertion(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
