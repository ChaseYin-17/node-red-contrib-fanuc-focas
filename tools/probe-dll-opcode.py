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
    cnc_sysinfo / cnc_rdsvmeter / cnc_rdaxisdata, the four tool-life reads
    (cnc_rdngrp / cnc_rdtlinfo / cnc_rdusegrpid / cnc_rdgrpinfo4), and the alarm
    reads (cnc_alarm / cnc_alarm2 / pmc_rdalmmsg) only read.
    Nothing here writes to the controller.

--stub, FOR WHEN THERE IS NO CONTROLLER
    The proxy has to forward to a real machine. With --stub it does not: a stub
    controller answers the open handshake and cnc_sysinfo itself and returns an
    empty success for everything else, which is enough for the library to open a
    handle and put its requests on the wire. Use it to pin the REQUEST bytes —
    opcodes and which argument slot carries what — with nothing on the network.
    The replies are synthesised, so every decoded value the library hands back in
    this mode (read_num, axis counts, …) is meaningless and is not printed.

Usage:
    python tools/probe-dll-opcode.py [ip] [port] [listen_port]
    python tools/probe-dll-opcode.py 192.168.100.128 8193 9100
    python tools/probe-dll-opcode.py --stub            # no controller needed

    The SDK is proprietary and stays out of git, so it has moved around: set
    FOCAS_DLL_DIR to the folder holding Fwlib64.dll, or let this find it.
"""

import ctypes
import os
import socket
import struct
import sys
import threading
import time

ARGV        = [a for a in sys.argv[1:] if not a.startswith('--')]
FLAGS       = set(a for a in sys.argv[1:] if a.startswith('--'))
STUB        = '--stub' in FLAGS          # answer the DLL locally, no controller
TIER12      = '--tier12' in FLAGS        # also probe the tier-1/2 read set

IP          = ARGV[0] if len(ARGV) > 0 else '192.168.100.128'
CNC_PORT    = int(ARGV[1]) if len(ARGV) > 1 else 8193
LISTEN_PORT = int(ARGV[2]) if len(ARGV) > 2 else 9100


def find_dll_dir():
    """Locate the folder holding the 64-bit dispatcher and its series drivers.

    The SDK is not in git, so its path is a local arrangement that changes: it has
    lived at lib/FOCAS2 Library/Fwlib64 and now sits under docs/. Take
    FOCAS_DLL_DIR when it is set, otherwise the first known spot that really has
    Fwlib64.dll — a wrong guess here has to say where it looked, not just fail.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    env = os.environ.get('FOCAS_DLL_DIR')
    cands = ([env] if env else []) + [
        os.path.join(here, '..', 'docs', 'FANUC_Focas_API', 'Fwlib64'),
        os.path.join(here, '..', 'lib', 'FOCAS2 Library', 'Fwlib64'),
    ]
    tried = []
    for c in cands:
        c = os.path.abspath(c)
        tried.append(c)
        if os.path.isfile(os.path.join(c, 'Fwlib64.dll')):
            return c, tried
    return None, tried


DLL_DIR, DLL_DIRS_TRIED = find_dll_dir()

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


def describe_request(frame):
    """Decode one DLL→CNC frame into the fields `focas.js` writes by hand.

    A hexdump is what the opcodes were originally read off, but comparing a
    request against `_reqSingle(c1, c2, func, v1..v5)` through hex is needlessly
    painful: same three command words, same five slots, printed as such. Any
    trailing bytes after the five slots are shown too, since a function that
    carries a parameter block after its arguments is a real difference.
    """
    body = frame[10:]
    if len(body) < 2:
        return []
    count = struct.unpack('>H', body[0:2])[0]
    lines, off = [], 2
    for i in range(count):
        if off + 2 > len(body):
            break
        le  = struct.unpack('>H', body[off:off + 2])[0]
        sub = body[off + 2:off + le]
        off += le
        if len(sub) < 6:
            lines.append('      sub[%d] short sub-command (%d bytes): %s'
                         % (i, len(sub), sub.hex(' ')))
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


# ── Stub controller (--stub): answers the DLL with no machine upstream ────────
# Not an emulator. It answers exactly what the library needs to open a handle and
# put a call on the wire — the open handshake (0x0101 → 0x0102) and the cnc_sysinfo
# (0x18) it asks for while opening — and returns a zero-status, empty success for
# every other function. Replies are synthesised, so nothing the library decodes from
# them means anything; the DLL→CNC frames are the whole point. The values below are a
# 31i, matching the machine the tool-life and alarm captures were taken on
# (docs/notes.md).

