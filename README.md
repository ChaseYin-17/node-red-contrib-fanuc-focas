[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/zhideloh)


# node-red-contrib-fanuc-focas

A Node-RED node for collecting telemetry from **FANUC CNC controllers** via the **FOCAS2 TCP protocol**.

Pure Node.js — no Python, no native libraries, no FANUC SDK required. Works on any platform including **Raspberry Pi (aarch64/arm64)**.

---

## Features

- Connects directly to FANUC controllers over Ethernet using the FOCAS2 wire protocol
- Selectable **Function** — poll only the data you need per node instance
- Sub-type selector for **Axes Data** (position, servo/spindle load, feedrate)
- Configurable **Parameter** and **Macro** variable reads by number
- Sub-second timer resolution (millisecond companion parameters)
- Correct run-state decoding for Series 16/18/21/0i/30i controllers
- Series 15/15i support via config selector
- Status indicator on each node (blue = polling, green = ok, red = error)

---

## Supported Controllers

| Series | Examples |
|--------|---------|
| Series 0i-D / 0i-F | 0i-D T (lathe), 0i-D M (mill) |
| Series 16i / 18i / 21i | 16i-T, 18i-M |
| Series 30i / 31i / 32i | 30i-B |
| Series 15 / 15i | (select Series 15 in config) |

Requires the **FOCAS Ethernet option** to be enabled on the controller (option code `A02B-0207-J732` or equivalent). Default TCP port is **8193**.

---

## Installation

### From Node-RED Palette Manager

Search for `fanuc-focas` in **Menu → Manage Palette → Install**.

### From command line

```bash
cd ~/.node-red
npm install node-red-contrib-fanuc-focas
```

---

## Usage

1. Drag a **fanuc focas** node onto your flow (found under the *input* category).
2. Double-click it and create a new **FANUC Controller** config:
   - **IP Address** — controller Ethernet IP (e.g. `192.168.0.100`)
   - **FOCAS Port** — default `8193`
   - **CNC Series** — `16/18/21/0i/30i` for most modern controllers
3. Select a **Function** from the dropdown.
4. Wire an **Inject** node (e.g. repeat every 2 seconds) to trigger polling.
5. `msg.payload` contains the result for the selected function.

---

## Functions

| Function | Description | `msg.payload` fields |
|----------|-------------|----------------------|
| **All Data** | Full combined snapshot | `controller`, `machine_id`, `machine_state`, `machine_state_ext`, `active_program`, `sequence_number`, `modal_commands`, `program_memory`, `maintenance`, `block_count`, `calendar`, `timers`, `part_count`, `feedrate_spindle`, `axes_data`, `tool_life`, `tool_offsets`, `active_alarms`, `alarm_status`, `pmc_alarms` |
| **Status Info** | Machine run state | `mode`, `run_state`, `motion`, `mstb`, `emergency`, `alarm`, `edit` |
| **System Info** | Controller identity | `cnc_type`, `mt_type`, `series`, `version`, `axes`, `max_axes` |

> `axes` is the **current** controlled axis count (`cnc_sysinfo`'s `axes`, e.g. `5` on a
> 5-axis machine); `max_axes` is the maximum the CNC can control (`max_axis`, e.g. `32`).
> Reporting the maximum as `axes` is a common mistake and it is what this node used to do.
| **Timers** | Accumulated time counters | `power_on_time`, `auto_operation_time`, `cutting_time`, `cycle_time` |
| **Axes Data** | Position / load / feed | See sub-types below |
| **Parameters** | Raw CNC parameters | `{ [param_number]: value, … }` |
| **Program Number** | Active program | `running_program`, `main_program`, `running_comment`, `main_comment` |
| **Part Count** | Parts produced | `required_parts`, `lifetime_total` |
| **Tool Life** | Per-group tool life | `group_count`, `using_group`, `groups[]`, `most_used_group`, … |
| **Tool Offsets** | Tool compensation table (read-only) | `ofs_type`, `memory`, `use_no`, `types[]`, `offsets[]` |
| **Alarm Messages** | Active alarms | Array of `{ type, type_code, code, axis, text }` |
| **Alarm Status** | Alarm status word | `status`, `bits[]` of `{ bit, label }` |
| **PMC Alarms** | PMC's own ERxx/WNxx messages | Array of `{ message }` |
| **Macro** | Custom macro variables | `{ [macro_number]: value, … }` |
| **Machine ID** | The CNC's own identity | `cncid`, `cncid_values` |
| **Calendar** | The CNC clock | `year`, `month`, `day`, `hour`, `minute`, `second`, `date`, `time`, `iso_like` |
| **Status Info (extended)** | Run state plus warning / 3D check / restart | `mode`, `run_state`, `motion`, `mstb`, `emergency`, `alarm`, `edit`, `warning`, `o3d_check`, `ext_option`, `restart`, … |
| **Program Memory** | Program count and memory use | `registered_programs`, `available_programs`, `used_memory`, `unused_memory`, `used_percent` |
| **Sequence Number** | The N number being executed | `sequence_number` |
| **Block Counter** | The CNC's block counter | `block_count` |
| **Modal / Commanded F,S,T** | What is in effect, or what this block asks for | `block`, `commands` |
| **Work Zero Offsets** | The work-zero offset table (read-only) | `use_no`, `axis_count`, `offsets[]` |
| **Maintenance Items** | The CNC's maintenance items 1–10 | `items[]` |
| **PMC Read** | Machine-builder signals from the PMC | `values[]` |

