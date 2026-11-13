'use strict';
let Focas, ALLAXIS, TOOL_GROUP_PAGE, PMC_AREAS, PMC_BYTE, PMC_WORD, PMC_LONG;
try {
    const m = require('./focas');
    Focas           = m.Focas;
    ALLAXIS         = m.ALLAXIS;
    TOOL_GROUP_PAGE = m.TOOL_GROUP_PAGE;
    PMC_AREAS       = m.PMC_AREAS;
    PMC_BYTE        = m.PMC_BYTE;
    PMC_WORD        = m.PMC_WORD;
    PMC_LONG        = m.PMC_LONG;
    if (typeof Focas !== 'function') {
        throw new Error(
            `focas.js exported Focas as '${typeof Focas}' (expected a class). ` +
            `Ensure focas.js is in the same directory as fanuc-focas.js.`
        );
    }
    // fnToolLife pages on this; an older focas.js without it would leave the page loop
    // comparing against undefined and never terminating.
    if (typeof TOOL_GROUP_PAGE !== 'number') {
        throw new Error(
            `focas.js exported TOOL_GROUP_PAGE as '${typeof TOOL_GROUP_PAGE}' (expected a number). ` +
            `focas.js and fanuc-focas.js are out of sync — update them together.`
        );
    }
    // The alarm_status / pmc_alarms fields call these. Without the check the failure is
    // "readalarmstatus2 is not a function" at poll time, once per poll, instead of a
    // load-time error naming the file that needs updating.
    for (const method of ['readalarmstatus2', 'readpmcalarm',
                          'readtofsinfo', 'readtofs', 'tofsTypeName',
                          // tier-1/2 reads
                          'readcncid', 'readzofsinfo', 'readzofs', 'readseqnum',
                          'readcommand', 'readproginfo', 'readpm_item',
                          'readblkcount', 'gettimer', 'statinfo2', 'readpmc']) {
        if (typeof Focas.prototype[method] !== 'function') {
            throw new Error(
                `focas.js has no Focas.prototype.${method}. ` +
                `focas.js and fanuc-focas.js are out of sync — update them together.`
            );
        }
    }
    // readpmc takes these; an older focas.js would pass undefined as the area code and
    // the controller would answer EW_RANGE for every read.
    if (!PMC_AREAS || typeof PMC_AREAS.D !== 'number' || typeof PMC_BYTE !== 'number') {
        throw new Error(
            `focas.js did not export PMC_AREAS / PMC_BYTE. ` +
            `focas.js and fanuc-focas.js are out of sync — update them together.`
        );
    }
} catch (e) {
    throw new Error(`node-red-contrib-fanuc-focas: failed to load focas.js — ${e.message}`);
}


// ── Lookup tables ─────────────────────────────────────────────────────────────
const AUT_MODES = {
    0:'MDI', 1:'MEMory', 2:'****', 3:'EDIT', 4:'HaNDle',
    5:'JOG', 6:'Teach in JOG', 7:'Teach in HaNDle',
    8:'INC feed', 9:'REFerence', 10:'ReMoTe',
};
const RUN_MODES_16 = { 0:'****', 1:'STOP', 2:'HOLD', 3:'STaRt', 4:'MSTR' };
const RUN_MODES_15 = {
    0:'STOP', 1:'HOLD', 2:'STaRt', 3:'MSTR', 4:'ReSTaRt',
    5:'PRSR', 6:'NSRC', 7:'ReSTaRt*', 8:'ReSET', 13:'HPCC',
};
const EMG_STATES = { 0:null, 1:'EMERGENCY', 2:'RESET', 3:'WAIT' };
// motion is 0 = ***, 1 = MoTioN, 2 = DWeLl, 3 = WAIT. Module-level so fnStatusInfo
// and fnStatusInfo2 label it the same way — the same field must not be `Moving` from
// one function and `1` from the other.
const MOTION = { 0: 'Stopped', 1: 'Moving', 2: 'Dwelling', 3: 'Waiting' };
const ALM_STATES = {
    0:null, 1:'ALARM', 2:'BATTERY LOW', 3:'FAN',
    4:'PS WARNING', 5:'FSSB WARNING', 6:'INSULATE WARNING',
    7:'ENCODER WARNING', 8:'PMC ALARM',
};
// cnc_rdalmmsg alarm categories. `type` is an index into a per-series enum, NOT a
// universal code — the same number means different things on different series. The same
// per-series numbering indexes cnc_alarm/cnc_alarm2's status bitmask, which is why one
// table serves both (see fnAlarmStatus).
// FOCAS2 spec: docs/FANUC_Focas_API/Document/SpecE/Misc/cnc_rdalmmsg.xml
const ALM_TYPES_15I = {
    0:'Background P/S (BG)', 1:'Foreground P/S (PS)', 2:'Overheat alarm (OH)',
    3:'Sub-CPU error (SB)', 4:'Syncronized error (SN)', 5:'Parameter switch on (SW)',
    6:'Overtravel,External data (OT)', 7:'PMC error (PC)', 8:'External alarm message (1) (EX)',
    10:'Serious P/S (SR)', 12:'Servo alarm (SV)', 13:'I/O error (IO)',
    14:'Power off parameter set (PW)', 15:'System alarm (SY)', 16:'External alarm message (2) (EX)',
    17:'External alarm message (3) (EX)', 18:'External alarm message (4) (EX)',
    19:'Macro alarm (MC)', 20:'Spindle alarm (SP)',
};
const ALM_TYPES_16I = {
    0:'P/S100', 1:'P/S000', 2:'P/S101', 3:'P/S alarm except above', 4:'Overtravel alarm',
    5:'Overheat alarm', 6:'Servo alarm', 7:'System alarm', 8:'APC alarm', 9:'Spindle alarm',
    10:'P/S alarm(No.5000,..), Punchpress alarm', 11:'Laser alarm', 13:'Rigid tap alarm',
    15:'External alarm message',
};
const ALM_TYPES_30I = {
    0:'Parameter switch on (SW)', 1:'Power off parameter set (PW)', 2:'I/O error (IO)',
    3:'Foreground P/S (PS)', 4:'Overtravel,External data (OT)', 5:'Overheat alarm (OH)',
    6:'Servo alarm (SV)', 7:'Data I/O error (SR)', 8:'Macro alarm (MC)', 9:'Spindle alarm (SP)',
    10:'Other alarm (DS)', 11:'Alarm concerning Malfunction prevent functions (IE)',
    12:'Background P/S (BG)', 13:'Syncronized error (SN)', 14:'(reserved)',
    15:'External alarm message (EX)', 19:'PMC error (PC)',
};
const ALM_TYPE_ALL = -1;   // -1 = all type, valid on every series