STUB_SYSINFO = struct.pack('>HH', 0, 32) + b'31' + b' M' + b'G11Z' + b'13.0' + b'03'

# The open response is a 360-byte structure of capability and version words, and the
# library parses it: answer with the 2-byte body this project's client sends in its
# request and cnc_allclibhndl3 comes straight back with EW_PROTOCOL (-17) without
# putting a single call on the wire. There is no way to synthesise it from the SDK,
# so it is replayed verbatim from the capture below — taken 2026-10-12 from the 31i
# at 192.168.100.128, which is the machine the request layouts here were measured on.
# Only bytes 0..55 are non-zero, so the rest is spelled out as a zero run; the total
# must stay 360, or the length it reports is not the one the library accepts.
STUB_OPEN_BODY = bytes.fromhex(
    '00080005000200200008000a00030003'   # capability / version words
    '00030003000100010001000000010000'
    '0000000000000000204d000100000003'   # ... 204d is the ' M' machine type
    '0003000100010001'
) + bytes(360 - 56)


def _stub_frame(ftype, body):
    # The word at offset 4 is 1 in every request the library sends and 3 in every
    # reply a 31i gives — measured on 192.168.100.128, see the capture in
    # docs/notes.md. This project's client ignores it, but the library reads it, so
    # a stub that answers 1 is refused with EW_PROTOCOL (-17) before any request
    # worth capturing is sent.
    return b'\xa0\xa0\xa0\xa0' + struct.pack('>HHH', 3, ftype, len(body)) + body


def _stub_sub(cmd, data=b''):
    # echo(6) | status(6) | length(2) | data — the layout _reqSingle() reads.
    return cmd + b'\x00' * 6 + struct.pack('>H', len(data)) + data


def _stub_answer(body):
    """Reply to a variable request (0x2101), one response per sub-command."""
    if len(body) < 2:
        return None
    count = struct.unpack('>H', body[0:2])[0]
    subs, off = [], 2
    for _ in range(count):
        le = struct.unpack('>H', body[off:off + 2])[0]
        subs.append(body[off + 2:off + le])
        off += le
    out = []
    for sub in subs:
        func = struct.unpack('>H', sub[4:6])[0] if len(sub) >= 6 else -1
        data = STUB_SYSINFO if func == 0x18 else b''
        print('  stub reply: sub func=0x%04x → %s'
              % (func, '18-byte cnc_sysinfo' if func == 0x18 else 'status 0, no data'))
        out.append(_stub_sub(sub[:6], data))
    payload = struct.pack('>H', len(out)) + b''.join(
        struct.pack('>H', len(o) + 2) + o for o in out)
    return _stub_frame(0x2102, payload)


def _serve_stub(client):
    buf = b''
    while True:
        try:
            data = client.recv(65536)
        except OSError as e:
            print('  stub: %s' % e)
            break
        if not data:
            break
        buf += data
        while len(buf) >= 10:
            length = struct.unpack('>H', buf[8:10])[0]
            if len(buf) < 10 + length:
                break
            frame, buf = buf[:10 + length], buf[10 + length:]
            ftype = struct.unpack('>H', frame[6:8])[0]
            _log('>', frame)                       # DLL → CNC, as the proxy logs it
            for line in describe_request(frame):
                print(line)
            if   ftype == 0x0101: reply = _stub_frame(0x0102, STUB_OPEN_BODY)
            elif ftype == 0x0201: reply = _stub_frame(0x0202, b'')
            elif ftype == 0x2101: reply = _stub_answer(frame[10:])
            else:
                print('  stub: no reply for frame type 0x%04x' % ftype)
                reply = None
            if reply is not None:
                print('  stub reply: ftype=0x%04x  %d bytes  body=%s'
                      % (struct.unpack('>H', reply[6:8])[0], len(reply), reply[10:].hex(' ')))
                try:
                    client.sendall(reply)
                except OSError as e:
                    print('  stub: reply failed — %s' % e)
                    return
    client.close()


def _serve(client):
    global _conn_id
    _conn_id += 1
    cid = _conn_id
    if STUB:
        print('\n  stub: connection %d open (no controller — synthesised replies)' % cid)
        _serve_stub(client)
        return
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


class ODBTLIFE2(ctypes.Structure):
    _fields_ = [('dummy', ctypes.c_short * 2), ('data', ctypes.c_long)]


class ODBTLINFO(ctypes.Structure):
    _fields_ = [('max_group', ctypes.c_long), ('max_tool', ctypes.c_long),
                ('max_minute', ctypes.c_long), ('max_cycle', ctypes.c_long)]