### Axes Data sub-types

| Sub-type | Description |
|----------|-------------|
| Absolute position | Axis positions in absolute coordinates |
| Machine position | Axis positions in machine coordinates |
| Relative position | Axis positions relative to last reset |
| Distance to go | Remaining distance in current block |
| Servo load meter | Per-axis servo load (%) |
| Spindle load meter | Spindle load (%) |
| Spindle motor speed | Actual spindle RPM |
| Actual feedrate | Feedrate in mm/min |

### Position reads

The position sub-types return **one entry per controlled axis**, in axis order, and
nothing else:

```json
"absolute_position": { "ABS": [0, 0, 0] }
```

> The controller sizes a position block for the *maximum* axis count and leaves the slots
> past the axes it controls undefined. Those slots still carry a decimal flag, so decoding
> them yields plausible-looking numbers that are not positions — the official library hands
> back the same integers at the same indices and leaves it to the caller not to read them.
> The node bounds the array by the controlled-axis count reported by the CNC, so a
> 3-axis machine gets 3 entries however large the configured maximum is.

### Load meters

Both load meters are read with their own FOCAS functions — `cnc_rdsvmeter` and
`cnc_rdspmeter` — not from diagnostic data. Both return **one value per axis or spindle**,
read back as arrays alongside the names they belong to:

```json
{
  "servo_load_percent": [12, 7, 31],
  "servo_load_axes": ["X", "Y", "Z"]
}
```

```json
{
  "spindle_load_percent": 4,
  "spindle_load_percents": [4],
  "spindle_load_names": ["S"]
}
```

`servo_load_percent` is an **array, one entry per servo axis**, in the same order as
`servo_load_axes`. For the spindle the scalar `spindle_load_percent` is the first spindle,
so a single-spindle flow needs no change, while `spindle_load_percents` carries all of them.

Selecting **Servo load current** reads the same axes in Ampere:

```json
{
  "servo_load_current_amps": [1.85, 0.42, 3.07],
  "servo_load_axes": ["X", "Y", "Z"]
}
```

It is the same FOCAS call the per-cent meter uses, with the load-current selector, so both
are magnitudes — a regenerating axis reads positive in either. The controller reports the
scale alongside the value (decimal 0 for per cent, 2 for Ampere) and the node applies it.
`cnc_rdaxisdata`, the SDK call that also exposes this reading, has no opcode of its own;
see `docs/notes.md` for how the vendor library reaches it.

> The number of axes and spindles is read from the controller (`cnc_rdaxisnum`) rather than
> assumed from the configured maximum, so the arrays are never padded out with unused axes.

### Timer format

Each timer returns both a machine-readable value and a formatted string:

```json
"cutting_time": {
  "total_seconds": 53594.237,
  "formatted": "14h 53m 14.237s"
}
```

### Alarm messages

Active alarms are read with `cnc_rdalmmsg` using alarm category `-1` (*all type*), so every
category is collected in one request. Each entry carries both the decoded label and the raw
numeric category:

```json
[
  {
    "type": "Parameter switch on (SW)",
    "type_code": 0,
    "code": 100,
    "axis": 0,
    "text": "PARAMETER ENABLE SWITCH ON"
  }
]
```

