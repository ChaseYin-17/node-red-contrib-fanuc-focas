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