class IODBTGI4(ctypes.Structure):
    _fields_ = [('grp_no', ctypes.c_short), ('n_tool', ctypes.c_long),
                ('count_value', ctypes.c_long), ('counter', ctypes.c_long),
                ('count_type', ctypes.c_long), ('opt_grpno', ctypes.c_long),
                ('life_rest', ctypes.c_long)]


class ODBUSEGR(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short), ('type', ctypes.c_short),
                ('next', ctypes.c_long), ('use', ctypes.c_long), ('slct', ctypes.c_long)]


class ODBALM(ctypes.Structure):
    _fields_ = [('dummy', ctypes.c_short * 2), ('data', ctypes.c_short)]


class ODBPMCALM(ctypes.Structure):
    _fields_ = [('almmsg', ctypes.c_char * 128)]


class ODBAXDT(ctypes.Structure):
    _fields_ = [('name', ctypes.c_char * 4), ('data', ctypes.c_long),
                ('dec', ctypes.c_short), ('unit', ctypes.c_short),
                ('flag', ctypes.c_short), ('reserve', ctypes.c_short)]


# ── Structures for the tier-1/2 probe (--tier12) ──────────────────────────────
# Every one of these comes from Fwlib64.h's 30i variant, which is the header that
# matches the DLL in docs/FANUC_Focas_API/Fwlib64. Where a struct is a union or
# carries a MAX_AXIS-sized array, the buffer is declared as raw bytes: this probe
# exists to pin the REQUEST bytes, and a response buffer that is merely large
# enough cannot mislead the capture the way a wrong field layout could.

class ODBSEQ(ctypes.Structure):
    _fields_ = [('dummy', ctypes.c_short * 2), ('data', ctypes.c_long)]


class ODBCMD(ctypes.Structure):
    _fields_ = [('adrs', ctypes.c_char), ('num', ctypes.c_char),
                ('flag', ctypes.c_short), ('cmd_val', ctypes.c_long),
                ('dec_val', ctypes.c_long)]


class OPMSG3(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short), ('type', ctypes.c_short),
                ('char_num', ctypes.c_short), ('data', ctypes.c_char * 256)]


class IODBPMAINTE(ctypes.Structure):
    _fields_ = [('name', ctypes.c_char * 62), ('type', ctypes.c_long),
                ('total', ctypes.c_long), ('remain', ctypes.c_long),
                ('stat', ctypes.c_long)]


class ODBSPN(ctypes.Structure):
    _fields_ = [('datano', ctypes.c_short), ('type', ctypes.c_short),
                ('data', ctypes.c_short * 8)]


class IODBTIMER(ctypes.Structure):
    # short type | short dummy | union { date{year,month,date} | time{hour,minute,second} }
    _fields_ = [('type', ctypes.c_short), ('dummy', ctypes.c_short),
                ('a', ctypes.c_short), ('b', ctypes.c_short), ('c', ctypes.c_short)]


class IODBPMC(ctypes.Structure):
    # short type_a | short type_d | ushort datano_s | ushort datano_e | union[20]
    _fields_ = [('type_a', ctypes.c_short), ('type_d', ctypes.c_short),
                ('datano_s', ctypes.c_ushort), ('datano_e', ctypes.c_ushort),
                ('u', ctypes.c_char * 20)]


# ODBNC is a union of {bin: short,short,long,long = 12} and {asc[31]} -> 32 bytes.
# ALMINFO's MAX_AXIS>16 branch is 5*(4+2+2+32)+4 = 204 bytes.
# IODBZOFS is a REALDATA array; 4 + 2 + 2 + 16*MAX_AXIS is far more than the DLL
# writes, and the probe only reads the request side anyway.
ODBNC_BYTES   = 32
ALMINFO_BYTES = 204
IODBZOFS_BYTES = 4 + 2 + 2 + 16 * 32