> **Alarm `type` is not universal.** The numeric category is an index into a per-series enum —
> the same number means different things on Series 15i, 16i/18i/21i/0i-A/B/C and
> 30i/31i/32i/0i-D/F/PMi-A. The node picks the right table from the controller's reported
> CNC type. `type_code` is always the raw value, so a label can be re-derived if the
> controller is not recognised.
>
> Message text is limited to 32 characters by `cnc_rdalmmsg` on every series — the spec
> says so and points at `cnc_rdalmmsg2` for the 30i family. The node sends the documented
> 32 and validates that the payload is a whole number of records, so a layout mismatch
> raises instead of silently mis-slicing every alarm.

When **Function** is `Alarm Messages` the payload is an **array**, with the poll timestamp
attached as a property (not visible when the array is JSON-serialised). Other functions return
an object containing `timestamp`.

### Alarm status

The status word is a **different read from the messages**, and the two do not have to agree.
`cnc_alarm2` returns a 32-bit bitmask; bit *N* is the condition `cnc_rdalmmsg` would report as
category *N*, so the labels come from the same per-series table. A bit can be set with no
message to match it — a status bit is a condition, not always something the controller turns
into text.

```json
{
  "status": 130,
  "bits": [
    { "bit": 1, "label": "Foreground P/S (PS)" },
    { "bit": 7, "label": "PMC error (PC)" }
  ]
}
```

`status` is the raw word and every set bit appears in `bits` with its number and label, so a
label can be re-derived if the controller is not recognised. The 16-bit `cnc_alarm` is not
used: over Ethernet the SDK marks it unsupported on 16i/18i/21i, and it cannot carry the upper
bits the 30i family needs. On the wire `cnc_alarm` and `cnc_alarm2` are the same call.

### PMC alarms

The PMC's **own** ERxx/WNxx messages — ROM parity, I/O allocation errors, ladder size errors.
This is the PMC itself failing, **not** the ladder's external (EX) messages: those arrive as
CNC alarms and appear under `Alarm Messages` instead. The text is served by the FOCAS library's
`fwpmcalm.ini`, so message bodies live on the PC, not on the machine.

```json
[
  { "message": "ER30 Battery Alarm" }
]
```

This is its own field for that reason — merging it into `active_alarms` would mix a PMC fault
with the alarms the ladder is reporting. The call reports whether more alarms are waiting, so
the node pages rather than truncating (capped, so a controller that always says "more" cannot
run the loop away).

### Tool life

**Tool Life** reads the CNC's tool-life management: one entry per registered tool group,
plus the group the machine is currently working through.

```json
{
  "group_count": 3,
  "max_group": 128,
  "max_tool": 24,
  "max_minute": 9999,
  "max_cycle": 9999,
  "using_group": 2,
  "next_group": 3,
  "selected_group": 2,
  "groups": [
    {
      "group": 1,
      "tool_count": 6,
      "life": 500,
      "counter": 412,
      "remaining": 88,
      "usage_percent": 82.4,
      "count_type": 0,
      "unit": "count",
      "in_use": false,
      "life_rest_raw": 0
    }
  ],
  "most_used_group": 1,
  "timestamp": "2026-09-28T07:35:23.213Z"
}
```

> `count_type` is **per group** — `0` counts parts, `1` counts minutes — so each group
> carries its own `unit`. `remaining` prefers the CNC's own rest counter when it reports
> one (tool life management B; the value the change decision uses) and otherwise falls
> back to `life − counter`; the raw value is kept as `life_rest_raw`. A group with no life
> set (`life: 0`) gets `remaining: null` and `usage_percent: null`, never `0` — "0
> remaining" would read as a spent tool and "0%" as plenty left. Groups with no tools
> registered are skipped.
>
> **Needs the CNC's tool life management option.** Without it the controller answers
> `EW_NOOPT (6)`, the poll raises, and the node reports it — rather than returning an
> empty tool table that looks like "no tools".
>
> The wire layout is *not* the SDK's C struct: fields are widened to 4-byte longs, `cnc_rdngrp`
> and `cnc_rdtlinfo` return the same 20-byte block, and `cnc_rdusegrpid` returns only three
> longs. The offsets were corrected against a controller with the option on; see
> [`docs/notes.md`](docs/notes.md). `node tools/probe-toollife.js <ip>` dumps the raw payloads.
>
> Groups are read a page at a time: the controller refuses a single oversized
> `cnc_rdgrpinfo4` (measured ceiling `num_to_read = 103`), so the node pages through with
> `grp_no` instead of asking for every group in one call.
>
> The limits and the group count are read with `cnc_rdtlinfo` / `cnc_rdngrp` /
> `cnc_rdusegrpid`, and are **best effort**: if one fails the payload still comes back with
> that part zeroed, and the reason is recorded under `tool_life.errors` (keyed by the call
> that failed). Only `cnc_rdgrpinfo4` is required — without the option it is what raises
> `EW_NOOPT`.

