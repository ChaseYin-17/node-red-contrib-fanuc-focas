'use strict';
/**
 * focas.js — Pure Node.js FOCAS2 TCP client
 * Port of diohpix/pyfanuc with all known bug-fixes applied.
 *
 * Protocol constants match pyfanuc.py exactly.
 * Wire behaviour is verified against the FANUC FOCAS2 SDK shipped in lib/FOCAS2 Library
 * (see Document/SpecE/Misc/*.xml for per-function specs, ERRCODE.HTM for status codes).
 * All methods return Promises.
 */
const net = require('net');

// ── Frame type constants ──────────────────────────────────────────────────────
const FTYPE_OPN_REQU = 0x0101;
const FTYPE_OPN_RESP = 0x0102;
// Sent in place of the open response when the controller will not take the session —
// observed when every slot is already in use. The payload is not documented in the
// SDK, so the raw bytes are carried into the error instead of being interpreted.
const FTYPE_OPN_REFUTED = 0x0103;
const FTYPE_VAR_REQU = 0x2101;
const FTYPE_VAR_RESP = 0x2102;
const FTYPE_CLS_REQU = 0x0201;
const FTYPE_CLS_RESP = 0x0202;

const FRAMEHEAD = Buffer.from([0xa0, 0xa0, 0xa0, 0xa0]);
const FRAME_DST = Buffer.from([0x00, 0x02]);
const ALLAXIS   = -1;

// ── Load-meter function codes ─────────────────────────────────────────────────
// Taken from the official FOCAS2 library's own traffic (captured with a TCP proxy:
// see tools/probe-diag.js for the raw opcode space). These are NOT diagnostics —
// cnc_diagnoss (0x30) is a different, separately-licensed function that answers
// EW_FUNC on controllers which do not implement it.
const FN_SVMETER = 0x56;   // cnc_rdsvmeter — servo load meter
const FN_SPMETER = 0x40;   // cnc_rdspmeter — spindle load meter / motor speed
const FN_AXISNUM = 0xa4;   // axis or spindle count, selected by `type`
const FN_SVNAME  = 0x89;   // cnc_rdaxisname  — servo axis names
const FN_SPNAME  = 0x8a;   // cnc_rdspdlname  — spindle names

const AXNUM_SPINDLE  = 1;  // FN_AXISNUM type: spindle count
const AXNUM_SERVO    = 2;  // FN_AXISNUM type: servo axis count
const SPMETER_LOAD   = 0;  // FN_SPMETER type: spindle load meter (data_num entry)
const SPMETER_SPEED  = 1;  // FN_SPMETER type: spindle motor speed

// FN_SVMETER carries a reading selector in its first argument. 1 is the documented
// cnc_rdsvmeter (load meter, %); 3 is the load current in Ampere that the vendor
// library reaches through cnc_rdaxisdata(cls=2, type=2) — that function has no
// opcode of its own, it decomposes into this one. See docs/notes.md. The two
// differ only in the scale the controller reports alongside the value.
const SVMETER_LOAD    = 1; // FN_SVMETER reading: load meter / load current (%)
const SVMETER_CURRENT = 3; // FN_SVMETER reading: load current (Ampere)

// Every load-meter reading is one 8-byte record; cnc_rdspmeter packs two records
// per spindle (load meter, then motor speed). The decimal position sits at +6 —
// the official library decodes it there (it reports dec=0 for a load meter, where
// the field at +4 would have given 10).
const LOADELM_STRIDE = 8;
const SPMETER_STRIDE = 16;

