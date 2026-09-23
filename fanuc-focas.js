'use strict';
let Focas, ALLAXIS;
try {
    const m = require('./focas');
    Focas   = m.Focas;
    ALLAXIS = m.ALLAXIS;
    if (typeof Focas !== 'function') {
        throw new Error(
            `focas.js exported Focas as '${typeof Focas}' (expected a class). ` +
            `Ensure focas.js is in the same directory as fanuc-focas.js.`
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
const ALM_STATES = {
    0:null, 1:'ALARM', 2:'BATTERY LOW', 3:'FAN',
    4:'PS WARNING', 5:'FSSB WARNING', 6:'INSULATE WARNING',
    7:'ENCODER WARNING', 8:'PMC ALARM',
};
// cnc_rdalmmsg alarm categories. `type` is an index into a per-series enum, NOT the
// bitmask used by cnc_alarm — the same index means different things on different series.
// FOCAS2 spec: lib/FOCAS2 Library/Document/SpecE/Misc/cnc_rdalmmsg.xml
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
// NOTE: cnc_type ' 0' covers the whole 0i family and cannot distinguish 0i-A/B/C
// (16i enum) from 0i-D/F (30i enum). 0i-D/F is by far the more common today, so it is
// the default; the raw numeric code is reported alongside the label so a wrong guess is
// never silent.
function almSeriesGroup(focas, cncSeries) {
    const t = String((focas.sysinfo && focas.sysinfo.cnctype) || '').trim();
    if (cncSeries === '15' || t === '15')            return '15i';
    if (['30', '31', '32', '35'].includes(t))        return '30i';
    if (['16', '18', '21', 'PD', 'PH'].includes(t))  return '16i';   // incl. Power Mate i-D/H
    if (t === 'PM' || t === '0')                     return '30i';   // PMi-A / Series 0i
    return cncSeries === '15' ? '15i' : '16i';
}
const ALM_TYPES_BY_GROUP = { '15i': ALM_TYPES_15I, '16i': ALM_TYPES_16I, '30i': ALM_TYPES_30I };
const ALARM_MAX_MSGS = 10;   // messages read per poll

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
    return {
        mode:      state.aut in AUT_MODES ? AUT_MODES[state.aut] : String(state.aut),
        run_state: state.run in runModes ? runModes[state.run] : String(state.run),
        motion:    state.motion ? 'Moving' : 'Stopped',
        mstb:      state.mstb   ? 'Active' : 'Inactive',
        emergency: (state.emegency in EMG_STATES) ? EMG_STATES[state.emegency] : `UNKNOWN(${state.emegency})`,
        alarm:     (state.alarm    in ALM_STATES) ? ALM_STATES[state.alarm]    : `ALARM(${state.alarm})`,
        edit:      state.edit   ? 'Active' : 'Inactive',
    };
}

async function fnSystemInfo(focas) {
    const si = focas.sysinfo;
    return {
        cnc_type: si.cnctype.trim(),
        mt_type:  si.mttype.trim(),
        series:   si.series.trim(),
        version:  si.version.trim(),
        axes:     si.maxaxis,
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

async function fnAlarmMessages(focas, cncSeries) {
    const group = almSeriesGroup(focas, cncSeries);
    const types = ALM_TYPES_BY_GROUP[group];
    // cnc_rdalmmsg caps a message at 32 chars; the 30i family (incl. 0i-D/F, PMi-A) can
    // go further and the spec recommends cnc_rdalmmsg2 there.
    const textlength = group === '30i' ? 64 : 32;

    let alarms;
    try {
        alarms = await focas.readalarmcode(ALM_TYPE_ALL, 1, ALARM_MAX_MSGS, textlength);
    } catch (e) {
        // Only retry when the CNC itself rejected the request — never after a transport fault.
        if (textlength === 32 || !/^cnc_rdalmmsg: CNC returned/.test(e.message)) throw e;
        // Firmware that rejects the extended width still answers the documented 32.
        alarms = await focas.readalarmcode(ALM_TYPE_ALL, 1, ALARM_MAX_MSGS, 32);
    }

    return (alarms || []).map(a => ({
        type:      a.alarmtype in types ? types[a.alarmtype] : String(a.alarmtype),
        type_code: a.alarmtype,
        code:      a.alarmcode,
        axis:      a.axis,
        text:      a.text,
    }));
}

async function fnAxesData(focas, axisType) {
    // axisType maps to the what bitmask used in readaxes()
    // Implemented directly via _reqSingle for the data types we need
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

// ── All-in-one (legacy behaviour) ────────────────────────────────────────────
async function fnAll(focas, runModes, cncSeries) {
    // Each field is read independently: one failing function degrades that field to null
    // instead of blanking the whole snapshot. The reason lands in `errors`, keyed by the
    // payload field it belongs to, so a null is never mistaken for "read cleanly, empty".
    const errors = {};
    const read = async (key, fn) => {
        try { return await fn(); }
        catch (e) { errors[key] = e.message || String(e); return null; }
    };

    const status  = await read('machine_state',      () => fnStatusInfo(focas, runModes));
    const sysinfo = await read('controller',         () => fnSystemInfo(focas));
    const timers  = await read('timers',             () => fnTimers(focas));
    const program = await read('active_program',     () => fnProgramNumber(focas));
    const parts   = await read('part_count',         () => fnPartCount(focas));
    const alarms  = await read('active_alarms',      () => fnAlarmMessages(focas, cncSeries));
    const feed    = await read('actual_feedrate_mm_min', () => focas.readactfeed());
    const spindle = await read('actual_spindle_rpm',     () => focas.readactspindlespeed());

    return {
        controller:       sysinfo,
        machine_state:    status,
        active_program:   program,
        timers,
        part_count:       parts,
        feedrate_spindle: { actual_feedrate_mm_min: feed, actual_spindle_rpm: spindle },
        active_alarms:    alarms,
        errors,
    };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function collect(ip, port, cnc_series, fn, subtype, params) {
    const focas    = new Focas(ip, port);
    const runModes = cnc_series === '15' ? RUN_MODES_15 : RUN_MODES_16;

    await focas.connect();
    let result;
    try {
        switch (fn) {
            case 'status_info':    result = await fnStatusInfo(focas, runModes);   break;
            case 'system_info':    result = await fnSystemInfo(focas);             break;
            case 'timers':         result = await fnTimers(focas);                 break;
            case 'program_number': result = await fnProgramNumber(focas);          break;
            case 'part_count':     result = await fnPartCount(focas);              break;
            case 'alarm_messages': result = await fnAlarmMessages(focas, cnc_series); break;
            case 'axes_data':      result = await fnAxesData(focas, subtype);      break;
            case 'parameters':     result = await fnParameters(focas, params);     break;
            case 'macro':          result = await fnMacro(focas, params);          break;
            case 'all':
            default:               result = await fnAll(focas, runModes, cnc_series); break;
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

        node.on('input', async function(msg, send, done) {
            // Allow overriding function/subtype/params via msg
            const fn      = msg.function  || config.fn      || 'all';
            const subtype = msg.subtype   || config.subtype || 'feedrate';
            const params  = msg.params    || config.params  || '';

            node.status({ fill:'blue', shape:'dot', text: fn });
            try {
                msg.payload = await collect(server.host, server.port, server.cnc_series, fn, subtype, params);
                node.status({ fill:'green', shape:'dot', text:'ok' });
                send(msg);
                done();
            } catch (err) {
                node.status({ fill:'red', shape:'ring', text: err.message });
                node.error(err.message, msg);
                done(err);
            }
        });

        node.on('close', () => node.status({}));
    }
    RED.nodes.registerType('fanuc-focas', FanucFocasNode);
};