### Tool offsets

**Tool Offsets** reads the tool compensation table: how many offsets the machine has, and
every offset's value per type.

```json
{
  "ofs_type": 0,
  "memory": "memory A",
  "use_no": 99,
  "types": [
    { "type": 0, "label": "cutter radius wear" },
    { "type": 1, "label": "cutter radius geometry" },
    { "type": 2, "label": "tool length wear" },
    { "type": 3, "label": "tool length geometry" }
  ],
  "offsets": [
    {
      "number": 1,
      "values": {
        "0": { "label": "cutter radius wear",     "value": 0,       "raw": 0,     "dec": 3 },
        "1": { "label": "cutter radius geometry", "value": 0,       "raw": 0,     "dec": 3 },
        "2": { "label": "tool length wear",       "value": 0.08,    "raw": 80,    "dec": 3 },
        "3": { "label": "tool length geometry",   "value": 129.907, "raw": 129907, "dec": 3 }
      }
    }
  ]
}
```

> **Read-only.** The node has no write path for offsets — not a disabled one, an absent
> one. A wrong write opcode changes a machine's offsets, and none of the write calls
> (`cnc_wrtofs`, `cnc_wrtofsr`, `cnc_wrzofs`) has been captured from the vendor library.
>
> `raw` and `dec` are carried alongside `value` so the unscaled integer is available when
> the decimal position matters. `unit` is on the wire but read 10 on every record measured,
> which is not the `LOADELM` unit enum, so it is not interpreted.
>
> The type numbers follow the spec's per-series enum, and the **label comes from the
> controller's `mt_type`**: an M series has cutter radius / tool length, a T series has
> X / Z / nose R under the same numbers.
>
> The table is read with `cnc_rdtofsr` (one call per type) rather than one call per offset:
> measured on a 31i, 396 single reads took 5.5 s against 163 ms for four range reads. The
> range form's `type` numbering is **not** the single form's — measured over the whole
> table, `range type = 3 − single type` — so the node maps the spec enum onto it.
>
> Needs the CNC's tool compensation option; without it the controller answers `EW_NOOPT`
> and the field is `null` with the reason in `errors`.

### Machine ID

```json
{
  "cncid": "3c7b5d01-56818a9a-be282789-6462c4fd",
  "cncid_values": [1014717697, 1451330202, 3190302601, 1684194557]
}
```

The CNC's own identity, read with `cnc_rdcncid`. This is the only identifier here that
survives a software upgrade, so a multi-machine flow should key on it rather than on
`series`/`version` — those are shared by every machine of the same model.

> **0i-D/F and 30i only.** On older series the controller answers `EW_FUNC` and the
> field is `null` with the reason in `errors`.

### Calendar

```json
{
  "year": 2026, "month": 11, "day": 13,
  "hour": 17, "minute": 18, "second": 26,
  "date": "2026-11-13", "time": "17:18:26",
  "iso_like": "2026-11-13T17:18:26"
}
```

Read with `cnc_gettimer`. Date and time are **two calls** — each fills only its own half
of the 12-byte reply, and the half that was not asked for keeps whatever was in the
buffer, so the node reads both and takes each from the call that asked for it.

> The CNC clock carries **no timezone**. `iso_like` has no `Z` and no offset on purpose:
> it is not UTC and not necessarily local time. Do not label it as either.

### Status Info (extended)

`cnc_statinfo2` — the same run state as **Status Info** plus `warning`, `o3d_check`,
`ext_option` and `restart`. The fields `cnc_statinfo` also reports (`mode`, `run_state`,
`motion`, `mstb`, `emergency`, `alarm`, `edit`) are labelled with the **same tables**, so
a flow can read either function and get the same strings. The four extra fields are raw:
their enums differ per series and nothing here interprets them.

> The reply is three sub-requests in one frame, and the assembly is not the C struct's
> field order: the first block starts at `aut`, and `hdck`/`tmmode` arrive in the second.
> Reading it in declaration order shifts every field by two and reports `run_state: "****"`
> on a machine that is running.

> **0i-D/F and 30i only.** On older series it answers `EW_FUNC`.

### Program Memory

