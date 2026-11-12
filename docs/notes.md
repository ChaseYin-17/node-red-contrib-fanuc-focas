# Notes

Working notes that do not belong in the user-facing documentation: limits measured on real
controllers, and changes that were deliberately put off.

These are memos, not specifications. Every number was measured on the machine named next to
it — re-measure before relying on it for a different controller.

---

## Controller session limits

Measured 2026-09-23 against the 31i at `192.168.100.128:8193` (cnc_type `31`, series `G11Z`,
maxaxis 32, 3 servo axes, 1 spindle).

**A controller accepts a limited number of concurrent FOCAS sessions — 5 here.** The 6th is
answered with frame type `0x0103` in place of the usual open response `0x0102`. The frame
type is not documented in the SDK, so the node reports it as it is:

```
Open refused by controller — every FOCAS session is in use
  (ftype 0x0103, bytes=18, head=a0 a0 a0 a0 00 03 01 03 00 08 00 00 00 02 00 00)
```

**Below that sits a TCP-level limit.** Past roughly 30 simultaneous connects the board stops
answering `0x0103` at all and the connection itself is refused (`ECONNREFUSED` on the local
side). That one is outside the FOCAS protocol and nothing at this layer can work around it.

Both are transient — a single poll fired immediately after a 50-connect storm succeeds.

Fan-out: N nodes pointing at **one** controller, all triggered at once, `All Data`:

| nodes | result |
|-------|--------|
| 4 / 6 / 10 | all succeed |
| 20 | 15 ok — 5 refused (`0x0103`) |
| 30 | 25 ok — 4 `ECONNREFUSED`, 1 refused |
| 50 | 25 ok — 23 `ECONNREFUSED`, 2 refused |

Client-side cost with **one node per device** (measured against a local stub that answers the
open/close handshake and every variable request but caps nothing, so the controller's own
limits stay out of the way):

| nodes | result |
|-------|--------|
| 50 | 50/50 in 0.17s |
| 100 | 100/100 in 0.29s |
| 200 | 200/200 in 0.51s |

Roughly linear, nothing refused — the Node side is not the constraint, the controller is.
Wall-clock for a real fan-out is the slowest device rather than the sum, because each node
polls its own device in parallel.

To isolate the client side again, run a stub FOCAS answerer on localhost and point N nodes at
it. `tools/verify-node-sessions.js` probes the real limit and guards the refusal path.

---

## Deferred: one poll queue per device

The poll queue added with the session fix lives in `FanucFocasNode`, so it serialises a
**node's** own polls. It is not per device: two nodes pointed at the same controller still
open two sessions at once and can collide.

Left as it is because the deployment is one node per device, where each controller only ever
sees one session at a time and the limit above is never approached.

**Pick this up when** a second node is pointed at a controller that already has one, or when
`Open refused` / `ECONNREFUSED` shows up in a flow that was working.

**The change:** move the queue into `FanucConfigNode` so every node sharing a device takes
its turn on one session. It is a no-op for the one-node-per-device topology, so it can be
done defensively at any time.

---

## Deferred: bounded queue

The queue is unbounded (`queue = queue.then(...)`). A device whose poll outlasts the inject
interval accumulates messages without limit — memory, plus latency that keeps growing.

It only bites when a device is sick (a hung poll costs the full 5s timeout) or the inject is
faster than a poll (~130ms for `All Data` on the machine above). Queues are per node, so one
sick device cannot slow the others down.

**The change:** bound the queue and drop stale messages, or coalesce duplicates so only the
newest pending request survives.

---

## Axis load current: cnc_rdaxisdata has no opcode of its own

Measured 2026-09-24 against the same 31i at `192.168.100.128:8193` (cnc_type `31`,
series `G11Z`, maxaxis 32, 3 servo axes, 1 spindle).

The 64-bit `Fwlib64.dll` is a dispatcher. `cnc_rdaxisdata(cls=2)` — the call that reaches
the servo load meter and the **load current in Ampere** — does not put a new function code
on the wire. It decomposes into calls the node already makes:

| `cnc_rdaxisdata` cls=2, `type` | wire |
|---|---|
| `0` load meter | `0x56` arg `1` |
| `1` load current (%) | `0x56` arg `1` |
| `2` load current (Ampere) | `0x56` arg `3` |
| `1,2` | `0x56[1]` + `0x56[3]` |
| `0,1,2` | `0x56[1]` + `0x56[1]` + `0x56[3]` |

Around those it sends `0xa4` (axis count) for the length and `0x89` (axis names) for the
names; the unit/dec the SDK reports are read off the wire, not filled in from a table.

**So Ampere is reachable with no new opcode** — `0x56` with `3` in place of the `1`
`readsvmeter()` sends today. The unit sits in the record itself:

| `0x56` arg | `dec` at +6 | unit |
|---|---|---|
| `1` | `0` | % |
| `3` | `2` | Ampere (value / 100) |
| `0`, `2` | `0x0281` | accepted, but the block does not decode as load records — do not use |
| `>= 4` | — | `EW_ATTRIB` |

All values read `0` on the 3-axis mill: the machine was idle. The `dec` is taken from the
wire record and the Ampere identity is corroborated by the SDK's own unit enum (9), but a
single idle sample cannot separate "amperes" from "the same percentage carried at a finer
decimal" — both fit the same numbers.

Re-measured 2026-09-24 on the **5-axis lathe at `10.192.232.161:8193`** (axes `X1 Z1 C1 Y1
T1`), under load. Two polls 1.1 s apart:

| axis | `0x56[1]` % | `0x56[3]` A | A / % |
|------|-------------|-------------|-------|
| X1 | 70 | 18.00 | 0.257 |
| Z1 | 4 | 1.22 | 0.305 |
| C1 | 0 | 0 | — |
| Y1 | 50 | 13.17 | 0.263 |
| T1 | 0 | 0 | — |

Two things follow. The readings are **not the same quantity** — 70 against 18 kills the
finer-decimal reading of `0x56[3]`, which would have put 70.00 there. And they are
**proportional through the origin**: X1 and Y1 agree to 2%, Z1 sits inside its own
quantisation (4% carries ±0.5, so 0.27–0.35), giving **100% of the load meter ≈ 26 A** on
these axes. A pair taken seven minutes earlier read 17.98 / 1.19 / 13.23 A, so the scale is
stable across time, not noise.

That is the shape a real current reading has. What it cannot show is whether 26 A is the
axes' *rated* current or a peak/stall reference — the normalising base is a motor and
parameter property that these samples do not reveal. **Check the implied 26 A against the
servo motor nameplate to close the absolute scale.**

**Capturing this again:** `tools/probe-dll-opcode.py` drives the vendor DLL through a local
TCP proxy and hexdumps both directions. `cnc_rdsvmeter` runs first as a control — its
opcode is already known to be `0x56`, so a capture that does not show `0x56` is lying about
something and the rest of its output is worthless. The DLL answers `EW_NODLL (-15)` unless
the series drivers (`fwlib30i64.dll`, …) are preloaded by absolute path — the dispatcher
looks them up by bare name, and a bare name does not search `AddDllDirectory` paths.

`tools/probe-funcsupport.js` carries the `0x56` arg `1`/`3` rows, so the controller answers
both without needing the vendor DLL.

---

## Tool life: opcodes and wire layout

Opcodes measured 2026-09-28 against the 31i at `192.168.100.128:8193` (cnc_type `31`,
series `G11Z`); the response layout was pinned the next day on the 31i at
`10.192.233.33:8193` (series `G103`), which has the tool-life option enabled.

Four calls make up tool-life management. None of their function codes are in the SDK
headers, so they were read off the vendor library's own traffic with
`tools/probe-dll-opcode.py`, the same way the load meters were:

| call | wire func | request args |
|---|---|---|
| `cnc_rdusegrpid` | `0x48` | — |
| `cnc_rdngrp`     | `0x4a` | — |
| `cnc_rdgrpinfo4` | `0x1c1` | `grp_no`, `direction`, `num_to_read` |
| `cnc_rdtlinfo`   | `0x1c4` | — |

