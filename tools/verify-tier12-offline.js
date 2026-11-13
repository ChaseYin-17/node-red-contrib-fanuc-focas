'use strict';
/**
 * tools/verify-tier12-offline.js — offline regression test for the tier-1/2 decoders.
 *
 * Every fixture below is a byte string captured from the 31i at 10.192.232.189:8193
 * on 2026-11-13 (cnc_type 31, mt_type " M", series G40A, version 60.0, max_axis 32,
 * axes "05"). The captures and the reasoning behind each layout are in docs/notes.md;
 * the tools that produced them are tools/probe-tier12-layout.js,
 * tools/probe-tier12-verify.js and tools/probe-pmc-byteorder.js.
 *
 * No controller is needed: `_reqSingle` is stubbed to answer from the fixtures, so the
 * real decoders in focas.js run against real bytes.
 *
 * Usage: node tools/verify-tier12-offline.js
 */
const path = require('path');
const { Focas, PMC_AREAS, PMC_BYTE, PMC_WORD, PMC_LONG } =
    require(path.join(__dirname, '..', 'focas.js'));

let failures = 0;
const check = (label, ok, detail) => {
    console.log(`${ok ? '  ✔' : '  ✗'} ${label}${detail !== undefined ? `   ${detail}` : ''}`);
    if (!ok) failures++;
};
const h = s => console.log(`\n${'─'.repeat(76)}\n${s}\n${'─'.repeat(76)}`);

const buf = hex => Buffer.from(hex.replace(/\s+/g, ''), 'hex');

// ── A stub controller: answers _reqSingle from a queue of fixtures ────────────
let script = [];
let sent = [];
Focas.prototype._reqSingle = async function (c1, c2, c3, ...args) {
    sent.push({ c1, c2, c3, args });
    if (!script.length) throw new Error(`unexpected request func=0x${c3.toString(16)}`);
    const next = script.shift();
    return typeof next === 'function' ? next() : next;
};
Focas.prototype.connect = async function () {
    this.sysinfo = { addinfo: 514, maxaxis: 32, cnctype: '31', mttype: ' M',
                     series: 'G40A', version: '60.0', axes: '05' };
};
Focas.prototype.disconnect = async function () {};

const reply = (hex, len) => ({
    len: len !== undefined ? len : hex.replace(/\s+/g, '').length / 2,
    data: buf(hex),
});

const mk = () => {
    const f = new Focas('x');
    f.sysinfo = { addinfo: 514, maxaxis: 32, cnctype: '31', mttype: ' M',
                  series: 'G40A', version: '60.0', axes: '05' };
    return f;
};