```json
{
  "registered_programs": 0,
  "available_programs": 880,
  "used_memory": 179500,
  "unused_memory": 8309500,
  "used_percent": 2.1
}
```

`used_percent` is `null` when the total is zero — never `0 %`, which would read as
"empty" rather than "unknown".

> The wire is **four longs** — registered, available, used memory, unused memory — not the
> C `ODBNC` union's two shorts then two longs. Reading it the C way reports
> `registered_programs: 0` on a machine with 129 programs registered.

### Sequence Number and Block Counter

`sequence_number` is the N number of the block being executed. A program with no N
numbers leaves it at the last one it saw, so treat it as a progress hint, not an exact
position.

`block_count` needs the **program restarting** option; without it the controller answers
`EW_NOOPT` and the field is `null`.

### Modal / Commanded F,S,T

```json
{
  "block": "modal",
  "commands": {
    "F": { "value": 5000, "raw": 5000, "dec": 0, "address": "F", "number": 0 },
    "S": { "value": 1400, "raw": 1400, "dec": 0, "address": "S", "number": 0 },
    "T": { "value": 13,   "raw": 13,   "dec": 0, "address": "T", "number": 0 },
    "M1": { "value": 8,   "raw": 8,    "dec": 0, "address": "M", "number": 1 }
  }
}
```

Choose **Modal** for what is in effect or **Commanded** for what the current block asks
for. Only records the controller marks as present are included, so **a missing key means
"no command", not "zero"** — the distinction the rest of the payload keeps.

> **Not available on 16i/18i/21i.** Those need `cnc_modal`, which is a different struct
> and a different type enum; this node does not implement it.

### Work Zero Offsets

```json
{
  "use_no": 307,
  "axis_count": 5,
  "offsets": [
    { "number": 1, "values": {
        "1": { "value": -299.015, "raw": -299015, "dec": 3, "unit": 10 },
        "2": { "value": -199,     "raw": -199000, "dec": 3, "unit": 10 }
    } }
  ]
}
```

Read with `cnc_rdzofs`. **Read-only** — the node has no write path for offsets. An axis
the table does not have is `null`, not zero.

> The wire arguments are `(number, number, axis)`: the second slot **repeats** the offset
> number. Sending the C order `(number, axis, length)` is answered `EW_ATTRIB`, which is
> what made this look unimplementable until the capture showed the repeat.

### Maintenance Items

```json
{
  "items": [
    { "index": 1, "name": "Spindle oil", "type": 1,
      "total": 1000, "remain": 250, "stat": 0, "remain_percent": 25 }
  ]
}
```

The CNC's maintenance items 1–10. `total`/`remain` are in whatever unit `type` selects
and the interface does not return that unit, so the raw numbers are kept.
`remain_percent` is `null` when `total` is zero.

### PMC Read

Reads machine-builder signals straight out of the PMC — door interlocks, clamps,
cycle-complete, counters, whatever the ladder exposes. The address map belongs to the
machine builder, so nothing here interprets the values.

Give a comma-separated list of addresses (up to 128):

```
R0.0            one bit of R0
R0              R0 as a byte
D100:word       D100 as a 16-bit word
D100:long       D100 as a 32-bit long
K0.0            one bit of K0
```

Areas: `G F Y X A R T K C D`.

```json
{
  "values": [
    { "spec": "R0.0", "area": "R", "address": 0, "bit": 0, "value": 0, "byte": 20 },
    { "spec": "D100:word", "area": "D", "address": 100, "bit": null,
      "type": "word", "value": 1314, "hex": "0x0522" }
  ]
}
```

> **Read-only.** There is no PMC write path in this node.
>
> The byte path is **little-endian within each 2-byte word**: reading the same 8 bytes
> three ways on a 31i gave `22 05 03 14 …` as bytes, `05 22 14 03 …` as words and
> `14 03 05 22 …` as longs. The node reads at byte width and assembles wider values
> itself, so there is one ordering rule rather than three.
>
> The command pair is **2/1**, not 1/1 — the second word is a path/unit selector, and
> sending 1/2 is answered `EW_PATH` for a function that has no path argument.

### Series support

The identity and context functions are not on every series. From each function's vendor
support table — and this node is Ethernet-only, so "HSSB only" and "cannot be used" both
mean *not on this machine*:

| Function | Available on |
|---|---|
| Machine ID, Status Info (extended) | 0i-D/F, 30i |
| Maintenance Items | 16i-B and later |
| Modal / Commanded F,S,T | 15i, 0i-D/F, 30i (not 16i/18i/21i) |
| Everything else here | 15i and later, but HSSB-only on the non-i series |

