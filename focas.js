'use strict';
/**
 * focas.js — Pure Node.js FOCAS2 TCP client
 * Port of diohpix/pyfanuc with all known bug-fixes applied.
 *
 * Protocol constants match pyfanuc.py exactly.
 * All methods return Promises.
 */
const net = require('net');

// ── Frame type constants ──────────────────────────────────────────────────────
const FTYPE_OPN_REQU = 0x0101;
const FTYPE_OPN_RESP = 0x0102;
const FTYPE_VAR_REQU = 0x2101;
const FTYPE_VAR_RESP = 0x2102;
const FTYPE_CLS_REQU = 0x0201;
const FTYPE_CLS_RESP = 0x0202;

const FRAMEHEAD = Buffer.from([0xa0, 0xa0, 0xa0, 0xa0]);
const FRAME_DST = Buffer.from([0x00, 0x02]);
const ALLAXIS   = -1;

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

// ── Parse param/diag response body ───────────────────────────────────────────
function parseParamBody(data, maxaxis, mode = 'param3') {
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
            if (mode === 'param3') {
                if      (valtype === 0) value = chunk[3];
                else if (valtype === 1) { const b = chunk[3]; value = [7,6,5,4,3,2,1,0].map(i => (b>>i)&1); }
                else if (valtype === 2) value = chunk.readInt16BE(2);   // fix: last 2 bytes
                else if (valtype === 3) value = chunk.readInt32BE(0);
            } else { // diag
                if      (valtype === 4 || valtype === 0) value = chunk[3];
                else if (valtype === 1) value = chunk.readInt16BE(2);
                else if (valtype === 2) value = chunk.readInt32BE(0);
                else if (valtype === 3) { const b = chunk[3]; value = [7,6,5,4,3,2,1,0].map(i => (b>>i)&1); }
            }
            if (axiscount !== -1) { values.data.push(value); break; }
            else                    values.data.push(value);
        }
        r[varname] = values;
    }
    return r;
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
            const timer = setTimeout(() => reject(new Error('FOCAS recv timeout')), this.timeout);
            let buf = Buffer.alloc(0);

            const onData = chunk => {
                buf = Buffer.concat([buf, chunk]);
                if (buf.length < 10) return;
                const expected = buf.readUInt16BE(8) + 10;
                if (buf.length >= expected) {
                    clearTimeout(timer);
                    this.socket.removeListener('data', onData);
                    this.socket.removeListener('error', onErr);
                    resolve(buf.slice(0, expected));
                }
            };
            const onErr = err => { clearTimeout(timer); reject(err); };
            this.socket.on('data', onData);
            this.socket.on('error', onErr);
        });
    }

    // ── Connect / disconnect ──────────────────────────────────────────────────
    connect() {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();
            this.socket.setTimeout(this.timeout);
            this.socket.connect(this.port, this.ip, async () => {
                try {
                    await this._send(encap(FTYPE_OPN_REQU, FRAME_DST));
                    const raw = await this._recv();
                    const res = decap(raw);
                    if (res.ftype !== FTYPE_OPN_RESP) return reject(new Error('Open handshake failed'));
                    await this._getsysinfo();
                    resolve();
                } catch (e) { reject(e); }
            });
            this.socket.on('error', reject);
            this.socket.on('timeout', () => reject(new Error('Connection timeout')));
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
                const zeros = t.data[x].slice(6, 12).every(b => b === 0);
                t.data[x] = zeros
                    ? [0, t.data[x].slice(12)]
                    : [t.data[x].readInt16BE(0), t.data[x].slice(12)];
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
        return parseParamBody(st.data, this.sysinfo.maxaxis, 'param3');
    }

    async readactfeed() {
        const st = await this._reqSingle(1, 1, 0x24);
        return (st.len === 8) ? decode8(st.data) : null;
    }

    async readactspindlespeed() {
        const st = await this._reqSingle(1, 1, 0x25);
        return (st.len === 8) ? decode8(st.data) : null;
    }

    async readalarmcode(type, withtext = 1, maxmsgs = -1, textlength = 32) {
        if (maxmsgs <= 0) maxmsgs = parseInt(this.sysinfo.axes) || 32;
        const st = await this._reqSingle(1, 1, 0x23, type, maxmsgs, withtext, textlength);
        if (st.len <= 0) return [];
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
        const result = {};
        let idx = 0;
        for (const a of axvalues) {
            if (!(what & a.flag)) continue;
            const d = st.data[idx++];
            if (!d || d[0] !== 0) { result[a.name] = null; continue; }
            const body = d[1];
            const count = body.readUInt16BE(0);
            const vals = [];
            for (let p = 2; p < count * 8 + 2; p += 8) vals.push(decode8(body.slice(p, p + 8)));
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

    // ── Servo load (diag 400, per-axis percentage) ────────────────────────────
    async readservoload() {
        const st = await this._reqSingle(1, 1, 0x30, 400, 400, ALLAXIS);
        if (st.len <= 0) return null;
        const r400 = parseParamBody(st.data, this.sysinfo.maxaxis, 'diag')[400]; return r400 ? r400.data : null;
    }

    // ── Spindle load (diag 300, percentage) ──────────────────────────────────
    async readspindleload() {
        const st = await this._reqSingle(1, 1, 0x30, 300, 300, ALLAXIS);
        if (st.len <= 0) return null;
        const r300 = parseParamBody(st.data, this.sysinfo.maxaxis, 'diag')[300]; return r300 ? r300.data : null;
    }
}

module.exports = { Focas, ALLAXIS };