def load_dll():
    if DLL_DIR is None:
        raise SystemExit(
            'Fwlib64.dll not found. Looked in:\n  %s\n'
            'Point FOCAS_DLL_DIR at the folder that holds it, e.g.\n'
            '  set FOCAS_DLL_DIR=C:\\path\\to\\Fwlib64'
            % '\n  '.join(DLL_DIRS_TRIED))

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
    for name, argtypes in [
        ('cnc_rdngrp',     [ctypes.c_ushort, ctypes.POINTER(ODBTLIFE2)]),
        ('cnc_rdtlinfo',   [ctypes.c_ushort, ctypes.POINTER(ODBTLINFO)]),
        ('cnc_rdusegrpid', [ctypes.c_ushort, ctypes.POINTER(ODBUSEGR)]),
        ('cnc_rdgrpinfo4', [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                            ctypes.c_short, ctypes.POINTER(ctypes.c_short),
                            ctypes.POINTER(IODBTGI4)]),
        ('cnc_alarm',      [ctypes.c_ushort, ctypes.POINTER(ODBALM)]),
        ('cnc_alarm2',     [ctypes.c_ushort, ctypes.POINTER(ctypes.c_long)]),
        ('pmc_rdalmmsg',   [ctypes.c_ushort, ctypes.c_short,
                            ctypes.POINTER(ctypes.c_short),
                            ctypes.POINTER(ctypes.c_short),
                            ctypes.POINTER(ODBPMCALM)]),
        # ── tier-1/2 probe targets ────────────────────────────────────────────
        # Prototypes are taken from SpecE's <prottype> (the authoritative source —
        # Fwlib64.h's 30i variant omits several of these entirely).
        ('cnc_rdcncid',    [ctypes.c_ushort, ctypes.POINTER(ctypes.c_ulong * 4)]),
        ('cnc_rdzofsinfo', [ctypes.c_ushort, ctypes.POINTER(ctypes.c_short)]),
        ('cnc_rdzofs',     [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                            ctypes.c_short, ctypes.c_void_p]),
        ('cnc_rdseqnum',   [ctypes.c_ushort, ctypes.POINTER(ODBSEQ)]),
        ('cnc_rdcommand',  [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                            ctypes.POINTER(ctypes.c_short), ctypes.POINTER(ODBCMD)]),
        ('cnc_rdopmsg3',   [ctypes.c_ushort, ctypes.c_short,
                            ctypes.POINTER(ctypes.c_short), ctypes.POINTER(OPMSG3)]),
        ('cnc_statinfo2',  [ctypes.c_ushort, ctypes.c_void_p]),
        ('cnc_rdproginfo', [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                            ctypes.c_void_p]),
        ('cnc_rdpm_item',  [ctypes.c_ushort, ctypes.c_short,
                            ctypes.POINTER(ctypes.c_short),
                            ctypes.POINTER(IODBPMAINTE)]),
        ('cnc_rdalminfo',  [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                            ctypes.c_short, ctypes.c_void_p]),
        ('cnc_rdspgear',   [ctypes.c_ushort, ctypes.c_short, ctypes.POINTER(ODBSPN)]),
        ('cnc_rdspload',   [ctypes.c_ushort, ctypes.c_short, ctypes.POINTER(ODBSPN)]),
        ('cnc_rdspmaxrpm', [ctypes.c_ushort, ctypes.c_short, ctypes.POINTER(ODBSPN)]),
        ('cnc_rdblkcount', [ctypes.c_ushort, ctypes.POINTER(ctypes.c_long)]),
        ('cnc_rdexecprog', [ctypes.c_ushort, ctypes.POINTER(ctypes.c_ushort),
                            ctypes.POINTER(ctypes.c_short), ctypes.c_char_p]),
        ('cnc_gettimer',   [ctypes.c_ushort, ctypes.POINTER(IODBTIMER)]),
        ('pmc_rdpmcrng',   [ctypes.c_ushort, ctypes.c_short, ctypes.c_short,
                            ctypes.c_ushort, ctypes.c_ushort, ctypes.c_ushort,
                            ctypes.POINTER(IODBPMC)]),
    ]:
        fn = getattr(fw, name, None)
        if fn is None:
            print('  !! %s not exported' % name)
            continue
        fn.restype = ctypes.c_short
        fn.argtypes = argtypes


def h(title):
    print('\n' + '=' * 78 + '\n' + title + '\n' + '=' * 78)


# ── Tier-1/2 probe: the reads approved for the node, none of which pause sampling
# ─────────────────────────────────────────────────────────────────────────────
# Every function below was checked against its SpecE page before being added here:
# none carries `stop sampling` / `cnc_stopophis` / `stop logging` in its <doc>,
# <option> or <mode> section, so none of them interrupts the CNC's own history
# recording. The functions that DO require cnc_stopophis (cnc_rdalmhistry*,
# cnc_rdophistry*, cnc_rdalmhisno, cnc_rdophisno4, cnc_rdomhis*) are deliberately
# absent — see docs/notes.md.
#
# The argument values are chosen to be IDENTIFIABLE rather than meaningful, so the
# request frame shows which slot carries what:
#   · 258 = 0x0102  — comes back as 00 00 01 02 (one widened long) or 01 02 (two
#                     packed bytes), which is exactly what has to be known.
#   · 3 and 5       — small distinct numbers for the second and third slots.
# A value the library rewrites before sending (a clamped count, a normalised type)
# is itself evidence, so the printed frame is compared against what was asked for.

