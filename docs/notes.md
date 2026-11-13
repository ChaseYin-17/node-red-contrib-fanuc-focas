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

---

## Tool offsets: the opcodes this project would have guessed are all wrong

Measured 2026-11-13 on the same 31i at `10.192.233.166:8193` (`cnc_type` `31`, `mt_type`
` M`, series `G40A`). **The node implements no tool-offset function at all** — this section
exists so the next person does not start from the numbers that look obvious.

The SDK documents `cnc_rdtofs` / `cnc_rdtofsr` / `cnc_rdtofsinfo` / `cnc_rdzofs` /
`cnc_rdzofsinfo` but, as everywhere else here, **not their function codes**. Probing the
codes that look adjacent to the other `Ncdata` reads (`0x2c`, `0x2d`, `0x2e`, `0x2a`,
`0x2b`) gets answers — and every one of them is a *different function*:

| call | guessed | what the guess actually did |
|---|---|---|
| `cnc_rdtofs`   | `0x2c` | answered 12 bytes, **identical for every offset number and type** |
| `cnc_rdtofsr`  | `0x2d` | answered 8 bytes, identical for every range |
| `cnc_rdtofsinfo` | `0x2e` | `EW_NUMBER (3)` |
| `cnc_rdzofs`   | `0x2a` | `EW_FUNC (1)` |
| `cnc_rdzofsinfo` | `0x2b` | `EW_LENGTH (2)` |

An answer that never changes with its arguments is the signature of a wrong opcode: the
controller is answering some other function and nothing in the reply says so. Captured
from the vendor library with `tools/probe-dll-tofs.py` (same proxy technique as
`probe-dll-opcode.py`), the real codes are:

| call | wire func | c1/c2 | request args |
|---|---|---|---|
| `cnc_rdtofs`     | **`0x08`** | 1 / 1 | `number`, `type`, `length` |
| `cnc_rdtofsr`    | **`0x08`** | 1 / 1 | `s_number`, `e_number`, `type` |
| `cnc_rdtofsinfo` | **`0x0a`** | 1 / 1 | — |
| `cnc_rdzofs`     | **`0x0b`** | 1 / 1 | `number`, `axis`, `length` |
| `cnc_rdzofsinfo` | **`0x0d`** | 1 / 1 | — |
| `cnc_tofs_rnge`  | **`0xc8`** | 1 / 1 | `type`, `0`, `0x3638` |

`cnc_rdtofs` and `cnc_rdtofsr` are **the same opcode** `0x08`, told apart by the argument
pattern: `(number, type, length)` reads one value, `(s_number, e_number, type)` reads a
range. The library sends `args=1 1 1002 0 0` for `cnc_rdtofs(1, type=2)` — the third word
is `1000 + type`, not a length — and `args=1 5 1 0 0` for `cnc_rdtofsr(1, type=1, 5)`.

### Response layouts

Every one of these answers a plain run of **8-byte records** — `value(i32) | dec(i16) |
unit(i16)` — with **no header**. That is the same record shape `cnc_rdparam3` and
`cnc_rdsvmeter` use, and it is not the C struct in any of the three cases.

`cnc_rdtofs` answers one record (8 bytes):

```
value(i32) | dec(i16) | unit(i16)
```

Measured `number=1 type=2` → `00 00 00 50 | 00 0a | 00 03` = 80 at dec 0, unit 3.

`cnc_rdtofsr` answers `8·N` bytes, one record per offset in the range, **no header**:

```
record[N] of value(i32) | dec(i16) | unit(i16)
```

Measured `s=1 type=0 e=5` → five records `129907, 136379, 97846, 125361, 99581`, all at
dec 3 → 129.907, 136.379, 97.846, 125.361, 99.581 mm. Those are tool-length compensation
values, which is what type 0 means on this M-series machine.

