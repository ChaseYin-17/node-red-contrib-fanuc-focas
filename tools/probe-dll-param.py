#!/usr/bin/env python3
"""
tools/probe-dll-param.py — READ-ONLY: what does the vendor library put on the wire
for cnc_rdparam3, cnc_rdmacro, cnc_rdprogdir and cnc_rddynamic2?

WHY
    focas.js sends these four with argument orders that are not the C signatures in
    Fwlib64.h, and the response layouts it decodes are not the C structs either. The
    SDK headers cannot settle it — they declare the C API, not the wire. The only
    faithful source is the library's own traffic, captured through a local proxy.

    This is the same technique as tools/probe-dll-opcode.py, scoped to the four calls
    whose argument order is still unverified.

READ-ONLY
    cnc_rdparam3 / cnc_rdmacro / cnc_rdprogdir / cnc_rddynamic2 / cnc_rdaxisname /
    cnc_rdspdlname are all reads. There is no write, reset, clear or mode change in
    this script, and no function that could alter CNC state.

Usage:
    python tools/probe-dll-param.py [ip] [port] [listen_port]
    python tools/probe-dll-param.py 10.192.233.166 8193 9101
"""

import ctypes
import glob
import os
import socket
import struct
import sys
import threading
import time

ARGV        = [a for a in sys.argv[1:] if not a.startswith('--')]
IP          = ARGV[0] if len(ARGV) > 0 else '10.192.233.166'
CNC_PORT    = int(ARGV[1]) if len(ARGV) > 1 else 8193
LISTEN_PORT = int(ARGV[2]) if len(ARGV) > 2 else 9101

FOCAS_ERRORS = {
    -17: 'EW_PROTOCOL', -16: 'EW_SOCKET', -15: 'EW_NODLL', -11: 'EW_BUS',
    -10: 'EW_SYSTEM2',   -9: 'EW_HSSB',    -8: 'EW_HANDLE', -7: 'EW_VERSION',
     -6: 'EW_UNEXP',     -5: 'EW_SYSTEM',  -4: 'EW_PARITY', -3: 'EW_MMCSYS',
     -2: 'EW_RESET',     -1: 'EW_BUSY',     0: 'EW_OK',      1: 'EW_FUNC',
      2: 'EW_LENGTH',     3: 'EW_NUMBER',   4: 'EW_ATTRIB',  5: 'EW_DATA',
      6: 'EW_NOOPT',      7: 'EW_PROT',     8: 'EW_OVRFLOW', 9: 'EW_PARAM',
     10: 'EW_BUFFER',    11: 'EW_PATH',    12: 'EW_MODE',   13: 'EW_REJECT',
     14: 'EW_DTSRVR',    15: 'EW_ALARM',   16: 'EW_STOP',   17: 'EW_PASSWD',
}


def err_name(ret):
    return '%s (%d)' % (FOCAS_ERRORS.get(ret, 'EW_UNKNOWN'), ret)


def find_dll_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    env = os.environ.get('FOCAS_DLL_DIR')
    cands = ([env] if env else []) + [
        os.path.join(here, '..', 'docs', 'FANUC_Focas_API', 'Fwlib64'),
        os.path.join(here, '..', 'lib', 'FOCAS2 Library', 'Fwlib64'),
    ]
    for c in cands:
        c = os.path.abspath(c)
        if os.path.isfile(os.path.join(c, 'Fwlib64.dll')):
            return c
    return None


DLL_DIR = find_dll_dir()

# ── Proxy ─────────────────────────────────────────────────────────────────────

_lock = threading.Lock()
_frames = []


def hexdump(buf):
    out = []
    for i in range(0, len(buf), 16):
        chunk = buf[i:i + 16]
        hexs = ' '.join('%02x' % b for b in chunk).ljust(47)
        asc = ''.join(chr(b) if 0x20 <= b < 0x7f else '.' for b in chunk)
        out.append('    %04x  %s  |%s|' % (i, hexs, asc))
    return '\n'.join(out)


def describe_request(frame):
    """Decode a 0x2101 request frame into its sub-commands."""
    if len(frame) < 12:
        return ['      (short frame)']
    body = frame[10:]
    if len(body) < 2:
        return ['      (no body)']
    count = struct.unpack('>H', body[0:2])[0]
    lines = ['      %d sub-command(s)' % count]
    off = 2
    for i in range(count):
        if off + 2 > len(body):
            break
        le = struct.unpack('>H', body[off:off + 2])[0]
        sub = body[off + 2:off + le]
        off += le
        if len(sub) < 6:
            lines.append('      sub[%d] short (%d bytes)' % (i, len(sub)))
            continue
        c1, c2, func = struct.unpack('>HHH', sub[0:6])
        args = [struct.unpack('>i', sub[o:o + 4])[0]
                for o in range(6, min(len(sub), 26), 4)]
        line = ('      sub[%d] c1=%d c2=%d func=0x%04x args=%s'
                % (i, c1, c2, func, ' '.join(str(a) for a in args) or '(none)'))
        if len(sub) > 26:
            line += ' +%d bytes: %s' % (len(sub) - 26, sub[26:].hex(' '))
        lines.append(line)
    return lines