def tier12_sequence(fw, handle):
    print('\n  Reply values below are the controller\'s own; the DLL→CNC frames are')
    print('  the evidence. A function that answers EW_FUNC/EW_NOOPT still shows its')
    print('  opcode — that is the point of running it here.')

    def call(label, fn, *args):
        h(label)
        try:
            ret = fn(handle, *args)
        except Exception as e:                       # noqa: BLE001 - probe, not a library
            print('\n  %s → raised %s' % (label, e))
            return None
        print('\n  %s → %s' % (label, err_name(ret)))
        return ret

    # ── cnc_rdcncid: the machine's stable identity ────────────────────────────
    cncid = (ctypes.c_ulong * 4)()
    if call('cnc_rdcncid', fw.cnc_rdcncid, ctypes.byref(cncid)) == 0:
        print('    cncid = %s' % ' '.join('%08x' % (v & 0xffffffff) for v in cncid))

    # ── cnc_rdzofsinfo / cnc_rdzofs: work zero offsets ────────────────────────
    # cnc_rdzofs is the one whose argument packing is NOT settled: docs/notes.md
    # records EW_ATTRIB for (number, axis, length) while the vendor library got
    # EW_OK on the same machine. The frame below is what settles it.
    use_no = ctypes.c_short(0)
    if call('cnc_rdzofsinfo', fw.cnc_rdzofsinfo, ctypes.byref(use_no)) == 0:
        print('    use_no = %d' % use_no.value)

    for number, axis in [(1, 1), (1, 2), (2, 1)]:
        buf = ctypes.create_string_buffer(IODBZOFS_BYTES)
        call('cnc_rdzofs(number=%d, axis=%d)' % (number, axis),
             fw.cnc_rdzofs, number, axis, 8, ctypes.byref(buf))

    # ── cnc_rdseqnum: the block being executed ────────────────────────────────
    seq = ODBSEQ()
    if call('cnc_rdseqnum', fw.cnc_rdseqnum, ctypes.byref(seq)) == 0:
        print('    sequence number = %d' % seq.data)

    # ── cnc_rdcommand: modal / commanded F,S,T,B ──────────────────────────────
    # type -1 = all modal data, -2 = all commanded data; block 1 = active block.
    for type_, block in [(-1, 1), (-2, 1), (5, 1), (18, 1), (19, 1)]:
        n = ctypes.c_short(32)
        cmdbuf = (ODBCMD * 32)()
        if call('cnc_rdcommand(type=%d, block=%d)' % (type_, block),
                fw.cnc_rdcommand, type_, block, ctypes.byref(n), cmdbuf) == 0:
            for i in range(min(n.value, 32)):
                c = cmdbuf[i]
                print('    [%d] adrs=%r num=%r flag=0x%04x val=%d dec=%d'
                      % (i, c.adrs, c.num, c.flag & 0xffff, c.cmd_val, c.dec_val))

    # ── cnc_rdopmsg3: the operator's message ──────────────────────────────────
    for type_ in (-1, 0, 4):
        num = ctypes.c_short(1)
        msg = OPMSG3()
        if call('cnc_rdopmsg3(type=%d)' % type_,
                fw.cnc_rdopmsg3, type_, ctypes.byref(num), ctypes.byref(msg)) == 0:
            print('    datano=%d type=%d char_num=%d data=%r'
                  % (msg.datano, msg.type, msg.char_num, msg.data))

    # ── cnc_statinfo2: extended run status ────────────────────────────────────
    st2 = ctypes.create_string_buffer(26)          # ODBST2 = 13 shorts
    if call('cnc_statinfo2', fw.cnc_statinfo2, ctypes.byref(st2)) == 0:
        words = struct.unpack('>13h', st2.raw[:26])
        print('    hdck=%d tmmode=%d aut=%d run=%d motion=%d mstb=%d emergency=%d'
              % words[:7])
        print('    alarm=%d edit=%d warning=%d o3dchk=%d ext_opt=%d restart=%d'
              % words[7:])

    # ── cnc_rdproginfo: program memory ────────────────────────────────────────
    # type 0 = binary (ODBNC.bin), length = sizeof(ODBNC) = 32.
    for type_, length in [(0, ODBNC_BYTES), (1, ODBNC_BYTES)]:
        nc = ctypes.create_string_buffer(ODBNC_BYTES)
        if call('cnc_rdproginfo(type=%d, length=%d)' % (type_, length),
                fw.cnc_rdproginfo, type_, length, ctypes.byref(nc)) == 0:
            if type_ == 0:
                reg, unreg, used, unused = struct.unpack('>hhiI', nc.raw[:12])
                print('    registered=%d available=%d used_mem=%d unused_mem=%d'
                      % (reg, unreg, used, unused))
            else:
                print('    asc=%r' % nc.raw[:31])

    # ── cnc_rdpm_item: maintenance items 1..10 ────────────────────────────────
    n = ctypes.c_short(10)
    items = (IODBPMAINTE * 10)()
    if call('cnc_rdpm_item(start=1, num=10)',
            fw.cnc_rdpm_item, 1, ctypes.byref(n), items) == 0:
        for i in range(min(n.value, 10)):
            it = items[i]
            print('    [%d] name=%r type=%d total=%d remain=%d stat=%d'
                  % (i + 1, it.name, it.type, it.total, it.remain, it.stat))

    # ── cnc_rdalminfo: detailed current alarms ────────────────────────────────
    # type 0 = without message, 1 = with message; alm_type -1 = all types.
    for type_ in (0, 1):
        buf = ctypes.create_string_buffer(ALMINFO_BYTES)
        call('cnc_rdalminfo(type=%d, alm_type=-1)' % type_,
             fw.cnc_rdalminfo, type_, -1, ALMINFO_BYTES, ctypes.byref(buf))

    # ── cnc_rdspgear / cnc_rdspload / cnc_rdspmaxrpm: serial spindle ──────────
    for name in ('cnc_rdspgear', 'cnc_rdspload', 'cnc_rdspmaxrpm'):
        spn = ODBSPN()
        if call(name, getattr(fw, name), -1, ctypes.byref(spn)) == 0:
            print('    datano=%d data=%s' % (spn.datano, list(spn.data)))

    # ── cnc_rdblkcount: block counter (needs Program restarting) ──────────────
    bc = ctypes.c_long(0)
    if call('cnc_rdblkcount', fw.cnc_rdblkcount, ctypes.byref(bc)) == 0:
        print('    block counter = %d' % bc.value)

    # ── cnc_rdexecprog: the block being executed ──────────────────────────────
    # Read twice: if the returned block number advances between two calls made
    # while the machine is idle, this function moves the execution pointer and
    # must NOT be wired into the node. That is the check docs/notes.md asks for.
    #
    # SKIPPED UNDER --stub. The stub answers every unknown function with an empty
    # success, and this one's handler writes `*length` bytes into the caller's
    # buffer from a reply it expects to be non-empty — an empty one makes it fault
    # inside the DLL (access violation, not a Python exception, so it cannot be
    # caught). Its opcode is 0x0020, captured from the frame the DLL put on the
    # wire before the fault; the pointer check itself needs a real controller.
    if STUB:
        h('cnc_rdexecprog — SKIPPED under --stub')
        print('  opcode already captured as 0x0020; the "does it move the execution')
        print('  pointer" check needs a live controller. Re-run without --stub.')
    else:
        for attempt in (1, 2):
            length = ctypes.c_ushort(256)
            blknum = ctypes.c_short(0)
            data = ctypes.create_string_buffer(256)
            if call('cnc_rdexecprog (attempt %d)' % attempt,
                    fw.cnc_rdexecprog, ctypes.byref(length), ctypes.byref(blknum),
                    data) == 0:
                print('    length=%d blknum=%d data=%r'
                      % (length.value, blknum.value, data.value[:length.value]))

    # ── cnc_gettimer: CNC calendar (date and time are separate calls) ─────────
    for type_, label in [(0, 'date'), (1, 'time')]:
        timer = IODBTIMER()
        timer.type = type_
        if call('cnc_gettimer(type=%d, %s)' % (type_, label),
                fw.cnc_gettimer, ctypes.byref(timer)) == 0:
            print('    %s = %d / %d / %d' % (label, timer.a, timer.b, timer.c))

    # ── pmc_rdpmcrng: PMC data window ─────────────────────────────────────────
    # adr_type 9 = D (data table), data_type 2 = word, D100..D103 = 2 words.
    # The length is 8 + N*width, which is the form docs/notes.md records.
    for adr_type, data_type, s, e, length, label in [
        (9, 2, 100, 103, 12, 'D100 word x2'),
        (9, 0, 100, 100, 9,  'D100 byte'),
        (5, 1, 0,   0,   9,  'R0 bit'),
    ]:
        buf = IODBPMC()
        if call('pmc_rdpmcrng(%s: adr=%d type=%d %d..%d len=%d)'
                % (label, adr_type, data_type, s, e, length),
                fw.pmc_rdpmcrng, adr_type, data_type, s, e, length,
                ctypes.byref(buf)) == 0:
            print('    type_a=%d type_d=%d datano_s=%d datano_e=%d u=%s'
                  % (buf.type_a, buf.type_d, buf.datano_s, buf.datano_e,
                     buf.u.hex(' ')))