> The first attempt at decoding these assumed a `datano_s | type | datano_e` header
> because `IODBTO` has one. It does not: the wire drops it, exactly as it drops
> `ODBALM`'s `dummy[2]` and `ODBUSEGR`'s `datano`/`type`. Reading a header out of the
> first record turns the first offset value into a "datano" and shifts every value after
> it — the numbers still look plausible, which is why this has to be checked against a
> known-good value rather than eyeballed.

`cnc_rdtofsinfo` answers 8 bytes: `ofs_type(i32) | use_no(i32)` — measured `00 00 00 63 |
00 02 00 00` = `ofs_type 99`, `use_no 131072`. The second word does **not** read as a
small count, so it is not `use_no` in the C sense; treat only `ofs_type` as trustworthy
until a machine with a different table size is measured.

`cnc_rdzofsinfo` answers 4 bytes: `ofs_type(i32)` = 307.

`cnc_rdzofs` answered `EW_ATTRIB (4)` for every axis tried (1, 2, 3) and `EW_NUMBER (3)`
for `number=2`, so its layout is **not measured** — the vendor library got `EW_OK` with
`axis=1` on the same machine minutes earlier, which means the argument packing differs
from `(number, axis, length)`. Do not implement it from this note.

### Offset type numbers (from the spec, not measured)

`cnc_rdtofs.xml` gives the `type` enum per series. On this M-series machine the four that
answered were 0/1 (cutter radius wear/geometry) and 2/3 (tool length wear/geometry);
30i adds 6/7 (imaginary tool nose) and 10/11 (corner R). T series uses 0/1 X, 2/3 Z,
4/5 nose R, 6/7 imaginary nose, 8/9 Y, 30/31 4th axis, 32/33 5th axis.

### The two forms use different type numbers

`cnc_rdtofs` (single) and `cnc_rdtofsr` (range) are the same opcode but **do not agree on
what a type number means**. Measured over offsets 1..20 on the 31i at 10.192.233.166:

| single type (spec enum) | range type | values |
|---|---|---|
| 0 cutter radius wear | **3** | `0, 0, -0.005, 0, 0` |
| 1 cutter radius geometry | **2** | `0, 0, 0, 0, 0` |
| 2 tool length wear | **1** | `0.08, 0, 0.02, 0.2, 0.15` |
| 3 tool length geometry | **0** | `129.907, 136.379, 97.846, 125.361, 99.581` |

So `range type = 3 − single type` for the four types this machine has. The single form
follows the spec's enum; the range form does not. `fanuc-focas.js` keeps
`TOFS_RANGE_TYPE` for the mapping rather than assuming either numbering.

Types 4..11 are `EW_ATTRIB` on this machine in **both** forms — it has only the four.

### What is implemented

`focas.js` has `readtofsinfo()`, `readtofs(number, type)` and `readtofsr(s, e, type)`, and
`fanuc-focas.js` exposes them as the **Tool Offsets** function and the `tool_offsets` field
of `All Data`. The node uses the range form (one call per type) because it is 33× faster:
396 single reads took 5.5 s against 163 ms for four range reads.

**The write side is deliberately absent.** `cnc_wrtofs` (0x09), `cnc_wrtofsr` and
`cnc_wrzofs` (0x0c) have not been captured, and a wrong write opcode changes a machine's
offsets. Capture them with `tools/probe-dll-tofs.py` before adding any of them.

`cnc_rdzofs` is also still unimplemented: its argument packing is not settled (see above),
so it is a probe (`tools/probe-tofs.js`) rather than a decoder.

---

## Tier-1/2 read set: opcodes and wire layouts

Measured **2026-11-13** on the 31i at **`10.192.232.189:8193`** — `cnc_type` `31`,
`mt_type` ` M`, series `G40A`, version `60.0`, `max_axis` 32, `axes` `"05"`.
The machine was in MEM with `run=3` (START) and `motion=1` for part of the run, so the
values below are live readings, not a parked controller.

Two tools produced this:

- `python tools/probe-dll-opcode.py --stub --tier12` — the opcodes, from the vendor
  library's own traffic. No controller needed; the request bytes are on the wire before
  any reply is parsed, so they are sound even though the stub's replies are synthesised.