Re-issued over raw TCP from `focas.js`, the **controller answers all four with
`EW_NOOPT (6)`** — the request frames are right, but this machine does not have the
*刀具寿命管理* (tool life management) option enabled, so there is no success payload to
decode. `cnc_rdgrpinfo4`'s arguments were read straight off the wire (`grp_no=1`,
`direction=0`, `num_to_read=0x0a`), so the request side is settled.

**The response layout is not the SDK struct.** Seen on a controller with the option on, the
wire widens every field to a 4-byte long:

| call | wire |
|---|---|
| `cnc_rdngrp` | `long group_count` at **+0** — the C struct's `dummy[2]` offset (+4) is where `max_group` actually lands |
| `cnc_rdtlinfo` | one leading long, then `max_group`, `max_tool`, `max_minute`, `max_cycle` at **+4/+8/+12/+16** |
| `cnc_rdgrpinfo4` | 7 × long per record — `grp_no`, `n_tool`, `life`, `counter`, `count_type`, `opt_grpno`, `life_rest` (the C `short grp_no` + 2-byte pad become one long) |
| `cnc_rdusegrpid` | 12 bytes: `[next][use][slct]` — `datano`/`type` are documented "not used" and are not sent |

`cnc_rdngrp` and `cnc_rdtlinfo` return the **same 20-byte block** — the group count sits in
front of the limits, which is why the two calls appeared to disagree:

```
00 00 00 1e  00 00 00 80  00 00 00 08  00 00 ea 60  05 f5 e0 ff
     30           128           8          60000       99999999
```

The mistake this replaced: `focas.js` read the C-struct offsets, so it reported
`group_count = 128` and `max_group = 30` — two adjacent longs swapped by the missing leading
field — and decoded every group number as `0`, a `short` read of a `long` `grp_no`. That is
why `most_used_group` came back as `0` instead of `13`: all 30 groups had collapsed onto
group number `0`. Separately, `cnc_rdusegrpid`'s 12-byte reply tripped `readusegrpid`'s
16-byte assumption; `fnToolLife`'s non-fatal `try/catch` swallowed the throw, so
`using_group`/`next_group`/`selected_group` were silently `null` rather than erroring.

**`life_rest` vs `life − counter`.** `makeToolGroup` prefers `life_rest` when it is `> 0` and
otherwise falls back to `life − counter`, matching `FanucCnc.ToolLifeCore`. FanucBlazor's
README says the opposite ("compute `life − counter`, do not trust `life_rest`") — the C# code
is the one that counts; the prose is stale. The two behave identically on any controller
without tool-life management B, where `life_rest` is always 0.

**A large `num_to_read` is refused, not clamped.** Measured on the same controller:
`cnc_rdgrpinfo4` is answered normally up to `num_to_read = 103`; from `104` up the reply is
frame type `0x2103` (not the usual `0x2102`) carrying `EW_PROTOCOL (-17)`. `_reqSingle`
surfaces that as `unexpected reply frame 0x2103` with the head bytes, rather than reporting
it as a malformed frame. The vendor DLL never hits this — it quietly lowers
the request to `51`. The ceiling is undocumented and there is no call that reports it, so
`focas.js` reads groups in pages of `TOOL_GROUP_PAGE` (64) and advances `grp_no`, rather
than asking for one large block.

**Capturing this again:** `python tools/probe-dll-opcode.py <ip> 8193` decodes the four
calls through the vendor DLL and hexdumps both directions; `node tools/probe-toollife.js
<ip>` dumps the raw payloads the node itself sees, with an int32/int16 view of every
offset. `node tools/verify-node-toollife.js <ip>` checks the decoded model end to end. On a
controller without the option the verify script reports `EW_NOOPT` instead of failing, so
the decode path is simply not exercised there.

`node tools/verify-node-toollife-offline.js` needs no controller at all — it stubs the
socket and drives the real node code, covering the wire offsets, the per-group model, the
paging loop's four stop conditions and the three `reqErr` failure shapes. Run it on any
change to the decoders or the page loop.