// Pick the enum / text width that applies to this controller.
//
// The controller's own CNC type decides. cnc_series is only what the flow was configured
// with, and a flow copied from another machine carries that machine's series — letting it
// win relabels every alarm while leaving type_code untouched, so a wrong table is silent.
// It is consulted only when cnc_type says nothing usable.
//
// NOTE: cnc_type ' 0' covers the whole 0i family and cannot distinguish 0i-A/B/C (16i enum)
// from 0i-D/F (30i enum), and the Series selector cannot express that either. 0i-D/F is by
// far the more common today, so it is the default; the raw numeric code is reported
// alongside the label so a wrong guess is never silent.
function almSeriesGroup(focas, cncSeries) {
    const t = String((focas.sysinfo && focas.sysinfo.cnctype) || '').trim();
    if (['30', '31', '32', '35'].includes(t))        return '30i';
    if (['16', '18', '21', 'PD', 'PH'].includes(t))  return '16i';   // incl. Power Mate i-D/H
    if (t === '15')                                  return '15i';
    if (t === 'PM' || t === '0')                     return '30i';   // PMi-A / Series 0i
    // cnc_type unusable — older firmware or an unexpected value: fall back to the config.
    return cncSeries === '15' ? '15i' : '16i';
}
const ALM_TYPES_BY_GROUP = { '15i': ALM_TYPES_15I, '16i': ALM_TYPES_16I, '30i': ALM_TYPES_30I };
const ALARM_MAX_MSGS = 10;   // messages read per poll

// pmc_rdalmmsg paging. Unlike cnc_rdalmmsg this call reports whether alarms are still
// waiting, so it pages instead of truncating — capped, because a controller that keeps
// answering "more" must not be able to run the loop away.
const PMC_ALARM_PAGE      = 10;   // messages asked for per call
const PMC_ALARM_MAX_PAGES = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────
function readParamVal(paramMap, key) {
    return (paramMap && paramMap[key]) ? paramMap[key].data[0] : null;
}

function buildTimer(minVal, msVal = null) {
    if (minVal === null || minVal === undefined)
        return { total_seconds: null, formatted: null };
    const ms       = (msVal !== null && msVal !== undefined) ? msVal : 0;
    const totalSec = minVal * 60 + ms / 1000;
    const h        = Math.floor(totalSec / 3600);
    const rem      = Math.floor(totalSec % 3600);
    const m        = Math.floor(rem / 60);
    const s        = Math.floor(rem % 60);
    const frac     = Math.round(totalSec * 1000) % 1000;
    const formatted = msVal !== null
        ? `${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}.${String(frac).padStart(3,'0')}s`
        : `${h}h ${String(m).padStart(2,'0')}m`;
    return { total_seconds: Math.round(totalSec * 1000) / 1000, formatted };
}

// ── Function implementations ──────────────────────────────────────────────────

async function fnStatusInfo(focas, runModes) {
    const state = await focas.statinfo();
    if (!state) return null;
    // mstb is 0 = "***" (others) and 1 = FIN — the M/S/T/B function has FINished, not
    // "is active". motion is 0 = ***, 1 = MoTioN, 2 = DWeLl, so a dwell is not "Moving".
    // Both labels used to collapse the enum to a boolean. Spec: cnc_statinfo.xml.
    return {
        mode:      state.aut in AUT_MODES ? AUT_MODES[state.aut] : String(state.aut),
        run_state: state.run in runModes ? runModes[state.run] : String(state.run),
        motion:    MOTION[state.motion] ?? `UNKNOWN(${state.motion})`,
        mstb:      state.mstb === 1 ? 'Finished' : 'Inactive',
        emergency: (state.emegency in EMG_STATES) ? EMG_STATES[state.emegency] : `UNKNOWN(${state.emegency})`,
        alarm:     (state.alarm    in ALM_STATES) ? ALM_STATES[state.alarm]    : `ALARM(${state.alarm})`,
        edit:      state.edit   ? 'Active' : 'Inactive',
    };
}

async function fnSystemInfo(focas) {
    const si = focas.sysinfo;
    // `axes` is the CURRENT controlled axis count (ASCII, e.g. "05"), not max_axis.
    // cnc_sysinfo.xml documents both: max_axis is the maximum the CNC can control,
    // axes is how many it controls now. Reporting max_axis as `axes` said 32 for a
    // 5-axis machine (measured 2026-11-12 on the 31i at 10.192.233.166).
    const cur = parseInt(String(si.axes || '').trim(), 10);
    return {
        cnc_type: si.cnctype.trim(),
        mt_type:  si.mttype.trim(),
        series:   si.series.trim(),
        version:  si.version.trim(),
        axes:     Number.isNaN(cur) ? null : cur,
        max_axes: si.maxaxis,
    };
}