# ── Stub mode sequence ────────────────────────────────────────────────────────
# Only what is needed to pin request bytes. s_number is picked to be identifiable
# rather than readable: 258 is 0x0102, which comes back either as 00 00 01 02 (one
# widened long, the way focas.js writes every argument) or as 01 02 (two packed
# bytes) — exactly what has to be known before the frame can be reproduced by hand.
# read_num stays small because the library clamps it to what the controller says it
# can answer (11 against this stub, 10 on the machine captured in docs/notes.md), so
# a larger number here would be rewritten before it reached the wire.
def stub_sequence(fw, handle):
    print('\n  Reply values below are synthesised by the stub and carry no meaning;')
    print('  only the DLL→CNC frames are evidence.')

    h('STUB — alarm status (cnc_alarm / cnc_alarm2)')
    for name, call in [
        ('cnc_alarm',  lambda: fw.cnc_alarm(handle, ctypes.byref(ODBALM()))),
        ('cnc_alarm2', lambda: fw.cnc_alarm2(handle, ctypes.byref(ctypes.c_long(0)))),
    ]:
        ret = call()
        print('\n  %s → %s' % (name, err_name(ret)))

    h('STUB — pmc_rdalmmsg: which bytes carry s_number and read_num')
    for s_number, read_num in [(1, 10), (258, 3), (2, 3)]:
        nread = ctypes.c_short(read_num)
        exist = ctypes.c_short(0)
        buf   = (ODBPMCALM * max(read_num, 1))()
        ret = fw.pmc_rdalmmsg(handle, s_number, ctypes.byref(nread),
                              ctypes.byref(exist), buf)
        print('\n  pmc_rdalmmsg(s_number=%d, read_num=%d) → %s'
              % (s_number, read_num, err_name(ret)))

    if TIER12:
        tier12_sequence(fw, handle)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    h('Loading vendor library')
    print('  DLL dir: %s' % DLL_DIR)
    fw = load_dll()
    bind(fw)

    proxy = start_proxy()
    if STUB:
        print('  stub listening on 127.0.0.1:%d  (no controller upstream)' % LISTEN_PORT)
    else:
        print('  proxy listening on 127.0.0.1:%d  →  %s:%d' % (LISTEN_PORT, IP, CNC_PORT))

    if STUB:
        h('Opening a session against the stub')
        handle = ctypes.c_ushort(0)
        ret = fw.cnc_allclibhndl3(b'127.0.0.1', LISTEN_PORT, 20, ctypes.byref(handle))
        print('\n  cnc_allclibhndl3 → %s   handle=%d' % (err_name(ret), handle.value))
        if ret != 0:
            print('\n  The stub could not open a handle. EW_PROTOCOL here means the')
            print('  open response it replayed is not one this library accepts, and')
            print('  no request bytes can be captured this way. Stopping.')
            proxy.close()
            return
        stub_sequence(fw, handle)
        h('Closing')
        ret = fw.cnc_freelibhndl(handle)
        print('  cnc_freelibhndl → %s' % err_name(ret))
        time.sleep(0.3)
        proxy.close()
        return

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

    # ── TARGET: cnc_rdaxisdata, cls=1 (Position) ─────────────────────────────
    # The four position groups the node reports, from the vendor library's own
    # decoder — an independent check on readaxes(), which reaches them through a
    # different call (0x26 with a data selector per group). SpecE/Position/
    # cnc_rdaxisdata.xml: cls=1 types 0/1/2/3 = absolute, machine, relative,
    # distance to go. On a controller with no travel commanded all four read 0, so
    # a zero here is only evidence that the two agree, not that the decoder works.
    h('TARGET — cnc_rdaxisdata, cls=1 (Position)')
    types_list = [0, 1, 2, 3]
    n = len(types_list)
    ctypes_arr = (ctypes.c_short * n)(*types_list)
    length = ctypes.c_short(32)
    buf = (ODBAXDT * (n * 32))()
    ret = fw.cnc_rdaxisdata(handle, 1, ctypes_arr, n, ctypes.byref(length), buf)
    print('\n  cnc_rdaxisdata(cls=1, num=%d) → %s   *len=%d'
          % (n, err_name(ret), length.value))
    if ret == 0:
        for t_i, t_val in enumerate(types_list):
            print('    type=%d (%s):' % (t_val, ['ABS', 'REF', 'REL', 'DIST'][t_i]))
            for a in range(min(length.value, 32)):
                d = buf[t_i * 32 + a]
                nm = d.name.split(b'\0')[0].decode('latin1')
                print('      %-4s data=%-12d dec=%-3d unit=%-3d → %s'
                      % (nm, d.data, d.dec, d.unit,
                         d.data / (10 ** d.dec) if d.dec else d.data))

    # ── TARGET: tool life (needs the CNC's tool-life-management option) ───────
    # Without the option all four answer EW_NOOPT (6). The request frame still
    # shows the opcode — that is what focas.js carries — but the response has no
    # struct to decode. The wire layout is pinned (see docs/notes.md), so run this
    # on a controller WITH the option to compare the DLL's decode against it.
    h('TARGET — tool life (cnc_rdngrp / cnc_rdtlinfo / cnc_rdusegrpid / cnc_rdgrpinfo4)')

    ngrp = ODBTLIFE2()
    ret = fw.cnc_rdngrp(handle, ctypes.byref(ngrp))
    print('\n  cnc_rdngrp → %s   data=%d' % (err_name(ret), ngrp.data))

    info = ODBTLINFO()
    ret = fw.cnc_rdtlinfo(handle, ctypes.byref(info))
    print('  cnc_rdtlinfo → %s   max_group=%d max_tool=%d max_minute=%d max_cycle=%d'
          % (err_name(ret), info.max_group, info.max_tool, info.max_minute, info.max_cycle))

    use = ODBUSEGR()
    ret = fw.cnc_rdusegrpid(handle, ctypes.byref(use))
    print('  cnc_rdusegrpid → %s   next=%d use=%d slct=%d'
          % (err_name(ret), use.next, use.use, use.slct))

    nread = ctypes.c_short(0)
    buf = (IODBTGI4 * 10)()
    ret = fw.cnc_rdgrpinfo4(handle, 1, 0, 10, ctypes.byref(nread), buf)
    print('  cnc_rdgrpinfo4 → %s   num_read=%d' % (err_name(ret), nread.value))
    for i in range(min(nread.value, 10)):
        g = buf[i]
        print('    grp=%-4d n_tool=%-3d life=%-6d counter=%-6d type=%-2d opt=%-3d rest=%d'
              % (g.grp_no, g.n_tool, g.count_value, g.counter,
                 g.count_type, g.opt_grpno, g.life_rest))

    # ── TARGET: alarm status and PMC alarm messages ───────────────────────────
    # cnc_alarm / cnc_alarm2 / pmc_rdalmmsg are exported calls whose function codes are
    # nowhere in the SDK — not in Fwlib64.h, not in SpecE, not as an immediate in the
    # dispatcher — so they come off the capture below, exactly like the load meters and
    # the tool-life reads. This capture is what showed cnc_alarm and cnc_alarm2 to be the
    # same 0x1a request, and pmc_rdalmmsg's command pair to be 2/1 rather than 1/1 (see
    # docs/notes.md). All three only read, so this is safe on a live machine.
    h('TARGET — alarm status (cnc_alarm / cnc_alarm2)')

    alm = ODBALM()
    ret = fw.cnc_alarm(handle, ctypes.byref(alm))
    print('\n  cnc_alarm  → %s   data=0x%04x' % (err_name(ret), alm.data & 0xffff))

    alm2 = ctypes.c_long(0)
    ret = fw.cnc_alarm2(handle, ctypes.byref(alm2))
    print('  cnc_alarm2 → %s   status=0x%08x' % (err_name(ret), alm2.value & 0xffffffff))

    h('TARGET — PMC alarm messages (pmc_rdalmmsg)')
    nread = ctypes.c_short(10)
    exist = ctypes.c_short(0)
    pmcbuf = (ODBPMCALM * 10)()
    ret = fw.pmc_rdalmmsg(handle, 1, ctypes.byref(nread), ctypes.byref(exist), pmcbuf)
    print('\n  pmc_rdalmmsg → %s   read_num=%d exist=%d'
          % (err_name(ret), nread.value, exist.value))
    for i in range(min(nread.value, 10)):
        print('    [%d] %r' % (i, pmcbuf[i].almmsg))

    if TIER12:
        tier12_sequence(fw, handle)

    h('Closing')
    ret = fw.cnc_freelibhndl(handle)
    print('  cnc_freelibhndl → %s' % err_name(ret))
    time.sleep(0.3)
    proxy.close()


if __name__ == '__main__':
    if os.name != 'nt':
        raise SystemExit('This script drives Fwlib64.dll — Windows only.')
    main()