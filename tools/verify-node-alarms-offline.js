'use strict';
/**
 * tools/verify-node-alarms-offline.js — offline regression test for the alarm fields.
 *
 * The three alarm reads cannot all be checked against a controller: both machines
 * captured while writing this (see docs/notes.md) had nothing pending, so `cnc_alarm2`
 * answered 0 and `pmc_rdalmmsg` answered `read_num=0` — the PMC record width is still
 * unmeasured. This stubs the Focas prototype and drives the real node code instead, so
 * the payload shape, the per-series bit labels, the PMC paging loop and the failure
 * paths are covered with no hardware at all.
 *
 * Usage: node tools/verify-node-alarms-offline.js
 */
const path = require('path');

const { Focas } = require(path.join(__dirname, '..', 'focas.js'));

const h = (s) => console.log(`\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}`);
let failures = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? '  ✔' : '  ✗'} ${label}${detail ? `   ${detail}` : ''}`);
    if (!ok) failures++;
};

// ── A stand-in controller ─────────────────────────────────────────────────────
const state = { cncType: '31' };

Focas.prototype.connect = async function () {
    this.sysinfo = { cnctype: state.cncType, mttype: ' M', series: 'G11Z', version: '13.0', maxaxis: 32 };
};
Focas.prototype.disconnect = async function () {};

// Every read fnAll makes. The alarm three are replaced per case below; the rest exist so
// that a clean run leaves `errors` empty and a real failure stands out.
const stubs = {
    statinfo:            async () => ({ aut: 1, run: 3, motion: 0, mstb: 0, emegency: 0, alarm: 0, edit: 0 }),
    readparam3:          async () => ({}),
    readprognum:         async () => ({ run: 1, main: 1 }),
    listprog:            async () => ({}),
    readactfeed:         async () => 0,
    readactspindlespeed: async () => 0,
    readaxes:            async () => ({}),
    readsvmeter:         async () => [],
    readservocurrent:    async () => [],
    readaxisnames:       async () => [],
    readspmeter:         async () => [],
    readspindlenames:    async () => [],
    readtlinfo:          async () => ({ max_group: 0, max_tool: 0, max_minute: 0, max_cycle: 0 }),
    readngrp:            async () => 0,
    readusegrpid:        async () => ({ next: 0, use: 0, slct: 0 }),
    readgrpinfo4:        async () => [],

    readalarmcode:       async () => [],
    readalarmstatus2:    async () => ({ status: 0x82, bits: [1, 7] }),
    readpmcalarm:        async () => ({ alarms: [{ message: 'ER30 Battery Alarm' }],
                                        read_num: 1, exist: 0, more: false }),
};
const applyStubs = () => Object.assign(Focas.prototype, stubs);
applyStubs();

// ── The node, hosted in a minimal Node-RED ────────────────────────────────────
const configNode = { host: '127.0.0.1', port: 8193, cnc_series: '16', label: () => 'stub' };
let pollNode = null;
const RED = {
    nodes: {
        createNode(node) {
            node.on     = (ev, cb) => { node._handlers = Object.assign(node._handlers || {}, { [ev]: cb }); return node; };
            node.status = () => {};
            node.error  = (m) => { node._error = m; };
            return node;
        },
        registerType(type, ctor) {
            if (type === 'fanuc-focas') pollNode = new ctor({ server: 'cfg', fn: 'all', subtype: '', params: '' });
        },
        getNode: () => configNode,
    },
};
require(path.join(__dirname, '..', 'fanuc-focas.js'))(RED);
const input = pollNode._handlers.input;

const poll = (fn) => new Promise((resolve, reject) => {
    input({ function: fn }, (m) => resolve(m.payload), (err) => (err ? reject(err) : null));
});

(async () => {
    h('CASE 1 — All Data carries three separate alarm fields');
    let p = await poll('all');
    check('active_alarms is still the array it always was', Array.isArray(p.active_alarms));
    check('alarm_status is its own key', p.alarm_status && p.alarm_status.status === 0x82,
          JSON.stringify(p.alarm_status));
    check('pmc_alarms is its own key',
          JSON.stringify(p.pmc_alarms) === JSON.stringify([{ message: 'ER30 Battery Alarm' }]),
          JSON.stringify(p.pmc_alarms));
    check('a clean run leaves errors empty', JSON.stringify(p.errors) === '{}', JSON.stringify(p.errors));

    h('CASE 2 — the bit labels come from the controller, not the configured series');
    // cnc_type 31 -> the 30i table: bit 1 is PW and bit 7 is SR. The 15i table would
    // call them PS and PC, so a wrong table cannot pass silently.
    check('30i: bit 1 -> Power off parameter set (PW)',
          p.alarm_status.bits[0].label === 'Power off parameter set (PW)', JSON.stringify(p.alarm_status.bits));
    check('raw bit number is kept alongside the label', p.alarm_status.bits[0].bit === 1);
    state.cncType = '15';
    stubs.readalarmstatus2 = async () => ({ status: 0x100, bits: [8] });
    applyStubs();
    p = await poll('alarm_status');
    check('15i: bit 8 -> External alarm message (1) (EX)',
          p.bits[0].label === 'External alarm message (1) (EX)', JSON.stringify(p.bits));
    state.cncType = '31';
    stubs.readalarmstatus2 = async () => ({ status: 0x82, bits: [1, 7] });
    applyStubs();

    h('CASE 3 — the standalone Functions keep the array/object contract');
    p = await poll('alarm_status');
    check('alarm_status is an object with a timestamp',
          p && !Array.isArray(p) && p.status === 0x82 && typeof p.timestamp === 'string',
          JSON.stringify(p));
    p = await poll('pmc_alarms');
    check('pmc_alarms stays an array (not spread into {"0":…})', Array.isArray(p));
    check('...with the timestamp as a property', typeof p.timestamp === 'string');

    h('CASE 4 — PMC paging');
    const asked = [];
    stubs.readpmcalarm = async (sNumber) => {
        asked.push(sNumber);
        return sNumber === 1
            ? { alarms: [{ message: 'ER01' }, { message: 'ER02' }], read_num: 2, exist: 1, more: true }
            : { alarms: [{ message: 'ER03' }], read_num: 1, exist: 0, more: false };
    };
    applyStubs();
    p = await poll('pmc_alarms');
    check('two pages merged in order', JSON.stringify(p.map(a => a.message)) === '["ER01","ER02","ER03"]',
          JSON.stringify(p.map(a => a.message)));
    check('the second page resumes after what was read', JSON.stringify(asked) === '[1,3]', JSON.stringify(asked));

    let calls = 0;
    stubs.readpmcalarm = async () => { calls++; return { alarms: [], read_num: 0, exist: 1, more: true }; };
    applyStubs();
    p = await poll('pmc_alarms');
    check('"more" with nothing read cannot spin the loop', calls === 1 && p.length === 0, `calls=${calls}`);

    calls = 0;
    stubs.readpmcalarm = async (sNumber) => { calls++; return {
        alarms: [{ message: `ER${sNumber}` }], read_num: 1, exist: 1, more: true }; };
    applyStubs();
    p = await poll('pmc_alarms');
    check('a controller that always says "more" is capped, not followed forever',
          calls === 5 && p.length === 5, `calls=${calls}`);

    h('CASE 5 — one alarm read failing leaves the others standing');
    stubs.readalarmstatus2 = async () => { throw new Error('cnc_alarm2: CNC returned EW_NOOPT (6)'); };
    stubs.readpmcalarm = async () => ({ alarms: [{ message: 'ER01' }], read_num: 1, exist: 0, more: false });
    applyStubs();
    p = await poll('all');
    check('alarm_status is null, not {}', p.alarm_status === null, JSON.stringify(p.alarm_status));
    check('the reason is recorded against its own key',
          p.errors.alarm_status === 'cnc_alarm2: CNC returned EW_NOOPT (6)', JSON.stringify(p.errors));
    check('active_alarms is untouched by it', Array.isArray(p.active_alarms));
    check('pmc_alarms still came through',
          JSON.stringify(p.pmc_alarms) === JSON.stringify([{ message: 'ER01' }]),
          JSON.stringify(p.pmc_alarms));

    h('CASE 6 — the standalone poll of a broken read raises');
    try {
        await poll('alarm_status');
        check('alarm_status raises', false, 'resolved instead');
    } catch (e) {
        check('alarm_status raises', /EW_NOOPT/.test(e.message), e.message);
    }

    h(failures === 0 ? 'PASS — the alarm fields, labels, paging and failure paths hold'
                     : `FAIL — ${failures} assertion(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