async function fnTimers(focas) {
    // FOCAS is strictly sequential — no Promise.all on a single socket
    const p6750 = await focas.readparam3(ALLAXIS, 6750);
    const p6751 = await focas.readparam3(ALLAXIS, 6751);
    const p6752 = await focas.readparam3(ALLAXIS, 6752);
    const p6753 = await focas.readparam3(ALLAXIS, 6753);
    const p6754 = await focas.readparam3(ALLAXIS, 6754);
    const p6757 = await focas.readparam3(ALLAXIS, 6757);
    const p6758 = await focas.readparam3(ALLAXIS, 6758);
    return {
        power_on_time:       buildTimer(readParamVal(p6750, 6750)),
        auto_operation_time: buildTimer(readParamVal(p6752, 6752), readParamVal(p6751, 6751)),
        cutting_time:        buildTimer(readParamVal(p6754, 6754), readParamVal(p6753, 6753)),
        cycle_time:          buildTimer(readParamVal(p6758, 6758), readParamVal(p6757, 6757)),
    };
}

async function fnProgramNumber(focas) {
    const prognum = await focas.readprognum();
    if (!prognum) return null;
    const runNum   = prognum.run;
    const mainNum  = prognum.main;
    const progList = await focas.listprog(Math.min(runNum, mainNum));
    const cmt = (n) => (progList && progList[n]) ? (progList[n].comment.trim() || null) : null;
    return {
        running_program:  `O${runNum}`,
        main_program:     `O${mainNum}`,
        running_comment:  cmt(runNum),
        main_comment:     cmt(mainNum),
    };
}

async function fnPartCount(focas) {
    const p6711 = await focas.readparam3(ALLAXIS, 6711);
    const p6712 = await focas.readparam3(ALLAXIS, 6712);
    return {
        required_parts:  readParamVal(p6711, 6711),
        lifetime_total:  readParamVal(p6712, 6712),
    };
}

// ── Tool life ─────────────────────────────────────────────────────────────────
// One entry per tool group, with the raw values kept alongside the derived ones.
// Remaining life prefers the CNC's own rest counter when it reports one: with tool
// life management B it is the value the change decision actually uses and can differ
// from life-counter. Without B (or on a T series) the spec says life_rest is always
// 0, so it falls back to life-counter. A group with no life set (0) gets null, not
// 0, for both remaining and usage — "0 remaining" would read as a spent tool.
function makeToolGroup(g, usingGroup) {
    const life    = g.count_value;
    const counter = g.counter;
    return {
        group:         g.grp_no,
        tool_count:    g.n_tool,
        life,
        counter,
        remaining:     life > 0
            ? (g.life_rest > 0 ? g.life_rest : Math.max(0, life - counter))
            : null,
        usage_percent: life > 0 ? Math.min(100, Math.max(0, counter * 100 / life)) : null,
        count_type:    g.count_type,
        unit:          g.count_type === 1 ? 'minute' : 'count',
        in_use:        usingGroup === g.grp_no,
        life_rest_raw: g.life_rest,
    };
}

// The group closest to needing a change. Null unless some group has actually been used:
// a group with no life set has a null usage, and one with life set but never used sits at
// 0% — naming either as "most used" would point at a freshly loaded tool.
function pickMostUsedGroup(groups) {
    let best = null;
    let bestUsage = 0;
    for (const g of groups) {
        if (g.usage_percent === null || g.usage_percent <= bestUsage) continue;
        bestUsage = g.usage_percent;
        best = g.group;
    }
    return best;
}

// Tool-life overview (cnc_rdgrpinfo4 + cnc_rdtlinfo + cnc_rdngrp + cnc_rdusegrpid).
// Needs the CNC's "tool life management" option; without it the per-group read is
// what surfaces EW_NOOPT. The limits and the group count are display aids, so a
// failure there falls back to zero rather than sinking the whole item.
//
// A failed sub-read is NOT reported in the payload. It is logged through `log` so the
// reason is still recoverable from the Node-RED log, but the payload carries only data:
// a zero here means "the controller said zero", and a caller that needs to know whether
// the option is fitted should call the Tool Life function, which raises.
async function fnToolLife(focas, log) {
    let info = { max_group: 0, max_tool: 0, max_minute: 0, max_cycle: 0 };
    let groupCount = 0;
    let use = { next: 0, use: 0, slct: 0 };

    try { info = await focas.readtlinfo(); }
    catch (e) { log('tool_life.readtlinfo', e); }
    try { groupCount = await focas.readngrp(); }
    catch (e) { log('tool_life.readngrp', e); }
    try { use = await focas.readusegrpid(); }
    catch (e) { log('tool_life.readusegrpid', e); }

    const usingGroup = use.use > 0 ? use.use : null;

    // Read every registered group a page at a time. The controller rejects a single large
    // cnc_rdgrpinfo4 (see TOOL_GROUP_PAGE) and its capacity is not known up front, so one
    // big block would fail on some machines and miss groups on others. Each stop matters:
    // an empty or short page is the last one; reaching the reported group count means we
    // are done; a page that does not move grpNo forward means the controller ignored it
    // (looping would repeat the same page forever); and stepping past max_group would be
    // answered with EW_NUMBER.
    const raw = [];
    const maxGroup = info.max_group > 0 ? info.max_group : Infinity;
    for (let grpNo = 1; ;) {
        const page = await focas.readgrpinfo4(grpNo);
        if (page.length === 0) break;
        raw.push(...page);
        if (page.length < TOOL_GROUP_PAGE) break;
        if (groupCount > 0 && raw.length >= groupCount) break;
        const last = page[page.length - 1].grp_no;
        if (last + 1 <= grpNo || last + 1 > maxGroup) break;
        grpNo = last + 1;
    }

    const groups = raw
        .filter(g => g.n_tool > 0)          // a group with no tools has no life to report
        .map(g => makeToolGroup(g, usingGroup));

    return {
        group_count:     groupCount,
        max_group:       info.max_group,
        max_tool:        info.max_tool,
        max_minute:      info.max_minute,
        max_cycle:       info.max_cycle,
        using_group:     usingGroup,
        next_group:      use.next > 0 ? use.next : null,
        selected_group:  use.slct > 0 ? use.slct : null,
        groups,
        most_used_group: pickMostUsedGroup(groups),
    };
}