// ── Low-level framing ─────────────────────────────────────────────────────────
function encap(ftype, payload, fvers = 1) {
    if (ftype === FTYPE_VAR_REQU) {
        if (Array.isArray(payload)) {
            const parts = payload.map(p => {
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeUInt16BE(p.length + 2);
                return Buffer.concat([lenBuf, p]);
            });
            const countBuf = Buffer.alloc(2);
            countBuf.writeUInt16BE(parts.length);
            payload = Buffer.concat([countBuf, ...parts]);
        } else {
            const hdr = Buffer.alloc(4);
            hdr.writeUInt16BE(1, 0);
            hdr.writeUInt16BE(payload.length + 2, 2);
            payload = Buffer.concat([hdr, payload]);
        }
    }
    const hdr = Buffer.alloc(6);
    hdr.writeUInt16BE(fvers,         0);
    hdr.writeUInt16BE(ftype,         2);
    hdr.writeUInt16BE(payload.length, 4);
    return Buffer.concat([FRAMEHEAD, hdr, payload]);
}

function decap(data) {
    if (data.length < 10) return { len: -1 };
    if (data[0] !== 0xa0 || data[1] !== 0xa0 || data[2] !== 0xa0 || data[3] !== 0xa0)
        return { len: -1 };
    const fvers = data.readUInt16BE(4);
    const ftype = data.readUInt16BE(6);
    const len1  = data.readUInt16BE(8);
    if (len1 + 10 !== data.length) return { len: -1 };
    if (len1 === 0) return { len: 0, ftype, fvers, data: Buffer.from([0x30]) };

    const body = data.slice(10);
    if (ftype === FTYPE_VAR_RESP) {
        const qu = body.readUInt16BE(0);
        let n = 2, re = [];
        for (let t = 0; t < qu; t++) {
            const le = body.readUInt16BE(n);
            re.push(body.slice(n + 2, n + le));
            n += le;
        }
        return { len: len1, ftype, fvers, data: re };
    }
    return { len: len1, ftype, fvers, data: body };
}

// ── Build sub-command buffer (for _req_rdmulti) ───────────────────────────────
function reqSub(c1, c2, c3, v1=0, v2=0, v3=0, v4=0, v5=0) {
    const b = Buffer.alloc(6 + 5*4);
    b.writeUInt16BE(c1, 0);
    b.writeUInt16BE(c2, 2);
    b.writeUInt16BE(c3, 4);
    b.writeInt32BE(v1,  6);
    b.writeInt32BE(v2, 10);
    b.writeInt32BE(v3, 14);
    b.writeInt32BE(v4, 18);
    b.writeInt32BE(v5, 22);
    return b;
}

// ── Decode 8-byte value (feedrate/spindle) ────────────────────────────────────
function decode8(val) {
    const flag = val[5];
    if (flag === 2 || flag === 10) {
        if (val[6] === 0xff && val[7] === 0xff) return null;
        const raw = val.readInt32BE(0);
        return raw / Math.pow(flag, val[7]);
    }
    return null;
}

// ── Parse parameter response body (cnc_rdparam3) ─────────────────────────────
// The `diag` variant of this decoder is gone: it was only ever reached by the
// cnc_diagnoss load path and was never run against a real response. Diagnostics
// have a different record layout, so a decoder for them has to be written against
// captured traffic rather than borrowed from the parameter format.
function parseParamBody(data, maxaxis) {
    const stride = maxaxis * 4 + 8;
    const r = {};
    for (let pos = 0; pos + 8 <= data.length; pos += stride) {
        const varname  = data.readUInt32BE(pos);
        const axiscount = data.readInt16BE(pos + 4);
        const valtype   = data.readUInt16BE(pos + 6);
        const values    = { type: valtype, axis: axiscount, data: [] };

        for (let n = pos + 8; n < pos + stride; n += 4) {
            const chunk = data.slice(n, n + 4);
            let value;
            if      (valtype === 0) value = chunk[3];
            else if (valtype === 1) { const b = chunk[3]; value = [7,6,5,4,3,2,1,0].map(i => (b>>i)&1); }
            else if (valtype === 2) value = chunk.readInt16BE(2);   // fix: last 2 bytes
            else if (valtype === 3) value = chunk.readInt32BE(0);
            if (axiscount !== -1) { values.data.push(value); break; }
            else                    values.data.push(value);
        }
        r[varname] = values;
    }
    return r;
}

