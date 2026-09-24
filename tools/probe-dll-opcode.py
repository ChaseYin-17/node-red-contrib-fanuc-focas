#!/usr/bin/env python3
"""
tools/probe-dll-opcode.py — capture the opcodes the vendor library puts on the wire.

WHY THIS EXISTS
    A FOCAS opcode is not in the SDK headers: Fwlib64.h declares only the C API
    (`short cnc_rdaxisdata(unsigned short, short, short*, short, short*, ODBAXDT*)`),
    never the 2-byte function number the request frame carries. The only faithful
    source is the vendor library's own traffic — the technique that produced
    cnc_rdsvmeter = 0x56 and cnc_rdspmeter = 0x40 in focas.js (see the commit
    message of 7c76e94, and README.md's note on opcodes).

    This drives Fwlib64.dll through a LOCAL TCP PROXY pointed at the controller,
    hexdumps both directions, and prints the decoded return value.

    cnc_rdsvmeter runs FIRST as a control. Its opcode is already known to be 0x56,
    so the capture must show 0x56 — if it doesn't, the capture is lying about
    something (wrong DLL, unexpected framing) and nothing else it prints is
    trustworthy either.

READ-ONLY
    cnc_sysinfo / cnc_rdsvmeter / cnc_rdaxisdata only read. Nothing here writes
    to the controller.

Usage:
    python tools/probe-dll-opcode.py [ip] [port] [listen_port]
    python tools/probe-dll-opcode.py 192.168.100.128 8193 9100
"""

import ctypes
import os
import socket
import sys
import threading
import time

IP          = sys.argv[1] if len(sys.argv) > 1 else '192.168.100.128'
CNC_PORT    = int(sys.argv[2]) if len(sys.argv) > 2 else 8193
LISTEN_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 9100

DLL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       '..', 'lib', 'FOCAS2 Library', 'Fwlib64')
DLL_DIR = os.path.abspath(DLL_DIR)

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


def color(s, c):
    return s


def hexdump(buf):
    out = []
    for i in range(0, len(buf), 16):
        chunk = buf[i:i + 16]
        hexs = ' '.join('%02x' % b for b in chunk).ljust(47)
        asc = ''.join(chr(b) if 0x20 <= b < 0x7f else '.' for b in chunk)
        out.append('    %04x  %s  |%s|' % (i, hexs, asc))
    return '\n'.join(out)


# ── Local TCP proxy: DLL → here → controller, logging both directions ─────────

_capture_lock = threading.Lock()
_capture = []          # [(direction, bytes)]
_conn_id = 0


def _log(direction, data):
    with _capture_lock:
        _capture.append((direction, data))
    tag = 'DLL→CNC' if direction == '>' else 'CNC→DLL'
    print('\n  ── frame %s  (%d bytes) ──' % (tag, len(data)))
    print(hexdump(data))