async function fnAlarmMessages(focas, cncSeries) {
    const group = almSeriesGroup(focas, cncSeries);
    const types = ALM_TYPES_BY_GROUP[group];
    // cnc_rdalmmsg caps a message at 32 characters on every series — the spec says so
    // and points at cnc_rdalmmsg2 for the 30i family. Asking this call for 64 was never
    // supported: it has no text-length argument in its C signature, so a controller that
    // ignored the extra word would have answered 32 and every record would have been
    // sliced at the wrong stride. The 32 is passed explicitly so the intent is visible.
    const alarms = await focas.readalarmcode(ALM_TYPE_ALL, 1, ALARM_MAX_MSGS, 32);

    return (alarms || []).map(a => ({
        type:      a.alarmtype in types ? types[a.alarmtype] : String(a.alarmtype),
        type_code: a.alarmtype,
        code:      a.alarmcode,
        axis:      a.axis,
        text:      a.text,
    }));
}

// ── Alarm status word (cnc_alarm2) ────────────────────────────────────────────
// The same alarm *categories* cnc_rdalmmsg lists, but as a bitmask instead of a list:
// bit N of the status word is the condition that cnc_rdalmmsg reports as `type` N.
// The per-series tables line up exactly (15i bit #07 is PMC error and #08 external
// alarm message; 30i puts EX at #15 and PMC error at #19), so the table above is
// reused rather than written out twice. SpecE/Misc/cnc_alarm.xml vs cnc_rdalmmsg.xml.
//
// Read through cnc_alarm2, not cnc_alarm. This node is FOCAS2/Ethernet only, and the
// SDK's support matrix marks the 16-bit cnc_alarm unsupported ("X") over Ethernet on
// 16i/18i/21i; it also cannot carry the upper bits the 30i family uses. It costs
// nothing to prefer the wider call — captured traffic shows the library sending a
// byte-identical request for both and only the struct width differing (docs/notes.md).
//
// The word can be set with nothing in active_alarms to match it: a status bit is a
// condition, not necessarily one the controller turns into a message.
async function fnAlarmStatus(focas, cncSeries) {
    const types = ALM_TYPES_BY_GROUP[almSeriesGroup(focas, cncSeries)];
    const st    = await focas.readalarmstatus2();
    return {
        status: st.status,
        bits:   st.bits.map(bit => ({ bit, label: types[bit] ?? String(bit) })),
    };
}

// ── PMC alarms (pmc_rdalmmsg) ─────────────────────────────────────────────────
// The PMC's own ERxx/WNxx messages — ROM parity, I/O allocation errors, ladder size
// errors. These are the PMC failing, NOT the ladder's external (EX) messages: those
// arrive as CNC alarms and live in active_alarms, which is why this is its own field
// rather than being merged in.
async function fnPmcAlarms(focas) {
    const out = [];
    let sNumber = 1;                    // s_number is 1-based
    for (let page = 0; page < PMC_ALARM_MAX_PAGES; page++) {
        const r = await focas.readpmcalarm(sNumber, PMC_ALARM_PAGE);
        for (const a of r.alarms) out.push({ message: a.message });
        // Stop unless there is genuinely more to ask for; a "more" with nothing read
        // would advance sNumber by nothing and loop on the same page.
        if (!r.more || r.read_num <= 0) break;
        sNumber += r.read_num;
    }
    return out;
}

// ── Tool offsets (read-only) ──────────────────────────────────────────────────
// The compensation table: how many offsets the machine has, and the values. Read with
// cnc_rdtofsinfo + cnc_rdtofsr, whose opcodes were captured from the vendor library
// (0x0a and 0x08 — see docs/notes.md; the 0x2c/0x2d/0x2e that look adjacent are other
// functions and answer the same bytes for every argument).
//
// Only reads. There is no write path here on purpose: a wrong write opcode changes a
// machine's offsets, and none of the write calls has been captured.
//
// The range form is used because it is 33x faster than one call per offset — measured
// on the 31i at 10.192.233.166, 396 single reads took 5.5 s against 163 ms for four
// range reads. Its `type` numbering is NOT the single form's, though: measured over
// the whole table, range type = 3 - single type, so the spec's enum (which the single
// form follows) is mapped onto it here rather than being assumed.
const TOFS_MAX_OFFSETS = 999;   // the largest table the spec lists; a bad use_no is clamped

// single type (spec enum) → range type. Measured 2026-11-13 on the 31i at
// 10.192.233.166 over offsets 1..20: single 0↔range 3, 1↔2, 2↔1, 3↔0.
const TOFS_RANGE_TYPE = { 0: 3, 1: 2, 2: 1, 3: 0 };