A function the series does not have answers `EW_FUNC` or `EW_NODLL`. In `All Data` that
becomes a `null` field plus an `errors` entry, so it never blanks the rest of the
snapshot — but on an older machine it costs a round trip per poll. Use the individual
functions for a mixed fleet.

### Partial failures — All Data

`All Data` reads every field independently, so one failing function degrades **only that field**
instead of blanking the whole snapshot:

```json
{
  "machine_state": { "mode": "MEMory", "run_state": "STaRt", "alarm": null, "...": "..." },
  "active_alarms": null,
  "timestamp": "2026-05-28T07:35:23.213Z"
}
```

The payload carries **no error channel** — it is pure data, so it can be mapped straight onto
OPC UA, MQTT or a database without filtering out a diagnostic key. The rules:

- A field that could not be read is **`null`**. The reason is written to the **Node-RED log**
  as a warning (`all: active_alarms could not be read — cnc_rdalmmsg: CNC returned EW_NOOPT (6)`),
  so it is still recoverable from the log without polluting the payload.
- `null` means **not read**; `[]` means **read cleanly, found nothing**; a number means the
  controller reported that number. The three are deliberately distinguishable.
- `axes_data` and `tool_life` are each **one field**: every sub-read they make is part of the
  same key, so a single failure degrades the whole block to `null`. On a machine without the
  tool-life option that is how `tool_life` reads.
- `tool_offsets` is one field too, and degrades the same way — on a machine without the
  tool-compensation option it is `null`.
- `active_alarms` is **`null` when the alarm read failed** and **`[]` when the controller
  answered but has no active alarms**.
- The three alarm fields are **three independent reads** (`cnc_rdalmmsg`, `cnc_alarm2`,
  `pmc_rdalmmsg`), so one can fail, or be empty, while the others are fine — a PMC fault does
  not blank the NC messages and vice versa.
- Only the other **Functions** (single-value polls) raise. If you want a failure to be visible
  as a node error rather than a degraded payload, poll `Alarm Messages` on its own.

---

## Example Payload — All Data

```json
{
  "controller": {
    "cnc_type": "31",
    "mt_type": "M",
    "series": "G40A",
    "version": "37.0",
    "axes": 5,
    "max_axes": 32
  },
  "machine_state": {
    "mode": "MEMory",
    "run_state": "STaRt",
    "motion": "Moving",
    "mstb": "Inactive",
    "emergency": null,
    "alarm": null,
    "edit": "Inactive"
  },
  "active_program": {
    "running_program": "O8888",
    "main_program": "O8888",
    "running_comment": "DRIVING BAND TURNING",
    "main_comment": "DRIVING BAND TURNING"
  },
  "timers": {
    "power_on_time":       { "total_seconds": 810844,    "formatted": "225h 14m" },
    "auto_operation_time": { "total_seconds": 183989.237,"formatted": "51h 06m 29.237s" },
    "cutting_time":        { "total_seconds": 53594.237, "formatted": "14h 53m 14.237s" },
    "cycle_time":          { "total_seconds": 47.123,    "formatted": "0h 00m 47.123s" }
  },
  "part_count": {
    "required_parts": 500,
    "lifetime_total": 488584
  },
  "feedrate_spindle": {
    "actual_feedrate_mm_min": 24000,
    "actual_spindle_rpm": 101
  },
  "axes_data": {
    "absolute_position": { "ABS": [0, 0, 0] },
    "machine_position": { "REF": [0, 0, 0] },
    "relative_position": { "REL": [0, 0, 0] },
    "distance_to_go": { "DIST": [0, 0, 0] },
    "servo_load_percent": [12, 7, 31],
    "servo_load_axes": ["X", "Y", "Z"],
    "spindle_load_percent": 4,
    "spindle_load_percents": [4],
    "spindle_load_names": ["S"],
    "servo_load_current_amps": [1.85, 0.42, 3.07]
  },
  "tool_life": {
    "group_count": 3,
    "max_group": 128,
    "max_tool": 24,
    "max_minute": 9999,
    "max_cycle": 9999,
    "using_group": 2,
    "next_group": 3,
    "selected_group": 2,
    "groups": [
      { "group": 1, "tool_count": 6, "life": 500, "counter": 412, "remaining": 88,
        "usage_percent": 82.4, "count_type": 0, "unit": "count", "in_use": false,
        "life_rest_raw": 0 }
    ],
    "most_used_group": 1
  },
  "tool_offsets": {
    "ofs_type": 0,
    "memory": "memory A",
    "use_no": 99,
    "types": [
      { "type": 0, "label": "cutter radius wear" },
      { "type": 1, "label": "cutter radius geometry" },
      { "type": 2, "label": "tool length wear" },
      { "type": 3, "label": "tool length geometry" }
    ],
    "offsets": [
      { "number": 1, "values": {
          "0": { "label": "cutter radius wear",     "value": 0,       "raw": 0,      "dec": 3 },
          "1": { "label": "cutter radius geometry", "value": 0,       "raw": 0,      "dec": 3 },
          "2": { "label": "tool length wear",       "value": 0.08,    "raw": 80,     "dec": 3 },
          "3": { "label": "tool length geometry",   "value": 129.907, "raw": 129907, "dec": 3 } } }
    ]
  },
  "active_alarms": [],
  "alarm_status": { "status": 0, "bits": [] },
  "pmc_alarms": [],
  "timestamp": "2026-05-28T07:35:23.213Z"
}
```