- `node tools/probe-tier12-layout.js` / `probe-tier12-verify.js` / `probe-pmc-byteorder.js`
  — the response layouts, from the controller itself.

Every function here was checked against its SpecE page first: **none carries
`stop sampling` / `cnc_stopophis` / `stop logging`**, so none of them interrupts the
CNC's own history recording. The ones that do (`cnc_rdalmhistry*`, `cnc_rdophistry*`,
`cnc_rdalmhisno`, `cnc_rdophisno4`, `cnc_rdomhis*`) are deliberately absent.

### Opcodes

| call | wire func | c1/c2 | request args |
|---|---|---|---|
| `cnc_rdcncid`      | `0x0e8` | 1 / 1 | — |
| `cnc_rdzofsinfo`   | `0x0d`  | 1 / 1 | — |
| `cnc_rdzofs`       | `0x0b`  | 1 / 1 | `number`, `number`, `axis` |
| `cnc_rdseqnum`     | `0x1d`  | 1 / 1 | — |
| `cnc_rdcommand`    | `0x97`  | 1 / 1 | `type`, `block` |
| `cnc_rdopmsg3`     | `0xd0`  | 1 / 1 | `0`, `type`, `1` — **not implemented, see below** |
| `cnc_statinfo2`    | `0xe2` + `0xe1` + `0x98` | 1 / 1 | — (three sub-requests, one frame) |
| `cnc_rdproginfo`   | `0x07`  | 1 / 1 | — |
| `cnc_rdpm_item`    | `0xbe`  | 1 / 1 | `start`, `num` |
| `cnc_rdblkcount`   | `0x35`  | 1 / 1 | — |
| `cnc_gettimer`     | `0x45`  | 1 / 1 | `type` |
| `cnc_rdexecprog`   | `0x20`  | 1 / 1 | `length`, 0, 0, 0, 0 |
| `pmc_rdpmcrng`     | `0x8001`| **2 / 1** | `s_number`, `e_number`, `adr_type`, `data_type`, 0 |

**`pmc_rdpmcrng` is 2/1, like `pmc_rdalmmsg`.** The second word of the pair is a
path/unit selector, so sending 1/2 is answered `EW_PATH` (11) — the same trap that cost
this project a release. Its arguments are also **not** the C order: the wire is
`(s_number, e_number, adr_type, data_type, 0)`, and `length` never goes on the wire at
all — the library computes it.

### Three functions need no new opcode

| call | what it actually sends | note |
|---|---|---|
| `cnc_rdalminfo`   | `0x23` | the same opcode as `cnc_rdalmmsg`; `withtext=0` is the "without message" form |
| `cnc_rdspload`    | `0x40[0]` | the same opcode as `cnc_rdspmeter(type=0)` |
| `cnc_rdspmaxrpm`  | `0x40[1]` | `cnc_rdspmeter(type=1)` |
| `cnc_rdspgear`    | `0x40[2]` | **not** in `cnc_rdspmeter`'s documented 0/1/-1 enum |

`cnc_rdalminfo(type=0)` puts `(-1, 25, 0, 32, 0)` on the wire, which is exactly
`cnc_rdalmmsg(type=-1, maxmsgs=25, withtext=0, textlen=32)`. The node's
`readalarmcode()` with `withtext=0` already reaches it.

### Response layouts

Every one of these widens `short` to a 4-byte long and drops the C `dummy` fields, the
same treatment `ODBALM` and `ODBUSEGR` get. The C struct is not the wire.