---

## Alarm status and PMC alarms: opcodes

Captured 2026-10-12 with `tools/probe-dll-opcode.py` on two controllers, which agreed
byte-for-byte on every request below:

| | machine |
|---|---|
| 1 | the 31i at `10.192.233.95:8193` — cnc_type `31`, maxaxis 32, 5 axes (`X1 Z1 C1 Y1 T1`) |
| 2 | the 31i at `192.168.100.128:8193` — cnc_type `31`, series `G11Z`, maxaxis 32, 3 axes (`X Y Z`) |

`cnc_rdsvmeter` ran first on both as the control and its `0x56` was present, so the
captures are sound. A sound capture is not the same as a sound transcription, though: one
row of the table was written down with its command pair reversed. See the `pmc_rdalmmsg`
note below.

| call | wire func | c1/c2 | request args |
|---|---|---|---|
| `cnc_alarm`   | `0x1a`   | 1 / 1 | — |
| `cnc_alarm2`  | `0x1a`   | 1 / 1 | — (byte-identical frame to `cnc_alarm`) |
| `pmc_rdalmmsg`| `0x8010` | 2 / 1 | `s_number`, `read_num` |

**`pmc_rdalmmsg` is 2 / 1, and this table said 1 / 2 until 2026-10-12.** The two words of
that request were read off the hexdump in the wrong order, and the transposition went into
`focas.js` as `PMC_RDALMMSG_C2 = 2` with `c1` left at 1. It is not a benign difference and it
is not an "unknown function" answer either: the controller takes the second word of the pair
as a path/unit selector, so the transposed request is answered **`EW_PATH` (11)** — a *path*
error for a function that has no path argument — on every poll, while the correct one is
answered normally.

What closed it was putting both requests on the same controller and diffing them, the 31i at
`192.168.100.128` (2026-10-12): the vendor library's `pmc_rdalmmsg` came off the proxy as
`... 00 02 00 01 80 10 | 00 00 00 01 00 00 00 0a ...` and this project's as
`... 00 01 00 02 80 10 | 00 00 00 01 00 00 00 0a ...` — the arguments and the opcode byte for
byte identical, only the command pair swapped. With the pair corrected, `readpmcalarm()` on
that machine answers `{read_num: 0, exist: -1}` (EW_OK, no PMC alarm pending), matching the
library's own result. All other requests in the table are 1 / 1 and were unaffected.

`tools/probe-dll-opcode.py --stub` now prints every request as `c1=2 c2=1 func=0x8010
args=1 10 0 0 0` rather than as hex, which is the form that would have caught this on the
day. It runs against a stub controller (no machine needed) and reuses the open-response body
recorded below.

**The open handshake is not as thin as this project's client assumes.** `cnc_allclibhndl3`
sends `a0 a0 a0 a0 | 0001 | 0101 | 0002 | 0001` and a controller answers with a **360-byte**
structure of capability and version words (`ftype 0x0102`, and `0003` where the request had
`0001` in the word at offset 4). `focas.js` reads the frame type and discards the body, which
is fine for a client, but the vendor library parses it: replay a short body and
`cnc_allclibhndl3` returns `EW_PROTOCOL` (-17) without sending a single call. That body is
what makes `--stub` work, which is why it is kept verbatim in the tool. The word at offset 4
is 1 in every request the library makes and 3 in every reply this machine gives.

**`cnc_alarm2` is not a second opcode.** The library puts a byte-for-byte identical
request on the wire for both APIs; the only difference is the width the caller asked for
(`ODBALM.data` is a `short`, `cnc_alarm2` writes a `long`). `focas.js` sends `0x1a` for
both and masks — 16 bits for `readalarmstatus()`, 32 for `readalarmstatus2()`. The mask
matters: on a word carrying only an upper-half alarm, `cnc_alarm` reports nothing at all,
which is why the 30i family needs the second call.