With an alarm present, `active_alarms` fills in:

```json
  "active_alarms": [
    {
      "type": "Parameter switch on (SW)",
      "type_code": 0,
      "code": 100,
      "axis": 0,
      "text": "PARAMETER ENABLE SWITCH ON"
    }
  ],
  "alarm_status": {
    "status": 1,
    "bits": [ { "bit": 0, "label": "Parameter switch on (SW)" } ]
  },
  "pmc_alarms": [],
  "timestamp": "2026-05-28T07:35:23.213Z"
}
```

---

## Dynamic Override

You can override the configured function at runtime by setting properties on the incoming message:

| Property | Description | Example |
|----------|-------------|---------|
| `msg.function` | Override function | `"status_info"` |
| `msg.subtype` | Override axes sub-type | `"abs_pos"` |
| `msg.params` | Override parameter/macro numbers | `"6711,6712"` |

---

## run_state Values

| Value | Series 16/18/21/0i/30i | Series 15/15i |
|-------|------------------------|---------------|
| `****` | Reset / not in auto | — |
| `STOP` | Stopped in auto | Stopped |
| `HOLD` | Feed hold | Feed hold |
| `STaRt` | Auto running ✓ | Auto running |
| `MSTR` | Tool retract / MDI exec | M/S/T executing |

> **Note:** Series 16/18/21/0i/30i `run=0` means reset (not running), not STOP. Using the wrong table is a common source of misclassified machine states.

### motion and mstb Values

Both are enums, not booleans — collapsing them to a flag loses a state:

| Field | Value | Meaning |
|-------|-------|---------|
| `motion` | `Stopped` | `***` — no axis movement |
| | `Moving` | `MoTioN` |
| | `Dwelling` | `DWeLl` — a dwell is not movement |
| | `Waiting` | `Wait` (TT only) |
| `mstb` | `Inactive` | `***` — no M/S/T/B function |
| | `Finished` | `FIN` — the function has **finished**, not "is active" |

> `mstb = 1` means FIN, so it reads `Finished`. Labelling it "Active" inverts the meaning.

---

## Multiple Machines

Create one **FANUC Controller** config node per machine, each with its own IP address. Wire separate polling chains independently:

```
[Inject 2s] → [fanuc-focas · Lathe 1] → [OPC UA out]
[Inject 2s] → [fanuc-focas · Lathe 2] → [OPC UA out]
```

---

## Requirements

- Node.js ≥ 14.0.0
- Node-RED ≥ 2.0.0
- FOCAS Ethernet option enabled on the controller
- Network access to the controller on its FOCAS port (default 8193)

No additional npm dependencies — uses only Node.js built-ins (`net`, `Buffer`).

---

## Technical Notes

