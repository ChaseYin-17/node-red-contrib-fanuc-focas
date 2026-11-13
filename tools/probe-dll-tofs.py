#!/usr/bin/env python3
"""
tools/probe-dll-tofs.py — READ-ONLY: capture the vendor library's tool-offset traffic.

WHY
    The opcodes this project guessed for the offset reads (0x2c cnc_rdtofs, 0x2d
    cnc_rdtofsr, 0x2e cnc_rdtofsinfo, 0x2a cnc_rdzofs) answer, but every offset number
    and type returns the same bytes — which is what a wrong opcode looks like: the
    controller answers some *other* function and nothing in the reply says so.

    FOCAS function codes are not in the SDK headers. The only faithful source is the
    vendor library's own traffic, captured through a local TCP proxy. Same technique as
    tools/probe-dll-opcode.py and tools/probe-dll-param.py.

READ-ONLY
    cnc_rdtofs / cnc_rdtofsr / cnc_rdtofsinfo / cnc_rdzofs / cnc_rdzofsinfo /
    cnc_tofs_rnge / cnc_rdtlgeomsize_ext are all reads. There is no cnc_wrtofs,
    cnc_wrtofsr, cnc_wrzofs or any other write in this script.

Usage:
    python tools/probe-dll-tofs.py [ip] [port] [listen_port]
    python tools/probe-dll-tofs.py 10.192.233.166 8193 9103
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
LISTEN_PORT = int(ARGV[2]) if len(ARGV) > 2 else 9103

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

_lock = threading.Lock()


def hexdump(buf):
    out = []
    for i in range(0, len(buf), 16):
        chunk = buf[i:i + 16]
        hexs = ' '.join('%02x' % b for b in chunk).ljust(47)
        asc = ''.join(chr(b) if 0x20 <= b < 0x7f else '.' for b in chunk)
        out.append('    %04x  %s  |%s|' % (i, hexs, asc))
    return '\n'.join(out)


def describe_request(frame):
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


# ── ctypes structures ─────────────────────────────────────────────────────────

class ODBTOFS(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short), ('type', ctypes.c_short),
                ('data', ctypes.c_long)]


class ODBTOFSINFO(ctypes.Structure):
    _fields_ = [('ofs_type', ctypes.c_short), ('use_no', ctypes.c_short)]


class ODBZOF(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short), ('type', ctypes.c_short),
                ('data', ctypes.c_long)]


class ODBZOFINFO(ctypes.Structure):
    _fields_ = [('ofs_type', ctypes.c_short), ('use_no', ctypes.c_short)]


class IODBTO(ctypes.Structure):
    # 6-byte header + a generous union; the library writes at most length bytes.
    _fields_ = [('datano_s', ctypes.c_short), ('type', ctypes.c_short),
                ('datano_e', ctypes.c_short), ('u', ctypes.c_long * 512)]


class ODBTOFSRNGE(ctypes.Structure):
    _fields_ = [('data', ctypes.c_long * 8)]


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
        ('cnc_rdtofs',      [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                             ctypes.c_short, ctypes.POINTER(ODBTOFS)]),
        ('cnc_rdtofsinfo',  [ctypes.c_ushort, ctypes.POINTER(ODBTOFSINFO)]),
        ('cnc_rdtofsr',     [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                             ctypes.c_short, ctypes.c_short, ctypes.POINTER(IODBTO)]),
        ('cnc_rdzofs',      [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                             ctypes.c_short, ctypes.POINTER(ODBZOF)]),
        ('cnc_rdzofsinfo',  [ctypes.c_ushort, ctypes.POINTER(ODBZOFINFO)]),
        ('cnc_tofs_rnge',   [ctypes.c_ushort, ctypes.c_short,
                             ctypes.POINTER(ODBTOFSRNGE)]),
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

    # ── cnc_rdtofsinfo ───────────────────────────────────────────────────────
    h('TARGET — cnc_rdtofsinfo: how many offsets')
    info = ODBTOFSINFO()
    ret = fw.cnc_rdtofsinfo(handle, ctypes.byref(info))
    print('\n  cnc_rdtofsinfo → %s   ofs_type=%d use_no=%d'
          % (err_name(ret), info.ofs_type, info.use_no))

    # ── cnc_tofs_rnge ────────────────────────────────────────────────────────
    h('TARGET — cnc_tofs_rnge: the valid offset-number range')
    rng = ODBTOFSRNGE()
    ret = fw.cnc_tofs_rnge(handle, 0, ctypes.byref(rng))
    print('\n  cnc_tofs_rnge(type=0) → %s   data=%s'
          % (err_name(ret), [rng.data[i] for i in range(8)]))

    # ── cnc_rdtofs ───────────────────────────────────────────────────────────
    h('TARGET — cnc_rdtofs: one offset value')
    for number, type_ in [(1, 0), (1, 1), (1, 2), (1, 3), (2, 0), (10, 0), (100, 0)]:
        buf = ODBTOFS()
        ret = fw.cnc_rdtofs(handle, number, type_, 8, ctypes.byref(buf))
        print('\n  cnc_rdtofs(number=%d, type=%d) → %s   datano=%d type=%d data=%d'
              % (number, type_, err_name(ret), buf.datano, buf.type, buf.data))

    # ── cnc_rdtofsr ──────────────────────────────────────────────────────────
    h('TARGET — cnc_rdtofsr: a range of offsets')
    for s, e, type_ in [(1, 1, 1), (1, 3, 1), (1, 5, 1), (1, 5, 3), (1, 5, 0)]:
        buf = IODBTO()
        ret = fw.cnc_rdtofsr(handle, s, type_, e, 256, ctypes.byref(buf))
        vals = [buf.u[i] for i in range(8)]
        print('\n  cnc_rdtofsr(s=%d, type=%d, e=%d) → %s   hdr=(%d,%d,%d)  u[0..7]=%s'
              % (s, type_, e, err_name(ret), buf.datano_s, buf.type, buf.datano_e, vals))

    # ── cnc_rdzofs / cnc_rdzofsinfo ──────────────────────────────────────────
    h('TARGET — cnc_rdzofs / cnc_rdzofsinfo: work zero offsets')
    zi = ODBZOFINFO()
    ret = fw.cnc_rdzofsinfo(handle, ctypes.byref(zi))
    print('\n  cnc_rdzofsinfo → %s   ofs_type=%d use_no=%d'
          % (err_name(ret), zi.ofs_type, zi.use_no))
    for number, axis in [(1, 0), (1, 1), (1, -1)]:
        buf = ODBZOF()
        ret = fw.cnc_rdzofs(handle, number, axis, 8, ctypes.byref(buf))
        print('  cnc_rdzofs(number=%d, axis=%d) → %s   datano=%d type=%d data=%d'
              % (number, axis, err_name(ret), buf.datano, buf.type, buf.data))

    h('Closing')
    ret = fw.cnc_freelibhndl(handle)
    print('  cnc_freelibhndl → %s' % err_name(ret))
    time.sleep(0.3)
    proxy.close()


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('This script drives Fwlib64.dll — Windows only.')
    main()
