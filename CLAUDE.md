# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Node-RED node that polls FANUC CNC controllers over Ethernet. **No dependencies** — only
Node built-ins (`net`, `Buffer`), no FANUC SDK at runtime, no native bindings. Node ≥ 14,
Node-RED ≥ 2.0. Do not add npm dependencies.

## Commands

There is no build step, no linter and no test runner — `package.json` has no `scripts`. Every
tool is a standalone script run directly with `node` (or `python` for the opcode capture).

Offline checks, **no controller needed** — stub the `Focas` prototype and drive the real node:

```bash
node tools/verify-node-toollife-offline.js
node tools/verify-node-alarms-offline.js
```

End-to-end checks against a real controller (first arg is the IP, defaults documented in each
script's header):

```bash
node tools/verify-node-load.js <ip> [port]
node tools/verify-node-axes.js <ip> [port]
node tools/verify-node-toollife.js <ip> [port]
node tools/verify-node-alarms.js <ip> [port]
node tools/verify-node-sessions.js <ip> [port]
```

Diagnostics that dump raw frames instead of asserting (all read-only):

```bash
node tools/probe-funcsupport.js <ip>          # which function codes this CNC answers
node tools/probe-alarms.js <ip>               # raw cnc_rdalmmsg responses
node tools/probe-toollife.js <ip>             # raw tool-life payloads
python tools/probe-dll-opcode.py <ip> 8193    # opcodes, captured from the vendor DLL
python tools/probe-dll-opcode.py --stub       # the same request bytes, no controller needed
```

## The central discipline: opcodes are captured, never guessed

FOCAS function codes are **not in the SDK headers**. The only faithful source is the vendor
library's own traffic, captured by driving `Fwlib64.dll` through a local TCP proxy
(`tools/probe-dll-opcode.py`). This is how `cnc_rdsvmeter = 0x56`, `cnc_rdspmeter = 0x40`,
`cnc_alarm = 0x1a`, `pmc_rdalmmsg = 0x8010` and the tool-life codes were obtained.

The opcode is not the whole request: the `c1`/`c2` pair in front of it is per-function too,
and mistaking it for a constant costs just as much. `pmc_rdalmmsg` is the one call here that
is not `1`/`1`, and reading its pair off the hexdump backwards produced `EW_PATH` (11) on
every poll — see `PMC_RDALMMSG_C1`/`C2` in `focas.js`. `--stub` prints each request as
`c1=2 c2=1 func=0x8010 args=1 10 0 0 0`, which is the form to compare against, not hex.

Guessing one is not a harmless mistake — it silently reads some *other* function's data, or
returns `EW_FUNC`, and neither reply says which. This has already burned the project twice:
the load meters silently reporting `null`, and `0x22` sitting labelled `cnc_alarm` in the probe
tools when the real code is `0x1a`. When adding a function: capture first, then set the
constant, and record the measurement in `docs/notes.md`.

The wire layout is usually **not** the C struct either. The wire widens `short` fields to
4-byte longs and drops "not used" padding fields (see `ODBALMMSG`/`ODBALM` in `focas.js`).
Decode from captured traffic, not from `Fwlib64.h`.

## Layout

- `focas.js` — the FOCAS2 protocol client. No Node-RED in here; it is usable standalone and
  `tools/verify-*.js` drive it directly.
- `fanuc-focas.js` — the Node-RED node: a config node (`fanuc-config`) holding host/port/series,
  and a poll node that calls `collect(...)`. This is where payload shaping happens.
- `fanuc-focas.html` — the editor form and the in-editor help text. Logic is limited to
  showing/hiding form rows; payload documentation lives here *and* in `README.md`.
- `tools/` — `probe-*` dump raw frames, `verify-*` assert. Offline ones need no hardware.
- `docs/FANUC_Focas_API/` — the vendor SDK. **Gitignored, proprietary, must not be committed or
  redistributed.** It is the spec reference (`Document/SpecE/`) and the capture script's DLL
  source. The path has moved before; the script auto-detects it or takes `FOCAS_DLL_DIR`.
- `docs/notes.md` — measured controller limits and deliberately deferred work. Read it before
  touching decoders, timeouts or paging; append new measurements there rather than in `README.md`.
  Note that `.gitignore` lists `docs/`, but `notes.md` is already tracked, so it still commits
  while the SDK beside it does not.

## Protocol notes

Framing: `a0 a0 a0 a0 | fvers | ftype | len | body`. Frame types: `0x0101/0x0102` open
request/accepted, `0x0103` **refused** (every session in use — never a network fault),
`0x2101/0x2102` variable request/response, `0x0201/0x0202` close.

A sub-request is a 6-byte command (`c1`, `c2`, `func`) plus five `int32` arguments. A response
echoes the command, then 6 status bytes, then a 2-byte data length, then the data block.
`_reqSingle` / `_reqMulti` are the only two request primitives — read them before adding a call.

**FOCAS is strictly sequential**: one request in flight per socket. Never `Promise.all` FOCAS
calls. A controller accepts only ~5 concurrent sessions, so the node serialises its own polls
(`FanucFocasNode`'s queue); a `_recv` timeout destroys the socket, because a partial frame
leaves the stream desynchronised.

## Per-series differences

Several enums differ per series and the **controller's reported `cnc_type` picks the table**,
not the configured `cnc_series` — a flow copied from another machine carries that machine's
series and would silently mislabel everything. See `almSeriesGroup()`. Run modes are the other
main case (`run=0` means *reset*, not STOP, on Series 16/18/21/0i/30i).

Convenient coincidence, verified in the spec: `cnc_rdalmmsg`'s `type` index and
`cnc_alarm`/`cnc_alarm2`'s status bitmask use the same per-series numbering, so
`ALM_TYPES_BY_GROUP` labels both.

## Payload contract

`All Data` reads every field through a `read(key, fn)` helper so one failure degrades **only
that field**: the field becomes `null` and the reason lands in `errors[key]`. The single-value
Functions raise instead. A field that is `[]` means "read cleanly, found nothing" and is
deliberately distinguishable from `null`.

Adding a field to `All Data` is not a local change: the offline verify scripts stub the `Focas`
prototype by hand, and `tools/verify-node-toollife-offline.js` asserts that a clean `All Data`
run leaves `errors` **empty**. A new field with no stub fails that test — add the stub
alongside the new reader.

Arrays keep the poll `timestamp` as a *property* (object-spreading a list would turn it into
`{"0":…}`), so it is not visible in JSON — this is intentional and documented in `README.md`.
Any change to a payload shape means updating `README.md`, `fanuc-focas.html`'s help block, and
`docs/notes.md`'s notes if the wire is involved.

`fanuc-focas.js` throws at load time if `focas.js` is missing something it calls (currently
`TOOL_GROUP_PAGE`, `readalarmstatus2`, `readpmcalarm`) — the two files must be updated together.

## Conventions

Comments in this repo carry *why*, *how it was measured*, and *what was ruled out*, with the
machine and date for any measured number. Match that: a new constant sourced from a controller
should name the controller and the date, and point at the tool that produced it.