// ── FOCAS status codes ────────────────────────────────────────────────────────
// FOCAS2 spec: lib/FOCAS2 Library/Document/SpecE/ERRCODE.HTM
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
function focasErrName(code) {
    return FOCAS_ERRORS[String(code)] || 'EW_UNKNOWN';
}

// The wire protocol gives no error text on a bad handshake, so the only way to tell
// "the controller answered with something else" from "our stream is out of sync" is
// to keep the first bytes of the offending reply in the message.
function hexDump(buf, n = 16) {
    const s = buf.slice(0, Math.min(buf.length, n)).toString('hex');
    return s.length ? s.match(/../g).join(' ') : '(empty)';
}

// Turn a rejected `_reqSingle` result into the message it deserves. Both failure
// shapes have to name the function and the CNC's reason: an EW_* status is a real
// answer from the controller and must never be mistaken for "no data".
function reqErr(fnName, st, detail) {
    return st.error !== undefined
        ? `${fnName}: CNC returned ${focasErrName(st.error)} (${st.error})${detail ? ` ${detail}` : ''}`
        : `${fnName}: malformed or empty response frame`;
}

// ── Main client class ─────────────────────────────────────────────────────────
class Focas {
    constructor(ip, port = 8193, timeout = 5000) {
        this.ip      = ip;
        this.port    = port;
        this.timeout = timeout;
        this.socket  = null;
        this.sysinfo = null;
    }

    // ── Socket helpers ────────────────────────────────────────────────────────
    _send(buf) {
        return new Promise((resolve, reject) => {
            this.socket.write(buf, err => err ? reject(err) : resolve());
        });
    }

    _recv() {
        return new Promise((resolve, reject) => {
            const socket  = this.socket;
            let buf       = Buffer.alloc(0);
            let settled   = false;
            let timer     = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                socket.removeListener('data',  onData);
                socket.removeListener('error', onErr);
                socket.removeListener('close', onClose);
                socket.removeListener('end',   onEnd);
            };
            const fail = err => { if (settled) return; settled = true; cleanup(); reject(err); };
            const done = raw => { if (settled) return; settled = true; cleanup(); resolve(raw); };

            const onData = chunk => {
                buf = Buffer.concat([buf, chunk]);
                if (buf.length < 10) return;
                const expected = buf.readUInt16BE(8) + 10;
                if (buf.length >= expected) done(buf.slice(0, expected));
            };
            const onErr   = err => fail(err);
            // A controller that turns a session away commonly drops the connection
            // rather than replying. Without these two that is a silent full-length hang
            // reported as a generic timeout, which hides the real cause.
            const onClose = () => fail(new Error('FOCAS connection closed by controller'));
            const onEnd   = () => fail(new Error('FOCAS connection ended by controller'));

            timer = setTimeout(() => {
                fail(new Error('FOCAS recv timeout'));
                // A partial frame may already have been consumed, so the stream is
                // desynchronised and this socket cannot be reused. Destroying it here
                // also stops a timed-out poll from holding a session on the controller.
                this.destroy();
            }, this.timeout);

            socket.on('data',  onData);
            socket.on('error', onErr);
            socket.on('close', onClose);
            socket.on('end',   onEnd);
        });
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────
    // Drop the socket without the CLS handshake. Safe to call repeatedly and on a
    // socket that is already dead.
    destroy() {
        const sock = this.socket;
        this.socket = null;
        if (!sock) return;
        sock.setTimeout(0);
        sock.unref();
        sock.destroy();
    }

    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;
            // Every failure path has to tear the socket down. A socket left ESTABLISHED
            // after a refused handshake still occupies one of the controller's session
            // slots, and those do not come back until this process releases it — which,
            // with a poll opening a fresh session each time, means the next polls fail
            // too for a reason that has nothing to do with them.
            const done = err => {
                if (settled) return;
                settled = true;
                if (err) { this.destroy(); reject(err); }
                else     { resolve(); }
            };