| call | wire bytes | layout |
|---|---:|---|
| `cnc_rdcncid`    | 16 | 4 × `unsigned long`, **matches the C struct** |
| `cnc_rdzofsinfo` | 4  | one long (`307` on this machine) — not `sizeof(short)` |
| `cnc_rdzofs`     | 8  | `value(i32) \| unit(i16) \| dec(i16)`, no header |
| `cnc_rdseqnum`   | 4  | one long; `ODBSEQ`'s `dummy[2]` is dropped |
| `cnc_rdcommand`  | 12·N | `adrs(u8) \| num(u8) \| flag(u16) \| cmd_val(i32) \| dec_val(i32)` |
| `cnc_rdopmsg3`   | — | **not decoded** — the reply could not be identified, see below |
| `cnc_statinfo2`  | 22 + 4 + 2 | sub1 = 11 shorts starting at `aut`; sub2 = `hdck`/`tmmode`; sub3 not used |
| `cnc_rdproginfo` | 16 | **four longs**: registered, available, used_mem, unused_mem |
| `cnc_rdpm_item`  | 80·N | `name[64] \| type(i32) \| total(i32) \| remain(i32) \| stat(i32)` — name padded 62→64 |
| `cnc_rdblkcount` | 4  | one long |
| `cnc_gettimer`   | 12 | **6 shorts: year, month, day, hour, minute, second** |
| `pmc_rdpmcrng`   | N·width | raw PMC bytes, no header |

#### `cnc_rdzofs` — the argument packing is settled

The second slot **repeats the offset number**, the same shape `cnc_rdparam3` uses:

| call | wire args |
|---|---|
| `cnc_rdzofs(1, axis=1)` | `1 1 1` |
| `cnc_rdzofs(1, axis=2)` | `1 1 2` |
| `cnc_rdzofs(2, axis=1)` | `2 2 1` |

That is why the C order `(number, axis, length)` was answered `EW_ATTRIB` — the third
slot is the axis, not a length. Measured values on this machine: offset 1 axis 1 =
−299.015 mm, axis 2 = −199.000, axis 3 = −400.000, all at dec 3, unit 10.

#### `cnc_gettimer` — date and time are two calls, and each fills only its own half

The spec says date and time are separate calls selected by `type`, and the wire agrees
— but the reply is always the full 12 bytes, and **the half that was not asked for
keeps whatever was in the buffer**:

```
type=0 (date) → 2026 11 13 8269 18228 12353   ← tail is stale
type=1 (time) → 2026 11 13 17 18 26           ← head is the last date read
```

So `gettimer()` reads `type=0` for the date and `type=1` for the time and takes each
half from the call that asked for it. **Reading one type twice does not work** — the
unasked half is never filled. An earlier version of this note said one call returned
both; that was wrong, and the first end-to-end run against the controller caught it
(the hour came back as 8269).

#### `cnc_rdopmsg3` — NOT implemented, because the reply could not be identified