async function fnToolOffsets(focas) {
    const info = await focas.readtofsinfo();
    // The four types an M series has: cutter radius and tool length, wear and geometry.
    // A T series has X/Z/nose-R under the same numbers, so the label comes from the
    // controller's mt_type via tofsTypeName().
    const TYPES = [0, 1, 2, 3];
    const count = Math.min(Math.max(0, info.use_no | 0), TOFS_MAX_OFFSETS);

    // One range read per type, then transpose into one entry per offset number.
    const byType = {};
    for (const t of TYPES) {
        const rangeType = TOFS_RANGE_TYPE[t];
        byType[t] = rangeType === undefined
            ? []
            : await focas.readtofsr(1, count, rangeType);
    }

    const offsets = [];
    for (let i = 0; i < count; i++) {
        const entry = { number: i + 1, values: {} };
        for (const t of TYPES) {
            const r = byType[t][i];
            entry.values[t] = r
                ? { label: focas.tofsTypeName(t), value: r.value, raw: r.raw, dec: r.dec }
                : null;
        }
        offsets.push(entry);
    }

    return {
        ofs_type: info.ofs_type,
        memory:   info.memory,
        use_no:   info.use_no,
        types:    TYPES.map(t => ({ type: t, label: focas.tofsTypeName(t) })),
        offsets,
    };
}

async function fnAxesData(focas, axisType) {
    // Each sub-type delegates to the matching reader in focas.js; the position ones
    // are the `what` bitmask readaxes() takes.
    switch (axisType) {
        case 'feedrate':
            return { actual_feedrate_mm_min: await focas.readactfeed() };
        case 'spindle_speed':
            return { actual_spindle_rpm: await focas.readactspindlespeed() };
        case 'spindle_load': {
            // One value per spindle; the scalar is the first spindle so existing
            // flows keep working, the array carries the rest.
            const loads = await focas.readspmeter();
            return {
                spindle_load_percent:  loads.length ? loads[0] : null,
                spindle_load_percents: loads,
                spindle_load_names:    await focas.readspindlenames(loads.length),
            };
        }
        case 'servo_load': {
            const loads = await focas.readsvmeter();
            return {
                servo_load_percent: loads,
                servo_load_axes:    await focas.readaxisnames(loads.length),
            };
        }
        case 'servo_current': {
            // Same opcode as the load meter, read with the selector that makes the
            // controller answer in Ampere. Reported as a magnitude like the per-cent
            // array, so a regenerating axis reads positive here too.
            const amps = await focas.readservocurrent();
            return {
                servo_load_current_amps: amps,
                servo_load_axes:         await focas.readaxisnames(amps.length),
            };
        }
        case 'abs_pos':
            return { absolute_position: await focas.readaxes(1) };
        case 'rel_pos':
            return { relative_position: await focas.readaxes(2) };
        case 'dist_to_go':
            return { distance_to_go: await focas.readaxes(16) };
        case 'machine_pos':
            return { machine_position: await focas.readaxes(4) };
        default:
            return null;
    }
}

// Every axes reading All Data carries, in one block, in this order — the servo readings
// sit together, and feedrate / spindle speed are left out because they already have their
// own fields under feedrate_spindle.
const AXES_SUBTYPES_ALL = [
    'abs_pos', 'machine_pos', 'rel_pos', 'dist_to_go',
    'servo_load', 'servo_current', 'spindle_load',
];

async function fnAxesDataAll(focas) {
    const out = {};
    for (const subtype of AXES_SUBTYPES_ALL) {
        Object.assign(out, (await fnAxesData(focas, subtype)) || {});
    }
    return out;
}

async function fnParameters(focas, paramNums) {
    // paramNums is a comma-separated string of parameter numbers
    const nums = String(paramNums).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const result = {};
    for (const n of nums) {
        const r = await focas.readparam3(ALLAXIS, n);
        if (r && r[n]) result[n] = r[n].data[0];
    }
    return result;
}

async function fnMacro(focas, macroNums) {
    const nums = String(macroNums).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const result = {};
    for (const n of nums) {
        const r = await focas.readmacro(n);
        if (r && r[n] !== undefined) result[n] = r[n];
    }
    return result;
}

// ── Tier-1/2 reads ───────────────────────────────────────────────────────────
// Every function below is read-only and none of them pauses CNC-side history
// sampling. Their opcodes and wire layouts were captured on 2026-11-13 and are
// written up in docs/notes.md.
//
// Series support is NOT uniform. From each function's SpecE <support> table
// (O = both, E = Ethernet only, H = HSSB only, X = cannot be used) — this node is
// Ethernet, so H and X both mean "not on this machine":
//
//   cnc_rdcncid     0i-D/F, 30i only
//   cnc_statinfo2   0i-D/F, 30i only
//   cnc_rdpm_item   16i-B and later
//   cnc_rdcommand   15i, 0i-D/F, 30i (NOT 16i/18i/21i — those need cnc_modal)
//   the rest        15i and later, but HSSB-only on the non-i series
//
// A failure there is EW_FUNC (1) or EW_NODLL (-15), which is "this series does not
// have it", not a fault. That is why these are NOT in All Data's mandatory path.

// The machine's stable identity. This is the only identifier here that survives a
// software upgrade, so a multi-machine deployment should key on it rather than on
// cnc_sysinfo's series/version, which every machine of the same model shares.
async function fnMachineId(focas) {
    const id = await focas.readcncid();
    return { cncid: id.hex, cncid_values: id.values };
}

// Work-zero offsets: the count, then one value per offset per axis. The axis count
// comes from the controller, never from the configured maximum.
async function fnWorkZeroOffsets(focas, maxAxis) {
    const info = await focas.readzofsinfo();
    const useNo = Math.max(0, info.use_no | 0);
    const axes = Math.max(1, maxAxis | 0);

    const offsets = [];
    for (let n = 1; n <= useNo; n++) {
        const entry = { number: n, values: {} };
        for (let a = 1; a <= axes; a++) {
            try {
                const r = await focas.readzofs(n, a);
                entry.values[a] = { value: r.value, raw: r.raw, dec: r.dec, unit: r.unit };
            } catch (e) {
                // An axis the table does not have answers EW_ATTRIB; that is a
                // property of the table, not a failure of the read.
                entry.values[a] = null;
            }
        }
        offsets.push(entry);
    }
    return { use_no: info.use_no, axis_count: axes, offsets };
}