**`0x22` is not `cnc_alarm`.** `tools/probe-funcsupport.js` and `tools/probe-alarms.js`
labelled it that way and the label was never verified — nothing in this project had put
`0x22` on the wire as an alarm read. It was corrected to `0x1a` in both. `0x22` belongs to
some other function; which one is unknown.

**Response layouts.** `cnc_alarm` answers with a 4-byte data block — `ODBALM`'s
`short dummy[2]` is dropped and `data` widened to a long, the same treatment `ODBALMMSG`
gets. The 4 bytes are confirmed on both controllers; the second one answered `0x0001`
(bit #00, *Parameter switch on*, on the 30i bit table), so the decode is exercised on a
non-zero word rather than only on zeroes. `pmc_rdalmmsg` answers with an 8-byte header,
two longs: `read_num` (records that follow) then `exist` (`-1` none, `0` all read, `1`
more — `PMC_ALARM_NO`/`_ALL_READ`/`_STILL`).

The PMC record **width is still unmeasured.** Every controller this has run against had no
PMC alarm pending (`read_num=0`, `exist=-1`) — the two captured above and, after the c1/c2
fix, `192.168.100.128` again, where `readpmcalarm()` now answers the same `{read_num: 0,
exist: -1}` the library does. Nothing has been seen after the 8-byte header, so
`readpmcalarm()` slices records out of `(payload − 8) / read_num` rather than assuming
`ODBPMCALM`'s 128 bytes. Re-run the capture on a controller with a PMC alarm up to close
that.

---

## Audit against the SDK spec, 2026-11-12

Measured on the 31i at **`10.192.233.166:8193`** — `cnc_type` `31`, series `G40A`,
version `37.0`, `max_axis` 32, **`axes` `"05"`** (5 servo axes `X Y Z B X2`, 1 spindle `S1`).
Every request in this section is a read; nothing was written, reset or cleared.

The tools that produced it are `tools/probe-readonly-audit.js` (every call the node makes,
with raw bytes), `tools/probe-param-types.js` (the `cnc_rdparam3` attribute codes),
`tools/probe-position-compare.js` (`readaxes()` against the vendor library's opcodes),
`tools/probe-progdir-layout.js` (the 72-byte record) and `tools/probe-dll-param.py` (the
argument order for param/macro/progdir/names, captured from the vendor DLL through the
proxy, like `probe-dll-opcode.py`).

### `cnc_rdparam3` — the wire is not the C struct, and the type enum is not the C enum

The vendor library's own request for `cnc_rdparam3(number, axis, length, absolute)` is
`0x8d args=<number> <number> <axis> 0 0` — the **second argument repeats the parameter
number**, and the axis travels in the third slot. That is why `focas.js`'s
`_reqSingle(1, 1, 0x8d, first, last, axis)` works: `first`/`last` are the same number for a
single-parameter read. Sending the documented C order (`number, axis, length, absolute`)
instead is answered `EW_NUMBER (3)`.

The response block is **8 bytes per axis**, not 4:

```
datano(i32) | type(i16) | attr(i16) | record[MAX_AXIS] of 8 bytes
                                        value(i32) | dec(i32)
```

`type` is `0xffff` on this controller for every parameter, so it carries nothing. The
**attribute is the word at +6**, and its enum is *not* the `IODBPSD.type` enum the spec
documents (`0 bit / 1 byte / 2 word / 3 2-word / 4 real`). Measured by sweeping parameter
numbers:

| attr at +6 | parameters seen | meaning |
|---|---|---|
| 0 | 1000, 1001, 1002, 1004, 1300, 1800, 5000, 5001, 6000, 6700, 9000, 10000, 13000, 18000 | byte / word / 2-word — the value is the i32 at +0 either way |
| 1 | 1020, 1022, 1023, 1024, 1025, 1026 | **bit** — the value is the byte at +3 (1020 reads `88 89 90 42 88` = `X Y Z B X2`) |
| 2 | 1825 | word with axis (6000 = the servo loop gain) |
| 3 | 1850, 6711, 6750 | 2-word with axis (6711 = 23101 parts, 6750 = 3044565 ms) |
| 4 | 1700, 10000 | **real** — `value(i32)` then `dec(i32)`; 5001 read `64` with dec 0 |

So the old decoder had three faults at once: it read 4-byte records out of an 8-byte
stride, it took the attribute from `type` at +4 (always `0xffff` here) instead of +6, and it
had the bit/byte meanings of 0 and 1 swapped relative to the documented enum — which is
also not the enum this controller uses.

**6711 and 6750 are 2-word parameters, not real ones.** The old code's `valtype === 3`
branch read the i32 at +0 and got the right number by luck; the `valtype === 4` branch was
never reached, so a real parameter returned `undefined`.

### `cnc_rdmacro` — the second argument is an END number, and `(n, n)` is the single read

`0x15 args=<number> <end_number>`. The vendor library sends `args=100 100` for
`cnc_rdmacro(100, 10)` — it rewrites the second argument to the end of the range it wants,
which for a single variable is the variable number itself. The raw wire agrees:

| args | result |
|---|---|
| `(1, 1)` | 8 bytes — one record |
| `(1, 2)` | 16 bytes — two records |
| `(1, 10)` | 80 bytes — ten records |
| `(100, 100)` | 8 bytes — one record, `mcr_val=120000000 dec=5` |
| `(100, 101)` | 16 bytes — two records |
| `(100, 10)` | **`len = -1`** — malformed frame |
| `(500, 1)` | **`len = -1`** — malformed frame |

So the second argument is an end number and must be ≥ the first. `focas.js`'s
`readmacro(first, last)` already sent `(first, last)` with `last = first` for a single
read, which is the correct form — the earlier `decode8()` on the record was the real bug:
the record is `mcr_val(i32) | dec_val(i16) | 2 bytes`, not the 8-byte
`value/format/dec` shape the feedrate decoder expects, so every macro read came back
`null`. `dec_val = -1` is the spec's "vacant" marker and is now reported as `null`.

### `cnc_rdprogdir` — 72-byte records, and the arguments are not the C order

`0x06 args=<start> <count> <format>`. The node's `(start, 0x13, 2)` asks for 19 records in
format 2 and gets `19 × 72 = 1368` bytes; `(1, 3, 2)` gets 216. The record is:

```
number(i32) | length(i32) | comment[64]
```

`(1, 3, 2)` decoded: `903 / 28000 / "(19237-0903_REVC_150670003)"`,
`8000 / 500 / "(RENISHAW VECTOR CAL)"`, `8001 / 1500 / "()"`. So the node's 72-byte stride
and `number`/`length`/`comment` offsets are **correct** — the layout was right even though
it is not `PRGDIR`'s ASCII text form. The C order `(type, datano_s, datano_e, length)` is
answered `EW_ATTRIB (4)`.

### `cnc_rdaxisname` / `cnc_rdspdlname` — 4-byte records, and `data_num` is sent as 0

`0x89 args=<data_num>` returns `data_num × 4` bytes; `0x8a` likewise. The record is
`name` + `suff` + 2 bytes of padding (`58 00 6e 10` = `"X"`), so the node's 4-byte stride
is right.

**`data_num` is sent as 0, and that is what works.** The vendor library puts
`0x89 args=0 0 0 0 0` on the wire for both calls, and the raw wire agrees: `0x89[0]`
returns all five names, while `0x89[5]` on this 5-axis machine is **`EW_ATTRIB (4)`**.
The spec says 0 or less is `EW_LENGTH`, and the library's own `cnc_rdaxisname(0)` does
return `EW_LENGTH` — but the wire form the library actually sends is 0, and that is the
form the controller answers. The count only bounds how many records are kept.

### `cnc_rdusegrpid` / `cnc_rdngrp` / `cnc_rdtlinfo` — the measured layouts hold

`0x48` → 12 bytes `00 00 00 00 | 00 00 00 02 | 00 00 00 02` (next 0, use 2, slct 2).
`0x4a` and `0x1c4` → the same 20 bytes `14 | 100 | 4 | 100000 | 99999999`, i.e. group count
20, max_group 100, max_tool 4, max_minute 100000, max_cycle 99999999. `0x1c1` → 10 records
of 28 bytes. All three match `docs/notes.md`'s earlier measurement, so the "wire drops the
C `dummy`" reading is confirmed on a second machine.

### `cnc_rdalmmsg` — no alarm was pending, so the record layout is still open

`0x23` answered `len = 0` for every argument form tried — `(type, num)`, `(type, num, 1,
32)`, `(type, num, 1, 64)`, `(type, num, 1, 44)` — because this controller has no active
alarm. **The 16-byte-header record layout is still unmeasured**, and so is whether the
fourth argument widens the text field. The spec says `cnc_rdalmmsg` is capped at 32
characters and that `cnc_rdalmmsg2` is the 64-character call for the 30i family, so the
node now sends the documented 32 and validates the stride instead of assuming 64 works.

### `cnc_rddynamic2` / positions — the node's selectors are not the library's

`0x26` accepts every selector 0..9 and returns 32 × 8-byte records for each, so the
selector is a *data kind*, not a position type. The vendor library reaches the four
position types with `0x88[1]`, `0x88[2]`, `0xa3[0,-1]` and `0x26[0,-1]`; `0x88` and `0xa3`
answer 128-byte blocks that do not decode as 8-byte records at all, while `0x26[0,-1]`
returns the same shape the node already decodes.

Back to back on this machine, `readaxes()` and the library disagree on which selector is
which position:

| | node `readaxes()` | library `cnc_rdaxisdata(cls=1)` |
|---|---|---|
| absolute | `0x26[4]` → `18.938, 32.945, -2, 0, -308.381` | `0x26[0]` → `19.796, 32.312, -2, 0, -307.522` |
| machine | `0x26[1]` → `-308.185, -275.171, -496.769, 0, -308.207` | `0x88[1]` |
| relative | `0x26[6]` → `-308.007, 4.31, -496.565, 0.002, -308.032` | `0x88[2]` |
| distance | `0x26[7]` → `8.069, -15.866, 0, 0, 0` | `0xa3[0,-1]` |

The absolute values agree to within the machine moving between the two reads, so
`0x26[4]` and `0x26[0]` are the same quantity. The other three cannot be checked the same
way because the library's opcodes for them do not decode here. **Left as it is** — the
node's four selectors return four distinct, plausible position sets, and changing them
without a way to verify the replacement would be the guess this project forbids. The
`0x88`/`0xa3` mapping is recorded above for whoever picks it up with a machine that can be
moved deliberately.

### `cnc_actf` / `cnc_acts` — 8 bytes, `dec` at +6

`0x24` → `00 00 00 c8 00 0a 00 00` = 200 with dec 0; `0x25` → `00 00 09 c4 00 0a 00 00` =
2500 with dec 0. The 8-byte `value(i32) + format(i16) + dec(i16)` shape `decode8()` assumes
is confirmed, and `dec` is at +6 as the code says.

### `cnc_rdsvmeter` / `cnc_rdspmeter` — signed values, `dec` at +6

`0x56[1]` → 32 records, first five `-12, 33, -10, 0, -24` at dec 0. `0x56[3]` → the same
axes at dec 2 (`-1.47, 8.69, -2.79, 0, -2.95` A). `0x40[0,-1]` → 4 records of 16 bytes,
first `127` at dec 0. **The readings are signed** — a regenerating axis reads negative —
which is why `readsvmeter()` takes the magnitude and `readspmeter()` did not. Both are
magnitudes now.

### `cnc_statinfo` — 14 bytes, and `axes` is not `max_axis`

`0x19` → `00 01 00 03 00 01 00 00 00 00 00 00 00 00` = `aut 1 (MEMory)`, `run 3 (STaRt)`,
`motion 1`, `mstb 0`, `emergency 0`, `alarm 0`, `edit 0`. The 14-byte block and the
`aut`-first offset are confirmed.

`cnc_sysinfo` on this machine reports `max_axis = 32` and `axes = "05"`. The node's
`fnSystemInfo()` reported `axes: si.maxaxis`, i.e. **32 for a 5-axis machine**.