def pump(src, dst, direction):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            with _lock:
                _frames.append((direction, data))
            print('\n  ── %s (%d bytes) ──' % (
                'DLL→CNC' if direction == '>' else 'CNC→DLL', len(data)))
            print(hexdump(data))
            if direction == '>':
                for line in describe_request(data):
                    print(line)
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def start_proxy():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', LISTEN_PORT))
    srv.listen(4)

    def serve():
        while True:
            try:
                client, _ = srv.accept()
            except OSError:
                return
            try:
                upstream = socket.create_connection((IP, CNC_PORT), timeout=10)
            except OSError as e:
                print('  upstream connect failed: %s' % e)
                client.close()
                continue
            threading.Thread(target=pump, args=(client, upstream, '>'), daemon=True).start()
            threading.Thread(target=pump, args=(upstream, client, '<'), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    return srv


# ── ctypes structures (only the ones needed to call the reads) ────────────────

class REALPRM(ctypes.Structure):
    _fields_ = [('prm_val', ctypes.c_long), ('dec_val', ctypes.c_long)]


class IODBPSD(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short),
                ('type', ctypes.c_short),
                ('ldata', ctypes.c_long * 32)]


class ODBM(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short), ('dummy', ctypes.c_short),
                ('mcr_val', ctypes.c_long), ('dec_val', ctypes.c_short)]


class ODBAXISNAME(ctypes.Structure):
    _fields_ = [('name', ctypes.c_char), ('suff', ctypes.c_char)]


class ODBSPDLNAME(ctypes.Structure):
    _fields_ = [('name', ctypes.c_char), ('suff1', ctypes.c_char),
                ('suff2', ctypes.c_char), ('suff3', ctypes.c_char)]


class PRGDIR(ctypes.Structure):
    _fields_ = [('prg_data', ctypes.c_char * 4096)]


def load_dll():
    if not DLL_DIR:
        raise SystemExit('Fwlib64.dll not found — set FOCAS_DLL_DIR')
    os.add_dll_directory(DLL_DIR)
    for path in sorted(glob.glob(os.path.join(DLL_DIR, 'fwlib*64.dll'))):
        try:
            ctypes.WinDLL(path)
        except OSError:
            pass
    os.chdir(DLL_DIR)
    return ctypes.WinDLL(os.path.join(DLL_DIR, 'Fwlib64.dll'))


def bind(fw):
    fw.cnc_allclibhndl3.restype = ctypes.c_short
    fw.cnc_allclibhndl3.argtypes = [ctypes.c_char_p, ctypes.c_ushort,
                                    ctypes.c_short, ctypes.POINTER(ctypes.c_ushort)]
    fw.cnc_freelibhndl.restype = ctypes.c_short
    fw.cnc_freelibhndl.argtypes = [ctypes.c_ushort]

    for name, argtypes in [
        ('cnc_rdparam3', [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                          ctypes.c_short, ctypes.c_short, ctypes.POINTER(IODBPSD)]),
        ('cnc_rdmacro',  [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                          ctypes.POINTER(ODBM)]),
        ('cnc_rdprogdir', [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                           ctypes.c_short, ctypes.c_ushort, ctypes.POINTER(PRGDIR)]),
        ('cnc_rdaxisname', [ctypes.c_ushort, ctypes.POINTER(ctypes.c_short),
                            ctypes.POINTER(ODBAXISNAME)]),
        ('cnc_rdspdlname', [ctypes.c_ushort, ctypes.POINTER(ctypes.c_short),
                            ctypes.POINTER(ODBSPDLNAME)]),
    ]:
        fn = getattr(fw, name, None)
        if fn is None:
            print('  !! %s not exported' % name)
            continue
        fn.restype = ctypes.c_short
        fn.argtypes = argtypes


def h(title):
    print('\n' + '=' * 78 + '\n' + title + '\n' + '=' * 78)