// Sequence number of the block being executed. A program with no N numbers leaves
// this at the last one it saw, so it is a progress hint, not an exact position.
async function fnSequenceNumber(focas) {
    return { sequence_number: await focas.readseqnum() };
}

// Modal and commanded F/S/T/B. `present` comes from flag bit 0x0800, which is what
// separates "no command" from "command is zero".
async function fnCommand(focas, which) {
    const type = which === 'commanded' ? -2 : -1;
    const records = await focas.readcommand(type, 1);
    const out = {};
    for (const r of records) {
        if (!r.present) continue;
        // M codes carry a number (M1..M5); the others do not.
        const key = r.number ? `${r.address}${r.number}` : r.address;
        out[key] = { value: r.value, raw: r.raw, dec: r.dec, address: r.address, number: r.number };
    }
    return { block: which === 'commanded' ? 'commanded' : 'modal', commands: out };
}

// Program memory: registered/available programs and used/unused memory.
async function fnProgramMemory(focas) {
    const p = await focas.readproginfo();
    const total = p.used_mem + p.unused_mem;
    return {
        registered_programs: p.registered,
        available_programs:  p.available,
        used_memory:         p.used_mem,
        unused_memory:       p.unused_mem,
        // A percentage needs a denominator; 0 total is null, not 0 %.
        used_percent: total > 0 ? Math.round(p.used_mem * 1000 / total) / 10 : null,
    };
}

// The CNC's maintenance items. `total`/`remain` are in whatever unit `type` selects
// and the interface does not return that unit, so the raw numbers are kept.
async function fnMaintenance(focas) {
    const items = await focas.readpm_item(1, 10);
    return {
        items: items.map((it, i) => ({
            index:  i + 1,
            name:   it.name || null,
            type:   it.type,
            total:  it.total,
            remain: it.remain,
            stat:   it.stat,
            // A percentage needs a denominator; 0 total is null, not 0 %.
            remain_percent: it.total > 0
                ? Math.round(it.remain * 1000 / it.total) / 10
                : null,
        })),
    };
}

// The block counter. Needs the program-restarting option; without it the controller
// answers EW_NOOPT (6), which is "not fitted", not a fault.
async function fnBlockCount(focas) {
    return { block_count: await focas.readblkcount() };
}

// The CNC calendar. One call returns both date and time; focas.js reads twice
// because the first call of a session can carry stale bytes in the tail.
async function fnCalendar(focas) {
    const t = await focas.gettimer();
    const pad = (v, n = 2) => String(v).padStart(n, '0');
    return {
        year: t.year, month: t.month, day: t.day,
        hour: t.hour, minute: t.minute, second: t.second,
        date: `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`,
        time: `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`,
        // The CNC clock carries no timezone. Do not label it UTC or local.
        iso_like: `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T` +
                  `${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`,
    };
}

// The extended run status. Only 0i-D/F and 30i have it; elsewhere it is EW_FUNC.
//
// The fields that cnc_statinfo also reports are labelled with the SAME tables
// fnStatusInfo uses, so a flow can read either function and get the same strings.
// Returning raw enums here would mean the same field is `MEMory` from one function
// and `1` from the other, which is a trap for whoever wires them together.
// The fields cnc_statinfo does not have (warning, o3d_check, ext_option, restart)
// are raw: their enums are not the same across series and nothing here interprets
// them.
async function fnStatusInfo2(focas, runModes) {
    const s = await focas.statinfo2();
    return {
        handle_retrace: s.hdck,
        tm_mode:        s.tmmode,
        mode:           s.aut in AUT_MODES ? AUT_MODES[s.aut] : String(s.aut),
        run_state:      s.run in runModes ? runModes[s.run] : String(s.run),
        motion:         MOTION[s.motion] ?? `UNKNOWN(${s.motion})`,
        mstb:           s.mstb === 1 ? 'Finished' : 'Inactive',
        emergency:      (s.emergency in EMG_STATES) ? EMG_STATES[s.emergency]
                                                    : `UNKNOWN(${s.emergency})`,
        alarm:          (s.alarm in ALM_STATES) ? ALM_STATES[s.alarm] : `ALARM(${s.alarm})`,
        edit:           s.edit ? 'Active' : 'Inactive',
        // Not in cnc_statinfo; raw, because the enum is per-series.
        warning:        s.warning,
        o3d_check:      s.o3dchk,
        ext_option:     s.ext_opt,
        restart:        s.restart,
    };
}

// ── PMC data window ──────────────────────────────────────────────────────────
// The one read here that reaches machine-builder signals rather than FANUC's own
// data: door interlocks, clamps, cycle-complete, counters, whatever the ladder
// exposes. The address map is the machine builder's, so nothing here interprets it.
//
// `params` is a comma-separated list of specs, each `<area><address>[:<type>]`:
//
//     R0.0        one bit of R0
//     R0          R0 as a byte
//     D100:word   D100 as a 16-bit word
//     D100:long   D100 as a 32-bit long
//     K0.0        one bit of K0
//
// A bit spec reads the byte holding the bit and masks it here, because the wire
// returns one byte per bit and the caller should not have to know that.
// The PMC data-type ENUM (FwSymbol.h: byte 0, word 1, long 2) is not the byte
// WIDTH of that type (1, 2, 4). Keeping them apart matters: passing the enum where a
// width is expected asks for a 1-byte range and the controller answers 1 byte.
const PMC_TYPE_NAMES = { byte: PMC_BYTE, word: PMC_WORD, long: PMC_LONG };
const PMC_TYPE_WIDTH = { byte: 1, word: 2, long: 4 };