The opcode `0xd0` was captured, but on the 31i at 10.192.232.189 the reply is not an
`OPMSG3` at all: 268 bytes whose content is the `cnc_sysinfo` block (`G40A`, `60.0`,
`05` — that machine's series, version and axis count) followed by zeros, **identical
across every `type` and every call**. That is the signature this file records for a
wrong opcode — an answer that does not change with its arguments — and the machine had
no operator message set, so the real layout could not be measured either way.

There is no decoder for it. Do not add one until a controller with a message typed on
screen can be probed.

#### `cnc_statinfo2` — sub1 starts at `aut`, and sub3 is not part of ODBST2

One frame carries `0xe2`, `0xe1` and `0x98`. The assembly is **not** `sub1 + sub2` in
`ODBST2` declaration order. Measured 2026-11-13 on the 31i at 10.192.232.189, back to
back with the plain `cnc_statinfo`:

```
cnc_statinfo (0x19) : 1 3 1 0 0 0 0            (aut run motion mstb emergency alarm edit)
statinfo2 sub1 (e2) : 1 3 1 0 0 0 0 0 0 0 0    (11 shorts)
statinfo2 sub2 (e1) : 0 3                      (2 shorts)
```

sub1's first seven shorts are **byte-identical** to `cnc_statinfo`'s seven, so **sub1
starts at `aut`** — not at `hdck`. sub2 is then `hdck`/`tmmode`, the two fields `ODBST2`
declares first. Reading sub1 as if it began with `hdck`/`tmmode` shifts every field by
two; an earlier version of this decoder did exactly that and reported `run=****` /
`motion=Stopped` while the machine was in `STaRt`/`Moving`.

`0x98` answers 2 bytes and is **not** part of the struct — do not request it.

#### `cnc_rdproginfo` — four longs, not two shorts then two longs

The wire is 16 bytes of **four longs**:

```
00 00 00 81 | 00 00 03 70 | 00 02 bd 2c | 00 7e ca fc
    129          880           179500        8309500
```

The C `ODBNC` union's `bin` branch is `short reg_prg | short unreg_prg | long used_mem |
long unused_mem`, and reading the wire that way gives `registered = 0` — which is wrong.
That machine has **112 programs in its directory** and **129 registered**, so the
four-long reading is the one that agrees with an independent count. The wire widens the
two shorts to longs, the same treatment every other record here gets.

#### `pmc_rdpmcrng` — the data_type enum is FwSymbol.h's, not the spec's

`FwSymbol.h` defines `PMC_BYTE 0`, `PMC_WORD 1`, `PMC_LONG 2`. The SpecE page's prose
says "0: Byte type, 1: Word type, 2: Long type" but the `length` formula on the same page
is written against a different numbering, and reading `dtype=2` as a word is what made
the first pass look contradictory. **Use 0/1/2 = byte/word/long.**

`s_number` and `e_number` are **byte addresses at every width**. The element count is
`(e − s + 1) / width`, and the reply is that many elements — so the same byte range read
at all three widths always returns the same number of bytes.

**Byte order: the byte path is little-endian within each 2-byte word.** Reading the same
8 bytes three ways on this machine:

```
D100..D107 byte : 22 05 03 14 00 22 05 03
D100..D107 word : 05 22 14 03 22 00 03 05
D100..D107 long : 14 03 05 22 03 05 22 00
```

Reversing each 2-byte group of the byte read reproduces the word read exactly, and the
same holds on the K area (`K0..K7`), so it is not a D-table quirk. Confirmed directly:
`D100` as a word is `0x0522`, and `D100`/`D101` as bytes are `0x22`/`0x05` — **D100 holds
the low half**. The long read is the word read's bytes taken 4 at a time, so it inherits
the same order.

**Bit reads return one byte per bit** (8 bits → 8 bytes), not one byte holding eight
bits. The caller masks.

#### `cnc_rdpm_item` — the name is padded to 64

`IODBPMAINTE` declares `char name[62]`, but the wire stride is **80**, not 78: the name
occupies 64 bytes. Confirmed by asking for 1, 2, 3 and 10 items — the reply is exactly
`80·N` every time, and records 0 and 1 are byte-identical on this machine (no maintenance
items configured), which is what a correct stride looks like when the data is uniform.

#### `cnc_rdcommand` — the modal block is the useful one

`type=-1` (all modal) answers 14 records of 12 bytes; `type=-2` (all commanded) answers 3
on this machine. The modal block carries `D`(27) `E`(0) `F`(5000) `H`(23) `L`(0)
`M1`(8) `N`(20) `O`(8002) `S`(1400) `T`(13) plus four empty `M2..M5` slots. `flag` bit
`0x0800` is set on every populated record and clear on the empty ones — **use it to tell
"no command" from "command is zero"**, which is the distinction the node's payload
contract requires.

### `cnc_rdexecprog` — opcode captured, pointer behaviour NOT verified

`0x20`, args `(length, 0, 0, 0, 0)`. Its spec page says the execution pointer moves to
the next block under single-block operation. The machine was cutting (`run=3`,
`motion=1`, feed 5000 mm/min, spindle 1399 rpm) when this was measured, so **the
pointer check was not run** — it needs an idle machine that can be watched.

It is therefore **not** in `probe-funcsupport.js`'s default set. Pass
`--include-execprog` to add it, and only against a controller that is not cutting.

Under `--stub` it faults inside the DLL (access violation, not a Python exception, so it
cannot be caught): the stub answers an empty success and the handler writes `*length`
bytes from a reply it expects to be non-empty. `probe-dll-opcode.py` skips it in stub
mode for that reason.

### Series support — several of these are HSSB-only or absent on older CNCs

From each function's `<support>` table (`O` = both, `E` = Ethernet only, `H` = HSSB only,
`X` = cannot be used). This project is Ethernet, so **`H` and `X` both mean "not on this
machine"**:

| call | 15 | 15i | 16/18/21 | 16i/18i/21i-B | 0i-D/F | 30i-A/B |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `pmc_rdpmcrng` | H | O | H | O | O | O |
| `cnc_rdcncid` | X | X | X | X | O | O |
| `cnc_rdzofs` / `cnc_rdzofsinfo` | H | O | H | O | O | O |
| `cnc_rdseqnum` | H | O | H | O | O | O |
| `cnc_rdcommand` | X | O | X | X | O | O |
| `cnc_rdopmsg3` | H | O | X | O | O | O |
| `cnc_statinfo2` | X | X | X | X | O | O |
| `cnc_rdproginfo` | H | O | H | O | O | O |
| `cnc_rdpm_item` | X | X | X | O | O | O |
| `cnc_rdalminfo` | H | O | H | O | O | O |
| `cnc_rdspgear` / `rdspload` / `rdspmaxrpm` | H | O | H | O | O | O |
| `cnc_rdblkcount` | H | O | H | O | O | O |
| `cnc_gettimer` | H | O | H | O | O | O |

`cnc_rdcommand` additionally says "use `cnc_modal` instead" for 15, 16i/18i/21i,
0i-A/B/C and Power Mate i — a different struct and a different type enum, so it is a
separate decoder, not a fallback.

**Do not put these in `All Data`'s mandatory path.** On an older machine each one costs a
round trip and returns `EW_FUNC` (1) or `EW_NODLL` (-15); the node's `read()` helper
already degrades that to `null` plus an `errors[key]` entry, which is the right contract,
but a per-poll error on every old machine is noise.

### What was verified on 10.192.232.189

`node tools/probe-funcsupport.js 10.192.232.189 8193` — 46 probes, **45 `EW_OK`**, 0
`EW_NOOPT`, 1 other. The one non-OK is `cnc_rdparam` (`0x0e`), which is the 16/18/21i
form of `cnc_rdparam3` and is *expected* to answer `EW_FUNC` on a 30i; the node only
tries it when `0x8d` comes back empty.

All 12 new functions answered `EW_OK` on this machine. That is one 31i, not a support
matrix — the table above is the vendor's, and the older series were not tested.

### Two decode faults a captured log caught

`logs/20261113-log.json` (an `All Data` poll of this machine) showed two fields that did
not match the machine, even though `errors` was empty — which is exactly the failure mode
the payload contract is meant to prevent: a wrong decode is not an error, it is a
plausible-looking number.

| field | logged | correct | cause |
|---|---|---|---|
| `program_memory.registered_programs` | `0` | `129` | the block is four longs; it was read as two shorts then two longs |
| `machine_state_ext.run_state` / `.motion` | `****` / `Stopped` | `STaRt` / `Moving` | sub1 starts at `aut`; it was read as if it began with `hdck`/`tmmode` |

Both were found by comparing against an independent read — the program directory for the
first, `cnc_statinfo` for the second — not by looking at the numbers. `tools/probe-log-audit.js`
reproduces the comparison, and `tools/verify-node-tier12.js` now asserts that
`status_info2` and `status_info` agree on every field they share.

**A third field looked wrong and was not.** `calendar` reported 17:35 while the poll
timestamp was 15:22 local. That is a real **133-minute offset in the CNC's own clock**, not
a decode fault: the hour is plausible, and a wrong `type` would have produced a nonsense
value like `8269` (which is what the earlier one-call version did). The CNC clock is a
machine setting; the node reports it as-is and does not correct it.