- **FOCAS is strictly sequential.** Each request must complete before the next is sent on the same TCP connection. This node correctly awaits each response before proceeding.
- **Connection per poll.** A new TCP connection is opened and cleanly closed for each poll cycle, matching the FOCAS session model.
- **The controller accepts only a few concurrent sessions** — 5 on the machine this was measured against. Each poll takes one, so polls that overlap are refused, and the node serialises them per node rather than letting a burst collide. A message that arrives while a poll is running waits its turn; nothing is dropped and no second session is opened. Running several nodes on one inject is fine for the same reason, but they queue behind each other.
- **A refused session says so.** When every slot is in use the controller answers with frame type `0x0103` instead of the usual open response, and the node reports it as `Open refused by controller — every FOCAS session is in use`, with the raw bytes, rather than the generic "Open handshake failed" that made this look like a network fault.
- The FOCAS wire protocol is reverse-engineered from [`diohpix/pyfanuc`](https://github.com/diohpix/pyfanuc) with several bug fixes applied (valtype-2 unpack, readparam3 fallback guard, statinfo cnctype matching).
- Wire behaviour is cross-checked against the FANUC FOCAS2 SDK (`docs/FANUC_Focas_API/`) — per-function specs in `Document/SpecE/Misc/`, status codes in `Document/SpecE/ERRCODE.HTM`.
- The load-meter function codes and their record layout were read off the official library's own traffic: `tools/probe-dll-opcode.py` drives the 64-bit SDK over a local TCP proxy and decodes the frames the vendor DLL puts on the wire, while `tools/probe-funcsupport.js` prints the whole opcode support map for a controller without needing the DLL. Guessing an opcode is what made the load meters silently report `null` — see `tools/verify-node-load.js`.
- Opcodes are **per-series**, not universal: `cnc_diagnoss` (0x30) answers `EW_FUNC` on a controller that does not implement it, and `cnc_rdparam3` uses a different code on 16i than on 30i/0i-D. Where a function is optional, the node reports the `EW_*` status instead of degrading to `null`.
- **The wire is not the C struct, and the argument order is not the C signature.** `cnc_rdparam3` sends `(number, number, axis)` and answers 8-byte records with the attribute at +6; `cnc_rdprogdir` sends `(start, count, format)` and answers 72-byte records; `cnc_rdmacro`'s second argument is an end number. All of it was pinned against captured traffic on 2026-11-12 and is written up in [`docs/notes.md`](docs/notes.md). `node tools/verify-decoders-offline.js` guards every decoder with the captured bytes and needs no hardware.
- **PMC calls use a different status table.** `ERRCODE.HTM` gives the PMC Data Window its own codes — `1` is `EW_NOPMC`, `3` is `EW_RANGE`, `4` is `EW_TYPE` — so a PMC failure is reported with the PMC name rather than the CNC one.
- The tool-life function codes were read off the vendor library the same way — `0x48` `cnc_rdusegrpid`, `0x4a` `cnc_rdngrp`, `0x1c1` `cnc_rdgrpinfo4`, `0x1c4` `cnc_rdtlinfo`. The wire offsets were then pinned against a controller with the option on (see [`docs/notes.md`](docs/notes.md)). `tools/verify-node-toollife-offline.js` guards the decode, the record model and the paging loop with **no hardware** (36 checks); `tools/verify-node-toollife.js` checks it end to end against a real controller.
- FOCAS errors are surfaced, not swallowed: a request that the CNC rejects raises (e.g. `cnc_rdalmmsg: CNC returned EW_ATTRIB (4)`). An empty array from `readalarmcode()` therefore means *no alarms*, nothing else.
- Measured limits of the controllers this has been run against, and the changes deliberately put off for now, are kept in [`docs/notes.md`](docs/notes.md).
- **The tier-1/2 reads were captured the same way.** `python tools/probe-dll-opcode.py --stub --tier12` puts the vendor library's requests on the wire with no controller attached, which is how `cnc_rdcncid` = `0x0e8`, `cnc_rdcommand` = `0x97`, `cnc_gettimer` = `0x45` and `pmc_rdpmcrng` = `0x8001` (pair **2/1**) were read off. The response layouts were then pinned against the 31i at `10.192.232.189` with `tools/probe-tier12-layout.js`, `tools/probe-tier12-verify.js` and `tools/probe-pmc-byteorder.js`. `tools/verify-tier12-offline.js` guards every decoder with those captured bytes and needs no hardware; `tools/verify-node-tier12.js` checks the same reads end to end against a real controller.
- **Two reads were deliberately left out.** `cnc_rdexecprog` (`0x20`) has its opcode captured but its spec page says the execution pointer moves to the next block under single-block operation, and that has not been disproved on a machine that could be watched — so it is not implemented. `cnc_rdopmsg3` (`0xd0`) answered the `cnc_sysinfo` block on every call regardless of its arguments, which is the signature of a wrong opcode, so it has no decoder either. Both are written up in [`docs/notes.md`](docs/notes.md).

---

## License

MIT