def main():
    h('Loading vendor library')
    print('  DLL dir: %s' % DLL_DIR)
    fw = load_dll()
    bind(fw)

    proxy = start_proxy()
    print('  proxy listening on 127.0.0.1:%d  →  %s:%d' % (LISTEN_PORT, IP, CNC_PORT))

    h('Opening a session THROUGH the proxy')
    handle = ctypes.c_ushort(0)
    ret = fw.cnc_allclibhndl3(b'127.0.0.1', LISTEN_PORT, 20, ctypes.byref(handle))
    print('\n  cnc_allclibhndl3 → %s   handle=%d' % (err_name(ret), handle.value))
    if ret != 0:
        print('\n  Cannot open a handle — the capture below is worthless. Stopping.')
        proxy.close()
        return

    # ── cnc_rdparam3 ─────────────────────────────────────────────────────────
    h('TARGET — cnc_rdparam3: argument order and the response block')
    for number, axis, length, absolute in [
        (6711, -1, 264, 0),   # all axes, the block the node gets
        (6711, 0, 8, 0),      # no axis, 8-byte block
        (1000, 0, 8, 0),      # bit parameter
        (1002, 0, 8, 0),      # word parameter
        (5001, 0, 16, 0),     # real parameter
        (1020, -1, 264, 0),   # bit parameter with axis
    ]:
        buf = IODBPSD()
        ret = fw.cnc_rdparam3(handle, number, axis, length, absolute, ctypes.byref(buf))
        print('\n  cnc_rdparam3(number=%d, axis=%d, length=%d, absolute=%d) → %s'
              % (number, axis, length, absolute, err_name(ret)))
        if ret == 0:
            print('    datano=%d type=0x%04x (upper=%d lower=%d)'
                  % (buf.datano, buf.type & 0xffff, (buf.type >> 8) & 0xff, buf.type & 0xff))
            raw = bytes(buf.ldata)
            print('    data: %s' % ' '.join('%02x' % b for b in raw[:40]))
            print('    as i32: %s' % ', '.join(
                str(struct.unpack('>i', raw[o:o + 4])[0]) for o in range(0, 32, 4)))

    # ── cnc_rdmacro ──────────────────────────────────────────────────────────
    h('TARGET — cnc_rdmacro: argument order')
    for number, length in [(1, 1), (1, 10), (100, 10), (500, 10)]:
        buf = ODBM()
        ret = fw.cnc_rdmacro(handle, number, length, ctypes.byref(buf))
        print('\n  cnc_rdmacro(number=%d, length=%d) → %s'
              % (number, length, err_name(ret)))
        if ret == 0:
            print('    datano=%d mcr_val=%d dec_val=%d'
                  % (buf.datano, buf.mcr_val, buf.dec_val))

    # ── cnc_rdprogdir ────────────────────────────────────────────────────────
    h('TARGET — cnc_rdprogdir: argument order and the payload')
    for type_, s, e, length in [(2, 1, 3, 512), (1, 1, 3, 512), (0, 1, 3, 512)]:
        buf = PRGDIR()
        ret = fw.cnc_rdprogdir(handle, type_, s, e, length, ctypes.byref(buf))
        print('\n  cnc_rdprogdir(type=%d, datano_s=%d, datano_e=%d, length=%d) → %s'
              % (type_, s, e, length, err_name(ret)))
        if ret == 0:
            raw = bytes(buf.prg_data)
            print('    data: %s' % ' '.join('%02x' % b for b in raw[:80]))
            print('    as text: %r' % raw.split(b'\0')[0][:120])

    # ── axis / spindle names ─────────────────────────────────────────────────
    h('TARGET — cnc_rdaxisname / cnc_rdspdlname: data_num semantics')
    for n in [0, 5, 32]:
        num = ctypes.c_short(n)
        buf = (ODBAXISNAME * 32)()
        ret = fw.cnc_rdaxisname(handle, ctypes.byref(num), buf)
        print('\n  cnc_rdaxisname(data_num=%d) → %s   *data_num=%d'
              % (n, err_name(ret), num.value))
        if ret == 0:
            print('    names: %r' % [buf[i].name.decode('latin1') + buf[i].suff.decode('latin1')
                                     for i in range(min(num.value, 32))])
    for n in [0, 1, 32]:
        num = ctypes.c_short(n)
        buf = (ODBSPDLNAME * 32)()
        ret = fw.cnc_rdspdlname(handle, ctypes.byref(num), buf)
        print('\n  cnc_rdspdlname(data_num=%d) → %s   *data_num=%d'
              % (n, err_name(ret), num.value))
        if ret == 0:
            print('    names: %r' % [buf[i].name.decode('latin1') + buf[i].suff1.decode('latin1')
                                     + buf[i].suff2.decode('latin1')
                                     for i in range(min(num.value, 32))])

    h('Closing')
    ret = fw.cnc_freelibhndl(handle)
    print('  cnc_freelibhndl → %s' % err_name(ret))
    time.sleep(0.3)
    proxy.close()


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('This script drives Fwlib64.dll — Windows only.')
    main()