def _pump(src, dst, direction):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            _log(direction, data)
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def _serve(client):
    global _conn_id
    _conn_id += 1
    cid = _conn_id
    try:
        upstream = socket.create_connection((IP, CNC_PORT), timeout=10)
    except OSError as e:
        print('  proxy: cannot reach %s:%d — %s' % (IP, CNC_PORT, e))
        client.close()
        return
    print('\n  proxy: connection %d open (%s:%d)' % (cid, IP, CNC_PORT))
    t1 = threading.Thread(target=_pump, args=(client, upstream, '>'), daemon=True)
    t2 = threading.Thread(target=_pump, args=(upstream, client, '<'), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()


def start_proxy():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', LISTEN_PORT))
    srv.listen(8)

    def accept_loop():
        while True:
            try:
                client, _ = srv.accept()
            except OSError:
                return
            threading.Thread(target=_serve, args=(client,), daemon=True).start()

    threading.Thread(target=accept_loop, daemon=True).start()
    return srv


# ── FOCAS structures ──────────────────────────────────────────────────────────

class LOADELM(ctypes.Structure):
    _fields_ = [('data', ctypes.c_long), ('dec', ctypes.c_short),
                ('unit', ctypes.c_short), ('name', ctypes.c_char),
                ('suff1', ctypes.c_char), ('suff2', ctypes.c_char),
                ('reserve', ctypes.c_char)]


class ODBSVLOAD(ctypes.Structure):
    _fields_ = [('svload', LOADELM)]


class ODBAXDT(ctypes.Structure):
    _fields_ = [('name', ctypes.c_char * 4), ('data', ctypes.c_long),
                ('dec', ctypes.c_short), ('unit', ctypes.c_short),
                ('flag', ctypes.c_short), ('reserve', ctypes.c_short)]


def load_dll():
    if not os.path.isdir(DLL_DIR):
        raise SystemExit('DLL directory not found: %s' % DLL_DIR)

    os.add_dll_directory(DLL_DIR)
    # Fwlib64.dll is a dispatcher: it picks the series driver at open time with a
    # bare-name LoadLibrary("fwlib30i64.dll"), and a bare name does NOT search the
    # directories AddDllDirectory registered. Open the session with no driver
    # preloaded and it fails with EW_NODLL (-15). Loading each driver by absolute
    # path first puts the module in the process, so the dispatcher's later lookup
    # by name resolves to the copy that is already there.
    import glob
    for path in sorted(glob.glob(os.path.join(DLL_DIR, 'fwlib*64.dll'))):
        try:
            ctypes.WinDLL(path)
            print('  preloaded %s' % os.path.basename(path))
        except OSError as e:
            print('  (driver %s did not preload: %s)' % (os.path.basename(path), e))

    # Belt and braces: the current directory IS on the default search path.
    os.chdir(DLL_DIR)
    return ctypes.WinDLL(os.path.join(DLL_DIR, 'Fwlib64.dll'))


def bind(fw):
    fw.cnc_allclibhndl3.restype = ctypes.c_short
    fw.cnc_allclibhndl3.argtypes = [ctypes.c_char_p, ctypes.c_ushort,
                                    ctypes.c_short, ctypes.POINTER(ctypes.c_ushort)]
    fw.cnc_freelibhndl.restype = ctypes.c_short
    fw.cnc_freelibhndl.argtypes = [ctypes.c_ushort]
    fw.cnc_rdsvmeter.restype = ctypes.c_short
    fw.cnc_rdsvmeter.argtypes = [ctypes.c_ushort, ctypes.POINTER(ctypes.c_short),
                                 ctypes.POINTER(ODBSVLOAD)]
    fw.cnc_rdaxisdata.restype = ctypes.c_short
    fw.cnc_rdaxisdata.argtypes = [ctypes.c_ushort, ctypes.c_short,
                                  ctypes.POINTER(ctypes.c_short), ctypes.c_short,
                                  ctypes.POINTER(ctypes.c_short),
                                  ctypes.POINTER(ODBAXDT)]


def h(title):
    print('\n' + '=' * 78 + '\n' + title + '\n' + '=' * 78)


# ── Main ──────────────────────────────────────────────────────────────────────

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

    # ── CONTROL: cnc_rdsvmeter. Its opcode is known to be 0x56. ───────────────
    h('CONTROL — cnc_rdsvmeter (opcode known to be 0x56)')
    print('  If the DLL→CNC frame below does not carry 0x56, this capture is')
    print('  unreliable and nothing after it should be believed.\n')
    num = ctypes.c_short(32)
    sv = (ODBSVLOAD * 32)()
    ret = fw.cnc_rdsvmeter(handle, ctypes.byref(num), sv)
    print('\n  cnc_rdsvmeter → %s   data_num=%d' % (err_name(ret), num.value))
    for i in range(min(num.value, 32)):
        lm = sv[i].svload
        nm = lm.name.decode('latin1') + lm.suff1.decode('latin1')
        print('    %-4s data=%-8d dec=%-3d unit=%-3d  →  %s'
              % (nm, lm.data, lm.dec, lm.unit, lm.data / (10 ** lm.dec) if lm.dec else lm.data))

    # ── TARGET: cnc_rdaxisdata, cls=2 (Servo) ────────────────────────────────
    h('TARGET — cnc_rdaxisdata, cls=2 (Servo)')
    for label, types_list in [
        ('type=[0]      servo load meter',        [0]),
        ('type=[1]      load current (% unit)',   [1]),
        ('type=[2]      load current (Ampere)',   [2]),
        ('type=[1,2]    both current forms',      [1, 2]),
        ('type=[0,1,2]  everything servo',        [0, 1, 2]),
    ]:
        print('\n----- %s -----' % label)
        n = len(types_list)
        ctypes_arr = (ctypes.c_short * n)(*types_list)
        length = ctypes.c_short(32)
        buf = (ODBAXDT * (n * 32))()
        ret = fw.cnc_rdaxisdata(handle, 2, ctypes_arr, n, ctypes.byref(length), buf)
        print('  cnc_rdaxisdata(cls=2, num=%d) → %s   *len=%d'
              % (n, err_name(ret), length.value))
        if ret != 0:
            continue
        for t_i, t_val in enumerate(types_list):
            for a in range(min(length.value, 32)):
                d = buf[t_i * 32 + a]
                nm = d.name.split(b'\0')[0].decode('latin1')
                print('    type=%-2d %-4s data=%-10d dec=%-3d unit=%-3d flag=0x%04x'
                      % (t_val, nm, d.data, d.dec, d.unit, d.flag & 0xffff))

    h('Closing')
    ret = fw.cnc_freelibhndl(handle)
    print('  cnc_freelibhndl → %s' % err_name(ret))
    time.sleep(0.3)
    proxy.close()


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('This script drives Fwlib64.dll — Windows only.')
    main()