(async () => {
    // ── 1. cnc_rdcncid: 16 bytes, matches the C struct ───────────────────────
    h('1 — cnc_rdcncid: four unsigned longs, the one struct the wire agrees with');
    script = [reply('3c 7b 5d 01 56 81 8a 9a be 28 27 89 64 62 c4 fd')];
    sent = [];
    let r = await mk().readcncid();
    check('the request is func 0x0e8 with no arguments',
          sent[0].c3 === 0x0e8 && sent[0].args.every(a => a === 0),
          `func=0x${sent[0].c3.toString(16)} args=${JSON.stringify(sent[0].args)}`);
    check('hex is the four longs, big-endian, dash-separated',
          r.hex === '3c7b5d01-56818a9a-be282789-6462c4fd', r.hex);
    check('values are the same four as unsigned decimals',
          JSON.stringify(r.values) === '[1014717697,1451330202,3190302601,1684194557]',
          JSON.stringify(r.values));

    // A short reply must raise, not silently decode a truncated id.
    script = [reply('3c 7b 5d 01')];
    let threw = null;
    try { await mk().readcncid(); } catch (e) { threw = e.message; }
    check('a 4-byte reply raises instead of decoding a partial id',
          /expected 16/.test(threw || ''), threw);

    // ── 2. cnc_rdzofsinfo / cnc_rdzofs ───────────────────────────────────────
    h('2 — cnc_rdzofs: the second argument slot repeats the offset number');
    script = [reply('00 00 01 33')];
    r = await mk().readzofsinfo();
    check('zofsinfo reads one long (307), not sizeof(short)', r.use_no === 307, r.use_no);

    // The three argument shapes measured on the machine: (1,1,1) (1,1,2) (2,2,1).
    script = [reply('ff fb 6f f9 00 0a 00 03')];
    sent = [];
    r = await mk().readzofs(1, 1);
    check('readzofs(1, axis 1) sends (1, 1, 1) — number repeated, axis third',
          JSON.stringify(sent[0].args.slice(0, 3)) === '[1,1,1]',
          JSON.stringify(sent[0].args.slice(0, 3)));
    check('offset 1 axis 1 decodes to -299.015 mm',
          r.value === -299.015 && r.raw === -299015 && r.dec === 3 && r.unit === 10,
          JSON.stringify(r));

    script = [reply('ff fc f6 a8 00 0a 00 03')];
    sent = [];
    r = await mk().readzofs(1, 2);
    check('readzofs(1, axis 2) sends (1, 1, 2)',
          JSON.stringify(sent[0].args.slice(0, 3)) === '[1,1,2]',
          JSON.stringify(sent[0].args.slice(0, 3)));
    check('offset 1 axis 2 decodes to -199.000', r.value === -199, r.value);

    script = [reply('ff fc 12 0f 00 0a 00 03')];
    sent = [];
    r = await mk().readzofs(2, 1);
    check('readzofs(2, axis 1) sends (2, 2, 1) — the repeat follows the number',
          JSON.stringify(sent[0].args.slice(0, 3)) === '[2,2,1]',
          JSON.stringify(sent[0].args.slice(0, 3)));
    check('offset 2 axis 1 decodes to -257.521', r.value === -257.521, r.value);

    // ── 3. cnc_rdseqnum ──────────────────────────────────────────────────────
    h('3 — cnc_rdseqnum: one long, ODBSEQ dummy[2] dropped');
    script = [reply('00 00 00 14')];
    r = await mk().readseqnum();
    check('sequence number is 20', r === 20, r);

    // ── 4. cnc_rdcommand: 12-byte ODBCMD, flag bit 0x0800 marks presence ─────
    h('4 — cnc_rdcommand: 12-byte records, flag 0x0800 separates "none" from "zero"');
    // The measured modal block: D27 E0 F5000 H23 L0 M1=8 N20 O8002 S1400 T13,
    // then four empty M2..M5 slots whose flag is 0x0000.
    script = [reply(
        '44 00 08 00 00 00 00 1b 00 00 00 00' +   // D 27
        '45 00 00 00 00 00 00 00 00 00 00 00' +   // E 0, flag 0
        '46 00 08 10 00 00 13 88 00 00 00 00' +   // F 5000
        '48 00 08 00 00 00 00 17 00 00 00 00' +   // H 23
        '4c 00 08 40 00 00 00 00 00 00 00 00' +   // L 0
        '4d 01 08 00 00 00 00 08 00 00 00 00' +   // M1 8
        '4e 00 08 00 00 00 00 14 00 00 00 00' +   // N 20
        '4f 00 08 00 00 00 1f 42 00 00 00 00' +   // O 8002
        '53 00 08 00 00 00 05 78 00 00 00 00' +   // S 1400
        '54 00 08 00 00 00 00 0d 00 00 00 00' +   // T 13
        '4d 02 00 00 00 00 00 00 00 00 00 00' +   // M2 empty
        '4d 03 00 00 00 00 00 00 00 00 00 00' +   // M3 empty
        '4d 04 00 00 00 00 00 00 00 00 00 00' +   // M4 empty
        '4d 05 00 00 00 00 00 00 00 00 00 00')];  // M5 empty
    sent = [];
    const cmds = await mk().readcommand(-1, 1);
    check('readcommand(-1, 1) sends (type, block) = (-1, 1)',
          JSON.stringify(sent[0].args.slice(0, 2)) === '[-1,1]',
          JSON.stringify(sent[0].args.slice(0, 2)));
    check('14 records of 12 bytes', cmds.length === 14, cmds.length);
    check('F is 5000 and present', cmds[2].address === 'F' && cmds[2].value === 5000 && cmds[2].present,
          JSON.stringify(cmds[2]));
    check('S is 1400 and present', cmds[8].address === 'S' && cmds[8].value === 1400,
          JSON.stringify(cmds[8]));
    check('T is 13 and present', cmds[9].address === 'T' && cmds[9].value === 13,
          JSON.stringify(cmds[9]));
    check('M1 carries number 1 and value 8',
          cmds[5].address === 'M' && cmds[5].number === 1 && cmds[5].value === 8,
          JSON.stringify(cmds[5]));
    check('the empty M2..M5 slots are NOT present (flag 0x0000)',
          cmds.slice(10).every(c => c.present === false),
          JSON.stringify(cmds.slice(10).map(c => c.present)));
    check('E reads 0 but is not present — "no command" is not "command is zero"',
          cmds[1].value === 0 && cmds[1].present === false, JSON.stringify(cmds[1]));

    // A payload that is not a whole number of records must raise.
    script = [reply('44 00 08 00 00 00 00 1b 00 00 00')];
    threw = null;
    try { await mk().readcommand(-1, 1); } catch (e) { threw = e.message; }
    check('an 11-byte payload raises instead of mis-slicing records',
          /not a whole number/.test(threw || ''), threw);

    // ── 5. cnc_rdopmsg3 is deliberately NOT implemented ──────────────────────
    h('5 — cnc_rdopmsg3: no decoder, because the reply could not be identified');
    // On the 31i at 10.192.232.189 the 0xd0 reply is 268 bytes whose content is the
    // cnc_sysinfo block followed by zeros, identical across every `type` and every
    // call — the signature of a wrong opcode. The machine had no operator message
    // set, so the real layout could not be measured either way. The method must not
    // exist: a decoder built on that reply would report sysinfo text as a message.
    check('focas.js has no readopmsg3', typeof Focas.prototype.readopmsg3 !== 'function',
          typeof Focas.prototype.readopmsg3);

    // ── 6. cnc_rdproginfo: FOUR longs, not two shorts then two longs ─────────
    h('6 — cnc_rdproginfo: 16 bytes, four longs');
    // Measured on the 31i at 10.192.232.189: 129 | 880 | 179500 | 8309500.
    // Read as two shorts then two longs it gives registered=0, which is wrong — that
    // machine has 112 programs in its directory and 129 registered.
    script = [reply('00 00 00 81 00 00 03 70 00 02 bd 2c 00 7e ca fc')];
    sent = [];
    r = await mk().readproginfo();
    check('the request puts no arguments on the wire',
          sent[0].c3 === 0x07 && sent[0].args.every(a => a === 0),
          `func=0x${sent[0].c3.toString(16)} args=${JSON.stringify(sent[0].args)}`);
    check('registered is 129, read as a long at +0 (not 0 from a short at +4)',
          r.registered === 129, r.registered);
    check('available is 880, read as a long at +4', r.available === 880, r.available);
    check('used 179500 and unused 8309500',
          r.used_mem === 179500 && r.unused_mem === 8309500,
          `${r.used_mem}/${r.unused_mem}`);

    // ── 7. cnc_rdpm_item: 80-byte stride, name padded 62→64 ──────────────────
    h('7 — cnc_rdpm_item: the stride is 80, not the C struct\'s 78');
    // One record: name[64] then type/total/remain/stat. The measured record had an
    // empty name and type 65536, which is what an unconfigured item looks like.
    const item = Buffer.concat([
        Buffer.alloc(64),                       // empty name
        buf('00 01 00 00'),                     // type 65536
        buf('00 00 00 00'),                     // total 0
        buf('00 00 00 00'),                     // remain 0
        buf('00 00 00 00'),                     // stat 0
    ]);
    script = [{ len: item.length, data: item }];
    sent = [];
    r = await mk().readpm_item(1, 1);
    check('readpm_item(1, 1) sends (start, num) = (1, 1)',
          JSON.stringify(sent[0].args.slice(0, 2)) === '[1,1]',
          JSON.stringify(sent[0].args.slice(0, 2)));
    check('one 80-byte record decodes', r.length === 1, r.length);
    check('an empty name is null, not an empty string', r[0].name === null, JSON.stringify(r[0].name));
    check('type 65536 is read from +64, not +62', r[0].type === 65536, r[0].type);

    // 800 bytes must be exactly 10 records at stride 80 — and NOT 10.256 at 78.
    const ten = Buffer.concat(Array.from({ length: 10 }, () => item));
    script = [{ len: ten.length, data: ten }];
    r = await mk().readpm_item(1, 10);
    check('800 bytes is 10 records at stride 80', r.length === 10, r.length);

    // A payload that is a whole number of 78-byte records but not of 80 must raise.
    script = [{ len: 78, data: Buffer.alloc(78) }];
    threw = null;
    try { await mk().readpm_item(1, 1); } catch (e) { threw = e.message; }
    check('a 78-byte payload raises — the stride is 80',
          /not a whole number/.test(threw || ''), threw);

    // ── 8. cnc_rdblkcount ────────────────────────────────────────────────────
    h('8 — cnc_rdblkcount: one long');
    script = [reply('00 00 02 85')];
    r = await mk().readblkcount();
    check('block counter is 645', r === 645, r);

    // ── 9. cnc_gettimer: date and time are two calls, each filling its own half ──
    h('9 — cnc_gettimer: type=0 fills the date, type=1 fills the time');
    // Measured on the 31i at 10.192.232.189: the reply is always 12 bytes, but the
    // half that was NOT asked for keeps whatever was in the buffer —
    //
    //     type=0 → 2026 11 13 8269 18228 12353   (tail stale)
    //     type=1 → 2026 11 13 17 18 26           (head is the last date read)
    //
    // so gettimer() must read both and take each half from the call that asked for it.
    script = [reply('07 ea 00 0b 00 0d 20 4d 47 34 30 41'),   // type=0: date, stale tail
              reply('07 ea 00 0b 00 0d 00 11 00 12 00 1a')];  // type=1: time 17:18:26
    sent = [];
    r = await mk().gettimer();
    check('gettimer asks type=0 then type=1',
          sent.length === 2 && sent[0].args[0] === 0 && sent[1].args[0] === 1,
          sent.map(s => `type=${s.args[0]}`).join(' '));
    check('date comes from the type=0 call: 2026-11-13',
          r.year === 2026 && r.month === 11 && r.day === 13, JSON.stringify(r));
    check('time comes from the type=1 call: 17:18:26',
          r.hour === 17 && r.minute === 18 && r.second === 26,
          `${r.hour}:${r.minute}:${r.second}`);
    check('the stale tail of the type=0 reply is NOT used',
          r.hour !== 8269 && r.minute !== 18228 && r.second !== 12353,
          `${r.hour}:${r.minute}:${r.second}`);

    // ── 10. cnc_statinfo2: sub1 starts at `aut`, sub2 supplies hdck/tmmode ───
    h('10 — cnc_statinfo2: sub1 starts at `aut`, sub2 supplies hdck/tmmode');
    // Measured on the 31i at 10.192.232.189, back to back with cnc_statinfo:
    //
    //     cnc_statinfo (0x19) : 1 3 1 0 0 0 0            (aut run motion mstb emergency alarm edit)
    //     statinfo2 sub1 (e2) : 1 3 1 0 0 0 0 0 0 0 0    (11 shorts)
    //     statinfo2 sub2 (e1) : 0 3                      (2 shorts)
    //
    // sub1's first seven shorts are byte-identical to cnc_statinfo's seven, so sub1
    // starts at `aut`. sub2 is hdck/tmmode, which ODBST2 declares FIRST. Reading sub1
    // as if it began with hdck/tmmode shifts every field by two.
    script = [reply('00 01 00 03 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'),
              reply('00 00 00 03')];
    sent = [];
    r = await mk().statinfo2();
    check('statinfo2 asks 0xe2 then 0xe1, and never 0x98',
          sent.length === 2 && sent[0].c3 === 0x0e2 && sent[1].c3 === 0x0e1,
          sent.map(s => '0x' + s.c3.toString(16)).join(' '));
    check('aut/run/motion come from sub1[0..2]: 1, 3, 1',
          r.aut === 1 && r.run === 3 && r.motion === 1,
          `${r.aut}/${r.run}/${r.motion}`);
    check('hdck/tmmode come from sub2, not from sub1[0..1]',
          r.hdck === 0 && r.tmmode === 3, `hdck=${r.hdck} tmmode=${r.tmmode}`);
    check('the extended fields land after edit: warning 0, o3dchk 0, ext_opt 0, restart 0',
          r.warning === 0 && r.o3dchk === 0 && r.ext_opt === 0 && r.restart === 0,
          JSON.stringify(r));

    // ── 11. pmc_rdpmcrng: 2/1 pair, byte addresses, little-endian words ──────
    h('11 — pmc_rdpmcrng: c1/c2 = 2/1, args (s, e, adr, dtype, 0)');
    // The measured D100..D107 byte read.
    script = [reply('22 05 03 14 00 22 05 03')];
    sent = [];
    r = await mk().readpmc('D', 100, 107, PMC_BYTE);
    check('the command pair is 2/1, not 1/1',
          sent[0].c1 === 2 && sent[0].c2 === 1, `${sent[0].c1}/${sent[0].c2}`);
    check('the wire arguments are (s, e, adr_type, data_type, 0)',
          JSON.stringify(sent[0].args) === '[100,107,9,0,0]',
          JSON.stringify(sent[0].args));
    check('D is adr_type 9', PMC_AREAS.D === 9, PMC_AREAS.D);
    check('8 bytes decode to 8 values', r.length === 8, r.length);
    check('the byte values are the measured ones',
          JSON.stringify(r) === '[34,5,3,20,0,34,5,3]', JSON.stringify(r));

    // The word read of the same range: the byte path is little-endian within each
    // 2-byte word, so 22 05 is 0x0522 and 03 14 is 0x1403.
    script = [reply('22 05 03 14 00 22 05 03')];
    r = await mk().readpmc('D', 100, 107, PMC_WORD);
    check('the same bytes as words are little-endian: 0x0522, 0x1403, 0x2200, 0x0305',
          JSON.stringify(r) === '[1314,5123,8704,773]', JSON.stringify(r));

    // And as longs: 0x14030522, 0x03052200.
    script = [reply('22 05 03 14 00 22 05 03')];
    r = await mk().readpmc('D', 100, 107, PMC_LONG);
    check('the same bytes as longs: 0x14030522, 0x03052200',
          JSON.stringify(r) === '[335742242,50668032]', JSON.stringify(r));

    // A range that is not a whole number of the requested width must raise before
    // the request goes out.
    sent = [];
    threw = null;
    try { await mk().readpmc('D', 100, 102, PMC_WORD); } catch (e) { threw = e.message; }
    check('a 3-byte range as words raises without sending a request',
          /not a whole number/.test(threw || '') && sent.length === 0, threw);

    // A reply whose length does not match the range must raise.
    script = [reply('22 05')];
    threw = null;
    try { await mk().readpmc('D', 100, 107, PMC_BYTE); } catch (e) { threw = e.message; }
    check('a short PMC reply raises instead of returning a partial block',
          /8 addresses/.test(threw || ''), threw);

    // An unknown area must raise, not send adr_type undefined.
    sent = [];
    threw = null;
    try { await mk().readpmc('Z', 0, 0, PMC_BYTE); } catch (e) { threw = e.message; }
    check('an unknown PMC area raises without sending a request',
          /unknown area/.test(threw || '') && sent.length === 0, threw);

    // ── 12. The node layer ───────────────────────────────────────────────────
    h('12 — the node exposes the new functions and degrades per field');
    const configNode = { host: '127.0.0.1', port: 8193, cnc_series: '16', label: () => 'stub' };
    let pollNode = null;
    // node.warn() calls: the payload has no error channel, so a field that could not
    // be read is reported there instead.
    const warnings = [];
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

    // machine_id through the node layer.
    script = [reply('3c 7b 5d 01 56 81 8a 9a be 28 27 89 64 62 c4 fd')];
    r = await poll('machine_id');
    check('the node exposes machine_id', r.cncid === '3c7b5d01-56818a9a-be282789-6462c4fd', r.cncid);

    // calendar through the node layer, including the formatted strings.
    script = [reply('07 ea 00 0b 00 0d 20 4d 47 34 30 41'),   // type=0: date, stale tail
              reply('07 ea 00 0b 00 0d 00 10 00 38 00 23')];  // type=1: time 16:56:35
    r = await poll('calendar');
    check('calendar formats date and time', r.date === '2026-11-13' && r.time === '16:56:35',
          `${r.date} ${r.time}`);
    check('calendar does not claim a timezone', r.iso_like === '2026-11-13T16:56:35', r.iso_like);

    // program_memory: the percentage needs a denominator.
    script = [reply('00 00 00 81 00 00 03 70 00 02 bd 2c 00 7e ca fc')];
    r = await poll('program_memory');
    check('program_memory reports used_percent from used/(used+unused)',
          r.used_percent === 2.1, r.used_percent);

    // A zero total must be null, not 0 %.
    script = [reply('00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00')];
    r = await poll('program_memory');
    check('a zero total gives null percent, not 0', r.used_percent === null, r.used_percent);

    // maintenance: remain_percent, and null when total is 0.
    script = [{ len: item.length, data: item }];
    r = await poll('maintenance');
    check('maintenance returns one item with a null percent when total is 0',
          r.items.length === 1 && r.items[0].remain_percent === null,
          JSON.stringify(r.items[0]));

    // command: only present records reach the payload.
    script = [reply(
        '46 00 08 10 00 00 13 88 00 00 00 00' +   // F 5000 present
        '45 00 00 00 00 00 00 00 00 00 00 00' +   // E 0 absent
        '4d 01 08 00 00 00 00 08 00 00 00 00')];  // M1 8 present
    r = await poll('command', 'modal');
    check('command keeps only present records', Object.keys(r.commands).length === 2,
          JSON.stringify(Object.keys(r.commands)));
    check('command keys M codes by number', r.commands.M1 && r.commands.M1.value === 8,
          JSON.stringify(r.commands.M1));
    check('command omits the absent E record', r.commands.E === undefined,
          JSON.stringify(Object.keys(r.commands)));

    // pmc_read: bit specs mask, word/long specs assemble.
    // Each spec reads its own byte range at BYTE width, so the fixtures are one
    // byte for R0.0, one for R0.2, two for D100:word and four for D100:long.
    script = [reply('14'), reply('14'), reply('22 05'), reply('22 05 03 14')];
    r = await poll('pmc_read', '', 'R0.0,R0.2,D100:word,D100:long');
    check('pmc_read returns one entry per spec', r.values.length === 4, r.values.length);
    check('R0.0 masks bit 0 of 0x14 → 0', r.values[0].value === 0, JSON.stringify(r.values[0]));
    check('R0.2 masks bit 2 of 0x14 → 1', r.values[1].value === 1, JSON.stringify(r.values[1]));
    check('D100:word assembles little-endian 0x0522', r.values[2].value === 0x0522,
          r.values[2].hex);
    check('D100:long assembles little-endian 0x14030522', r.values[3].value === 0x14030522,
          r.values[3].hex);

    // A bad spec must raise a message that names it.
    threw = null;
    try { await poll('pmc_read', '', 'R0.9'); } catch (e) { threw = e.message; }
    check('a bit number above 7 raises and names the spec',
          /R0\.9/.test(threw || ''), threw);

    threw = null;
    try { await poll('pmc_read', '', ''); } catch (e) { threw = e.message; }
    check('an empty PMC address list raises', /params is empty/.test(threw || ''), threw);

    // ── 13. All Data: a series without the function degrades only that field ──
    h('13 — All Data: an unsupported function nulls its field, not the snapshot');
    // A queue of fixtures would have to reproduce All Data's exact call order, which
    // makes the test break every time a field is added. Answer by FUNCTION CODE
    // instead: the shape of the reply is a property of the function, not of the
    // order it happens to be called in.
    const byFunc = {
        0x19:  () => reply('00 01 00 03 00 01 00 00 00 00 00 00 00 00'),   // statinfo
        0x8d:  () => reply('00 00 00 00 00 00 00 00'.repeat(33)),          // rdparam3
        0x1c:  () => reply('00 00 1f 42 00 00 1f 42'),                     // rdprgnum
        0x06:  () => reply(''),                                            // rdprogdir
        0x23:  () => reply(''),                                            // rdalmmsg
        0x1a:  () => reply('00 00 00 00'),                                 // alarm
        0x8010:() => reply('00 00 00 00 00 00 00 00'),                     // pmc_rdalmmsg
        0x24:  () => reply('00 00 00 c8 00 0a 00 00'),                     // actf
        0x25:  () => reply('00 00 09 c4 00 0a 00 00'),                     // acts
        0xa4:  () => reply('00 05'),                                       // axis count
        0x89:  () => reply('58 00 6e 10 59 00 6e 10'),                     // axis names
        0x8a:  () => reply('53 00 6e 10'),                                 // spindle names
        0x26:  () => reply('00 00 00 00 00 00 00 00'),                     // dynamic2
        0x56:  () => reply('00 00 00 00 00 00 00 00'),                     // svmeter
        0x40:  () => reply('00 00 00 00 00 00 00 00'),                     // spmeter
        0x48:  () => ({ len: 0, error: 6 }),                               // tool life: no option
        0x4a:  () => ({ len: 0, error: 6 }),
        0x1c1: () => ({ len: 0, error: 6 }),
        0x1c4: () => ({ len: 0, error: 6 }),
        0x0a:  () => ({ len: 0, error: 6 }),                               // tool offsets: no option
        0x08:  () => ({ len: 0, error: 6 }),
        // ── the tier-1/2 reads ────────────────────────────────────────────────
        0x0e8: () => ({ len: 0, error: 1 }),                               // machine id: EW_FUNC
        0x1d:  () => reply('00 00 00 14'),                                 // seqnum
        0x97:  () => reply('46 00 08 10 00 00 13 88 00 00 00 00'),         // command
        0x07:  () => reply('00 00 00 81 00 00 03 70 00 02 bd 2c 00 7e ca fc'), // proginfo
        0xbe:  () => ({ len: 0, error: 1 }),                               // pm_item: EW_FUNC
        0x35:  () => reply('00 00 02 85'),                                 // blkcount
        // gettimer: type=0 fills the date, type=1 the time — answer per type, because
        // the half that was not asked for is stale on the wire.
        0x45:  (args) => args[0] === 0
                   ? reply('07 ea 00 0b 00 0d 20 4d 47 34 30 41')
                   : reply('07 ea 00 0b 00 0d 00 10 00 38 00 23'),
        // statinfo2: sub1 starts at `aut` (11 shorts), sub2 is hdck/tmmode.
        0x0e2: () => reply('00 01 00 03 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'),
        0x0e1: () => reply('00 00 00 03'),
    };
    Focas.prototype._reqSingle = async function (c1, c2, c3, ...args) {
        sent.push({ c1, c2, c3, args });
        const f = byFunc[c3];
        if (!f) throw new Error(`All Data made an unexpected request func=0x${c3.toString(16)}`);
        return f(args);
    };

    r = await poll('all');
    check('machine_id is null when the series does not have it', r.machine_id === null,
          JSON.stringify(r.machine_id));
    check('the payload carries no error channel', !('errors' in r), Object.keys(r).join(','));
    check('the reason goes to the node log, not the payload',
          warnings.some(w => /machine_id/.test(w) && /EW_FUNC/.test(w)),
          JSON.stringify(warnings));
    check('the rest of the snapshot still populated: sequence_number 20',
          r.sequence_number && r.sequence_number.sequence_number === 20,
          JSON.stringify(r.sequence_number));
    check('the rest of the snapshot still populated: block_count 645',
          r.block_count && r.block_count.block_count === 645, JSON.stringify(r.block_count));
    check('the rest of the snapshot still populated: calendar',
          r.calendar && r.calendar.date === '2026-11-13', JSON.stringify(r.calendar));
    check('the rest of the snapshot still populated: machine_state_ext',
          r.machine_state_ext && r.machine_state_ext.mode === 'MEMory' &&
          r.machine_state_ext.run_state === 'STaRt' &&
          r.machine_state_ext.motion === 'Moving',
          JSON.stringify(r.machine_state_ext));
    // The fields cnc_statinfo also reports must be LABELLED the same way by both
    // functions, so a flow can read either one. The values are not compared: the two
    // are separate samples and the machine can move between them.
    check('machine_state_ext labels mode/run_state/motion like machine_state does',
          typeof r.machine_state_ext.mode === 'string' &&
          typeof r.machine_state_ext.run_state === 'string' &&
          typeof r.machine_state_ext.motion === 'string' &&
          r.machine_state_ext.mode === r.machine_state.mode,
          `ext ${r.machine_state_ext.mode}/${r.machine_state_ext.run_state}/${r.machine_state_ext.motion}` +
          ` vs base ${r.machine_state.mode}/${r.machine_state.run_state}/${r.machine_state.motion}`);
    check('machine_state_ext does not leak raw enums for the shared fields',
          !Number.isInteger(r.machine_state_ext.mode) &&
          !Number.isInteger(r.machine_state_ext.run_state) &&
          !Number.isInteger(r.machine_state_ext.motion),
          JSON.stringify([r.machine_state_ext.mode, r.machine_state_ext.run_state,
                          r.machine_state_ext.motion]));
    check('a null field is never confused with an empty one',
          r.machine_id === null && r.maintenance === null &&
          r.sequence_number !== null, 'machine_id null, maintenance null, seqnum present');
    check('All Data carries no operator_message field (that read is not implemented)',
          !('operator_message' in r), Object.keys(r).join(','));

    h(failures === 0 ? 'PASS — the tier-1/2 decoders hold against the captured bytes'
                     : `FAIL — ${failures} assertion(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('\nFATAL:', e && e.stack ? e.stack : e); process.exit(1); });