            this.socket = new net.Socket();
            this.socket.setTimeout(this.timeout);
            this.socket.connect(this.port, this.ip, async () => {
                try {
                    await this._send(encap(FTYPE_OPN_REQU, FRAME_DST));
                    const raw = await this._recv();
                    const res = decap(raw);
                    if (res.ftype === FTYPE_OPN_REFUTED) {
                        return done(new Error(
                            'Open refused by controller — every FOCAS session is in use' +
                            ` (ftype 0x0103, bytes=${raw.length}, head=${hexDump(raw)})`
                        ));
                    }
                    if (res.ftype !== FTYPE_OPN_RESP) {
                        const got = res.ftype === undefined
                            ? 'no valid frame'
                            : `0x${res.ftype.toString(16).padStart(4, '0')}`;
                        return done(new Error(
                            `Open handshake failed — expected ftype 0x0102, got ${got}` +
                            ` (bytes=${raw.length}, head=${hexDump(raw)})`
                        ));
                    }
                    await this._getsysinfo();
                    done();
                } catch (e) { done(e); }
            });
            // Kept attached after a successful connect on purpose: an 'error' with no
            // listener is an uncaught exception, and this is a no-op once settled.
            this.socket.on('error', done);
            this.socket.on('timeout', () => {
                if (settled) return;      // set up already — _recv owns the timeout now
                done(new Error('Connection timeout'));
            });
        });
    }

    // async disconnect() {
    //     if (!this.socket) return;
    //     try {
    //         await this._send(encap(FTYPE_CLS_REQU, Buffer.alloc(0)));
    //         await this._recv();
    //     } catch (_) {}
    //     this.socket.destroy();
    //     this.socket = null;
    // }

    async disconnect() {
        if (!this.socket) return;
        const sock = this.socket;
        this.socket = null;       // ← clear ref first — prevents double-disconnect if new poll fires
        try {
            sock.write(encap(FTYPE_CLS_REQU, Buffer.alloc(0)));
            // ← NO await recv — controller's response stays unread in kernel buffer
        } catch (_) {}
        sock.setTimeout(0);       // cancel any pending timeout
        sock.setKeepAlive(false); // no keepalive probes on exit
        sock.unref();             // don't block process exit
        sock.destroy();           // close(fd) with unread data in buffer → Linux sends RST → no TIME_WAIT
    }

    // ── Request primitives ────────────────────────────────────────────────────
    async _reqSingle(c1, c2, c3, v1=0, v2=0, v3=0, v4=0, v5=0, pl=Buffer.alloc(0)) {
        const cmd = Buffer.alloc(6);
        cmd.writeUInt16BE(c1, 0); cmd.writeUInt16BE(c2, 2); cmd.writeUInt16BE(c3, 4);
        const args = Buffer.alloc(20);
        args.writeInt32BE(v1,  0); args.writeInt32BE(v2,  4);
        args.writeInt32BE(v3,  8); args.writeInt32BE(v4, 12); args.writeInt32BE(v5, 16);
        await this._send(encap(FTYPE_VAR_REQU, Buffer.concat([cmd, args, pl])));
        const raw = await this._recv();
        const t   = decap(raw);
        if (t.len === 0) return { len: -1 };
        if (t.ftype !== FTYPE_VAR_RESP) return { len: -1 };
        const d = t.data[0];
        if (d.slice(0, 6).equals(cmd) && d[6] === 0 && d[7] === 0 && d[8] === 0 && d[9] === 0 && d[10] === 0 && d[11] === 0) {
            return { len: d.readUInt16BE(12), data: d.slice(14) };
        }
        if (d.slice(0, 6).equals(cmd)) {
            return { len: 0, data: d.slice(6), error: d.readInt16BE(6) };
        }
        return { len: -1 };
    }

    async _reqMulti(list) {
        await this._send(encap(FTYPE_VAR_REQU, list));
        const raw = await this._recv();
        const t   = decap(raw);
        if (t.len === 0 || t.ftype !== FTYPE_VAR_RESP) return { len: -1 };
        if (list.length !== t.data.length) return { len: -1 };
        for (let x = 0; x < t.data.length; x++) {
            if (t.data[x].slice(0, 6).equals(list[x].slice(0, 6))) {
                // Same sub-payload layout as _reqSingle: echo(6) | status(6) | len(2) | data.
                // The length prefix is stripped here so `data` means the same thing from
                // both request helpers — reading it as a record count is not possible.
                const zeros = t.data[x].slice(6, 12).every(b => b === 0);
                t.data[x] = zeros
                    ? [0, t.data[x].slice(14)]
                    : [t.data[x].readInt16BE(6), t.data[x].slice(14)];
            } else {
                return { len: -1 };
            }
        }
        return t;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async _getsysinfo() {
        const st = await this._reqSingle(1, 1, 0x18);
        if (st.len !== 0x12) throw new Error('getsysinfo: unexpected response length');
        this.sysinfo = {
            addinfo: st.data.readUInt16BE(0),
            maxaxis: st.data.readUInt16BE(2),
            cnctype: st.data.slice(4,  6).toString('ascii'),
            mttype:  st.data.slice(6,  8).toString('ascii'),
            series:  st.data.slice(8,  12).toString('ascii'),
            version: st.data.slice(12, 16).toString('ascii'),
            axes:    st.data.slice(16, 18).toString('ascii'),
        };
    }

    async statinfo() {
        const st = await this._reqSingle(1, 1, 0x19, 0);
        const t  = this.sysinfo.cnctype.trim();
        const is16 = ['16','31','18','0i','30',' 0','0 '].includes(t) ||
                     t === '0';   // 0i-D returns bare '0'
        if (is16 && st.len === 0x0e) {
            const d = st.data;
            return {
                hdck:      d.readUInt16BE(0),
                tmmode:    d.readUInt16BE(2),  // actually: aut at offset 0 per ODBST layout...
                aut:       d.readUInt16BE(0),
                run:       d.readUInt16BE(2),
                motion:    d.readUInt16BE(4),
                mstb:      d.readUInt16BE(6),
                emegency:  d.readUInt16BE(8),
                alarm:     d.readUInt16BE(10),
                edit:      d.readUInt16BE(12),
            };
        }
        return null;
    }

    async readprognum() {
        const st = await this._reqSingle(1, 1, 0x1c);
        if (st.len < 8) return null;
        return {
            run:  st.data.readInt32BE(0),
            main: st.data.readInt32BE(4),
        };
    }

    async listprog(start = 1) {
        const ret = {};
        while (true) {
            const st = await this._reqSingle(1, 1, 0x06, start, 0x13, 2);
            if (st.len < -1) return null;
            if (st.len === 0) return ret;
            for (let t = 0; t + 72 <= st.len; t += 72) {
                const number  = st.data.readUInt32BE(t);
                // size       = st.data.readUInt32BE(t+4);
                let comment   = st.data.slice(t + 8, t + 72);
                const nullIdx = comment.indexOf(0);
                if (nullIdx !== -1) comment = comment.slice(0, nullIdx);
                ret[number] = { comment: comment.toString('ascii') };
                start = number + 1;
            }
        }
    }

    async readparam3(axis, first, last = 0) {
        if (last === 0) last = first;
        // Try 0x8d (0i/30i), fall back to 0x0e (16/18/21i) if response empty
        let st = await this._reqSingle(1, 1, 0x8d, first, last, axis);
        if (st.len <= 0) {
            st = await this._reqSingle(1, 1, 0x0e, first, last, axis);
        }
        if (st.len <= 0) return null;
        return parseParamBody(st.data, this.sysinfo.maxaxis);
    }

    async readactfeed() {
        const st = await this._reqSingle(1, 1, 0x24);
        return (st.len === 8) ? decode8(st.data) : null;
    }

    async readactspindlespeed() {
        const st = await this._reqSingle(1, 1, 0x25);
        return (st.len === 8) ? decode8(st.data) : null;
    }

    /**
     * cnc_rdalmmsg (0x23) — the alarm messages currently arising on the CNC.
     *
     * `type` is an alarm *category*, not a bitmask, and the enum is different on every
     * CNC series (FOCAS2 spec: Document/SpecE/Misc/cnc_rdalmmsg.xml). -1 means "all type"
     * on all series, which is what callers almost always want.
     *
     * The wire record is (16 + textlength) bytes — alm_no(i32) type(i32) axis(i32)
     * msg_len(i32) text. The C ODBALMMSG struct is only 44 bytes because the three short
     * attribute fields are widened to 4 bytes and `dummy` is dropped on the wire.
     *
     * Throws on a real FOCAS error (e.g. EW_ATTRIB for an out-of-range type) rather than
     * returning [] — an empty array means "no alarms", nothing else.
     */
    async readalarmcode(type = -1, withtext = 1, maxmsgs = -1, textlength = 32) {
        if (maxmsgs <= 0) maxmsgs = (this.sysinfo && this.sysinfo.maxaxis) || 32;
        const st = await this._reqSingle(1, 1, 0x23, type, maxmsgs, withtext, textlength);
        if (st.len < 0)
            throw new Error(reqErr('cnc_rdalmmsg', st));
        if (st.len === 0) {
            // _reqSingle omits `error` entirely for a clean success carrying no data.
            if (st.error !== undefined)
                throw new Error(reqErr('cnc_rdalmmsg', st, `for type=${type}`));
            return [];
        }
        const stride = 4 * 4 + textlength;
        const ret = [];
        for (let pos = 0; pos + stride <= st.len; pos += stride) {
            const entry = {
                alarmcode: st.data.readInt32BE(pos),
                alarmtype: st.data.readInt32BE(pos + 4),
                axis:      st.data.readInt32BE(pos + 8),
            };
            const txlen = st.data.readInt32BE(pos + 12);
            if (txlen > 0 && withtext > 0) {
                let text = st.data.slice(pos + 16, pos + 16 + textlength);
                const nullIdx = text.indexOf(0);
                if (nullIdx !== -1) text = text.slice(0, nullIdx);
                entry.text = text.toString('ascii').trim();
            } else {
                entry.text = '';
            }
            ret.push(entry);
        }
        return ret;
    }

    // ── Axes position data ────────────────────────────────────────────────────
    // what bitmask: ABS=1, REL=2, REF=4 (machine pos), DIST=16
    async readaxes(what = 1, axis = ALLAXIS) {
        const axvalues = [
            { name:'ABS',  flag:1,  sub:4 },
            { name:'REL',  flag:2,  sub:6 },
            { name:'REF',  flag:4,  sub:1 },
            { name:'SKIP', flag:8,  sub:8 },
            { name:'DIST', flag:16, sub:7 },
        ];
        const cmds = axvalues
            .filter(a => what & a.flag)
            .map(a => {
                const b = Buffer.alloc(26);
                b.writeUInt16BE(1, 0); b.writeUInt16BE(1, 2); b.writeUInt16BE(0x26, 4);
                b.writeInt32BE(a.sub, 6); b.writeInt32BE(axis, 10);
                return b;
            });
        if (cmds.length === 0) return null;
        const st = await this._reqMulti(cmds);
        if (!st || st.len < 0) return null;

        // The CNC sizes every block for the maximum axis count and leaves the slots
        // past the axes it actually controls undefined — the spec says only "the data
        // for current controlled axes are valid". Those slots still carry a decimal
        // flag, so decoding them yields plausible-looking numbers that are not
        // positions (the official library hands back the same integers at the same
        // indices and leaves it to the caller not to look at them). Bound the sweep
        // by the real axis count, never by the buffer length.
        const recs = axis === ALLAXIS ? await this.readaxiscount(AXNUM_SERVO) : 1;

        const result = {};
        let idx = 0;
        for (const a of axvalues) {
            if (!(what & a.flag)) continue;
            const d = st.data[idx++];
            if (!d || d[0] !== 0) { result[a.name] = null; continue; }
            const body = d[1];
            const vals = [];
            for (let p = 0; p + 8 <= body.length && vals.length < recs; p += 8)
                vals.push(decode8(body.slice(p, p + 8)));
            result[a.name] = vals;
        }
        return result;
    }

    // ── Macro variables ───────────────────────────────────────────────────────
    async readmacro(first, last = 0) {
        if (last === 0) last = first;
        const st = await this._reqSingle(1, 1, 0x15, first, last);
        if (st.len <= 0) return null;
        const r = {};
        let n = first;
        for (let pos = 0; pos + 8 <= st.len; pos += 8) {
            r[n++] = decode8(st.data.slice(pos, pos + 8));
        }
        return r;
    }

    // ── Load meters ───────────────────────────────────────────────────────────
    // Each 8-byte record holds value(i32 BE) then the decimal position(i16 BE) at +6,
    // so the reading is value / 10^dec — the official library reports dec=0 for a
    // load meter (unit: 0 = %, 1 = rpm). The response is always sized for the maximum
    // axis count, not the live one, and the tail beyond the real axes is stale buffer
    // contents, so the count from cnc_rdaxisnum — never maxaxis — bounds the loop.
    _loadReadings(data, stride, count) {
        const out = [];
        for (let i = 0; i < count && (i + 1) * stride <= data.length; i++) {
            const value = data.readInt32BE(i * stride);
            const dec   = data.readInt16BE(i * stride + 6);
            out.push(value / Math.pow(10, dec));
        }
        return out;
    }

    async readaxiscount(type) {
        const st = await this._reqSingle(1, 1, FN_AXISNUM, type);
        if (st.len < 2) throw new Error(reqErr('cnc_rdaxisnum', st, `for type=${type}`));
        return st.data.readInt16BE(0);
    }

    // One record per servo axis, reported as a magnitude. The reading selector picks the
    // unit and the controller reports the matching decimal position with it — LOAD gives
    // dec 0 (per cent), CURRENT gives dec 2, so the Ampere value arrives as a hundredth.
    async readsvmeter(reading = SVMETER_LOAD) {
        const count = await this.readaxiscount(AXNUM_SERVO);
        const st = await this._reqSingle(1, 1, FN_SVMETER, reading);
        if (st.len <= 0) throw new Error(reqErr('cnc_rdsvmeter', st, `for reading=${reading}`));
        return this._loadReadings(st.data, LOADELM_STRIDE, count).map(Math.abs);
    }

    // Two records per spindle (load meter, then motor speed); only the named one is kept.
    async readspmeter(type = SPMETER_LOAD) {
        const count = await this.readaxiscount(AXNUM_SPINDLE);
        const st = await this._reqSingle(1, 1, FN_SPMETER, type, ALLAXIS);
        if (st.len <= 0) throw new Error(reqErr('cnc_rdspmeter', st, `for type=${type}`));
        return this._loadReadings(st.data, SPMETER_STRIDE, count);
    }

    // ── Axis / spindle names ──────────────────────────────────────────────────
    // 4-byte records with the name in byte 0 ("X", "S"); the remaining bytes are
    // not useful on the wire.
    _names(st, count) {
        if (!st || st.len <= 0) return [];
        const n = Math.min(count, Math.floor(st.data.length / 4));
        const out = [];
        for (let i = 0; i < n; i++)
            out.push(st.data.slice(i * 4, i * 4 + 4).toString('latin1').split('\0')[0].trim());
        return out;
    }

    async readaxisnames(count) {
        return this._names(await this._reqSingle(1, 1, FN_SVNAME, 0), count);
    }

    async readspindlenames(count) {
        return this._names(await this._reqSingle(1, 1, FN_SPNAME, ALLAXIS), count);
    }

    async readservoload() {
        return this.readsvmeter();
    }

    async readservocurrent() {
        return this.readsvmeter(SVMETER_CURRENT);
    }

    async readspindleload() {
        const values = await this.readspmeter();
        return values.length ? values[0] : null;
    }
}

module.exports = { Focas, ALLAXIS };