function parsePmcSpec(spec) {
    const m = /^([A-Za-z])\s*(\d+)(?:\.(\d+))?(?::(byte|word|long))?$/.exec(String(spec).trim());
    if (!m) return null;
    const area = m[1].toUpperCase();
    if (PMC_AREAS[area] === undefined) return null;
    const address = parseInt(m[2], 10);
    const bit = m[3] === undefined ? null : parseInt(m[3], 10);
    if (bit !== null && (bit < 0 || bit > 7)) return null;
    // A bit spec reads the byte holding the bit; anything else defaults to byte.
    const typeName = m[4] || 'byte';
    return { spec: String(spec).trim(), area, address, bit, typeName };
}

async function fnPmcRead(focas, params) {
    const specs = String(params || '').split(',').map(s => s.trim()).filter(Boolean);
    if (specs.length === 0) {
        throw new Error('PMC read: params is empty — give at least one address, e.g. "R0.0,D100:word"');
    }
    if (specs.length > 128) {
        throw new Error(`PMC read: ${specs.length} addresses requested, the limit is 128`);
    }

    const parsed = specs.map(parsePmcSpec);
    const bad = specs.filter((s, i) => parsed[i] === null);
    if (bad.length) {
        throw new Error(
            `PMC read: cannot parse ${bad.map(s => JSON.stringify(s)).join(', ')} — ` +
            `expected <area><address>[:byte|word|long] or <area><address>.<bit>, ` +
            `areas ${Object.keys(PMC_AREAS).join('/')}`
        );
    }

    const values = [];
    for (const p of parsed) {
        // The byte WIDTH of the requested type, not its enum value.
        const width = PMC_TYPE_WIDTH[p.typeName];
        const end = p.address + width - 1;
        const raw = await focas.readpmc(p.area, p.address, end, PMC_BYTE);

        if (p.bit !== null) {
            const byte = raw[0];
            values.push({
                spec: p.spec, area: p.area, address: p.address, bit: p.bit,
                value: (byte >> p.bit) & 1,
                byte,
            });
        } else {
            // readpmc was asked for bytes; assemble the wider value here so there is
            // one ordering rule (little-endian within each 2-byte word) rather than
            // three. See decodePmcBytes in focas.js.
            let value;
            if (width === 1) value = raw[0];
            else if (width === 2) value = raw[0] | (raw[1] << 8);
            else value = (raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >>> 0;
            values.push({
                spec: p.spec, area: p.area, address: p.address, bit: null,
                type: p.typeName, value,
                hex: '0x' + value.toString(16).padStart(width * 2, '0'),
            });
        }
    }
    return { values };
}

// ── All-in-one (legacy behaviour) ────────────────────────────────────────────
async function fnAll(focas, runModes, cncSeries, log) {
    // Each field is read independently: one failing function degrades that field to null
    // instead of blanking the whole snapshot.
    //
    // The payload carries NO error channel. A failed field is `null` and the reason goes
    // to the Node-RED log through `log`, so the payload stays pure data — a consumer can
    // map it straight onto OPC UA / MQTT / a database without filtering out a diagnostic
    // key. `null` means "not read"; `[]` means "read cleanly, found nothing"; a number
    // means the controller reported that number.
    const read = async (key, fn) => {
        try { return await fn(); }
        catch (e) { log(key, e); return null; }
    };

    const status  = await read('machine_state',      () => fnStatusInfo(focas, runModes));
    const sysinfo = await read('controller',         () => fnSystemInfo(focas));
    const timers  = await read('timers',             () => fnTimers(focas));
    const program = await read('active_program',     () => fnProgramNumber(focas));
    const parts   = await read('part_count',         () => fnPartCount(focas));
    const alarms  = await read('active_alarms',      () => fnAlarmMessages(focas, cncSeries));
    const almstat = await read('alarm_status',       () => fnAlarmStatus(focas, cncSeries));
    const pmcalm  = await read('pmc_alarms',         () => fnPmcAlarms(focas));
    const feed    = await read('actual_feedrate_mm_min', () => focas.readactfeed());
    const spindle = await read('actual_spindle_rpm',     () => focas.readactspindlespeed());
    const axes    = await read('axes_data',          () => fnAxesDataAll(focas));
    const tlife   = await read('tool_life',          () => fnToolLife(focas, log));
    const tofs    = await read('tool_offsets',       () => fnToolOffsets(focas));

    // ── tier-1/2 fields ──────────────────────────────────────────────────────
    // These are in All Data because each one is a single cheap read, and each
    // degrades to null on a series that does not have it.
    //
    // They are NOT free on an older machine: cnc_rdcncid and cnc_statinfo2 are
    // 0i-D/F and 30i only, cnc_rdpm_item starts at 16i-B, and cnc_rdcommand is
    // absent on 16i/18i/21i. On those each costs a round trip and returns EW_FUNC.
    // A flow that polls a mixed fleet should use the individual functions instead.
    const machineId = await read('machine_id',       () => fnMachineId(focas));
    const seqnum    = await read('sequence_number',  () => fnSequenceNumber(focas));
    const modal     = await read('modal_commands',   () => fnCommand(focas, 'modal'));
    const progmem   = await read('program_memory',   () => fnProgramMemory(focas));
    const maint     = await read('maintenance',      () => fnMaintenance(focas));
    const blkcount  = await read('block_count',      () => fnBlockCount(focas));
    const calendar  = await read('calendar',         () => fnCalendar(focas));
    const status2   = await read('machine_state_ext', () => fnStatusInfo2(focas, runModes));

    return {
        controller:       sysinfo,
        machine_id:       machineId,
        machine_state:    status,
        machine_state_ext: status2,
        active_program:   program,
        sequence_number:  seqnum,
        modal_commands:   modal,
        program_memory:   progmem,
        maintenance:      maint,
        block_count:      blkcount,
        calendar:         calendar,
        timers,
        part_count:       parts,
        feedrate_spindle: { actual_feedrate_mm_min: feed, actual_spindle_rpm: spindle },
        axes_data:        axes,
        tool_life:        tlife,
        tool_offsets:     tofs,
        active_alarms:    alarms,
        alarm_status:     almstat,
        pmc_alarms:       pmcalm,
    };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
// `log(key, err)` receives the reason a field could not be read. The payload carries
// no error channel, so this is where that information goes instead — the node passes
// its own logger, and a standalone caller can pass a no-op.
async function collect(ip, port, cnc_series, fn, subtype, params, log = () => {}) {
    const focas    = new Focas(ip, port);
    const runModes = cnc_series === '15' ? RUN_MODES_15 : RUN_MODES_16;

    let result;
    try {
        // Inside the try: a refused connect must still reach disconnect(), or the
        // socket sits there holding one of the controller's session slots.
        await focas.connect();
        switch (fn) {
            case 'status_info':    result = await fnStatusInfo(focas, runModes);   break;
            case 'system_info':    result = await fnSystemInfo(focas);             break;
            case 'timers':         result = await fnTimers(focas);                 break;
            case 'program_number': result = await fnProgramNumber(focas);          break;
            case 'part_count':     result = await fnPartCount(focas);              break;
            case 'tool_life':      result = await fnToolLife(focas, log);          break;
            case 'tool_offsets':   result = await fnToolOffsets(focas);            break;
            case 'alarm_messages': result = await fnAlarmMessages(focas, cnc_series); break;
            case 'alarm_status':   result = await fnAlarmStatus(focas, cnc_series);   break;
            case 'pmc_alarms':     result = await fnPmcAlarms(focas);                 break;
            case 'axes_data':      result = await fnAxesData(focas, subtype);      break;
            case 'parameters':     result = await fnParameters(focas, params);     break;
            case 'macro':          result = await fnMacro(focas, params);          break;
            // ── tier-1/2 reads ────────────────────────────────────────────────
            case 'machine_id':     result = await fnMachineId(focas);              break;
            case 'work_zero_offsets':
                result = await fnWorkZeroOffsets(focas, parseInt(focas.sysinfo.axes, 10) || 1);
                break;
            case 'sequence_number': result = await fnSequenceNumber(focas);        break;
            case 'command':        result = await fnCommand(focas, subtype);       break;
            case 'program_memory': result = await fnProgramMemory(focas);          break;
            case 'maintenance':    result = await fnMaintenance(focas);            break;
            case 'block_count':    result = await fnBlockCount(focas);             break;
            case 'calendar':       result = await fnCalendar(focas);               break;
            case 'status_info2':   result = await fnStatusInfo2(focas, runModes); break;
            case 'pmc_read':       result = await fnPmcRead(focas, params);        break;
            case 'all':
            default:               result = await fnAll(focas, runModes, cnc_series, log); break;
        }
        // Object-spreading a list-shaped result would turn it into {"0":..,"1":..},
        // so alarm_messages keeps its array and gets the timestamp as a property.
        const timestamp = new Date().toISOString();
        result = Array.isArray(result)
            ? Object.assign(result, { timestamp })
            : { ...result, timestamp };
    } finally {
        await focas.disconnect();
    }
    return result;
}

// ── Node-RED registration ─────────────────────────────────────────────────────
module.exports = function(RED) {

    function FanucConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.host       = config.host       || '192.168.0.100';
        this.port       = parseInt(config.port) || 8193;
        this.cnc_series = config.cnc_series || '16';
    }
    RED.nodes.registerType('fanuc-config', FanucConfigNode);

    function FanucFocasNode(config) {
        RED.nodes.createNode(this, config);
        const node   = this;
        const server = RED.nodes.getNode(config.server);

        if (!server) {
            node.error('No FANUC config node selected');
            return;
        }

        // Polls are serialised per node. Every poll takes a FOCAS session and the
        // controller allows only a handful of them at once, so two messages handled
        // concurrently — an inject faster than a poll, or several nodes wired to one
        // inject — would have the later ones refused. Queueing costs latency on a
        // backed-up inject, but never drops a message and never opens a second session.
        let queue = Promise.resolve();

        async function poll(msg, send, done) {
            // Allow overriding function/subtype/params via msg
            const fn      = msg.function  || config.fn      || 'all';
            const subtype = msg.subtype   || config.subtype || 'feedrate';
            const params  = msg.params    || config.params  || '';

            // A field that could not be read becomes null in the payload; the reason
            // goes to the Node-RED log instead. The payload carries no error channel,
            // so this is the only place the cause survives — without it a null would
            // be indistinguishable from "the controller said nothing".
            const log = (key, err) => {
                node.warn(`${fn}: ${key} could not be read — ${err && err.message || err}`);
            };

            node.status({ fill:'blue', shape:'dot', text: fn });
            try {
                msg.payload = await collect(server.host, server.port, server.cnc_series,
                                            fn, subtype, params, log);
                node.status({ fill:'green', shape:'dot', text:'ok' });
                send(msg);
                done();
            } catch (err) {
                node.status({ fill:'red', shape:'ring', text: err.message });
                node.error(err.message, msg);
                done(err);
            }
        }

        node.on('input', function(msg, send, done) {
            // poll() reports through done() and does not reject, so the chain stays
            // alive; the catch is only a guard against a fault outside its try.
            queue = queue.then(() => poll(msg, send, done), () => poll(msg, send, done))
                         .catch(() => {});
        });

        node.on('close', () => node.status({}));
    }
    RED.nodes.registerType('fanuc-focas', FanucFocasNode);
};