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
| **All Data** | Full combined snapshot | `controller`, `machine_state`, `active_program`, `timers`, `part_count`, `feedrate_spindle`, `active_alarms`, `errors` |
| **Status Info** | Machine run state | `mode`, `run_state`, `motion`, `mstb`, `emergency`, `alarm`, `edit` |
| **System Info** | Controller identity | `cnc_type`, `mt_type`, `series`, `version`, `axes` |
| **Timers** | Accumulated time counters | `power_on_time`, `auto_operation_time`, `cutting_time`, `cycle_time` |
| **Axes Data** | Position / load / feed | See sub-types below |
| **Parameters** | Raw CNC parameters | `{ [param_number]: value, … }` |
| **Program Number** | Active program | `running_program`, `main_program`, `running_comment`, `main_comment` |
| **Part Count** | Parts produced | `required_parts`, `lifetime_total` |
| **Alarm Messages** | Active alarms | Array of `{ type, type_code, code, axis, text }` |
| **Macro** | Custom macro variables | `{ [macro_number]: value, … }` |

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
> Message text is limited to 32 characters by `cnc_rdalmmsg`; the 30i family is read with a
> 64-character field, falling back to 32 if the firmware rejects it.

When **Function** is `Alarm Messages` the payload is an **array**, with the poll timestamp
attached as a property (not visible when the array is JSON-serialised). Other functions return
an object containing `timestamp`.

### Partial failures — All Data

`All Data` reads every field independently, so one failing function degrades **only that field**
instead of blanking the whole snapshot:

```json
{
  "machine_state": { "mode": "MEMory", "run_state": "****", "alarm": "ALARM", "...": "..." },
  "active_alarms": null,
  "errors": {
    "active_alarms": "cnc_rdalmmsg: CNC returned EW_NOOPT (6) for type=-1"
  },
  "timestamp": "2026-05-28T07:35:23.213Z"
}
```

The rules:

- A field that could not be read is **`null`**, and the reason appears in `errors` under the
  same key (the field name, or `actual_feedrate_mm_min` / `actual_spindle_rpm` for the two
  feedrate-spindle values).
- `errors` is `{}` when every field read cleanly.
- `active_alarms` is **`null` when the alarm read failed** and **`[]` when the controller
  answered but has no active alarms** — the two are deliberately distinguishable.
- Only the other **Functions** (single-value polls) raise. If you want a failure to be visible
  as a node error rather than a degraded payload, poll `Alarm Messages` on its own.

---

## Example Payload — All Data

```json
{
  "controller": {
    "cnc_type": "0",
    "mt_type": "T",
    "series": "D6G3",
    "version": "29.0",
    "axes": 32
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
  "active_alarms": [],
  "errors": {},
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
  "errors": {},
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
- Wire behaviour is cross-checked against the FANUC FOCAS2 SDK (`lib/FOCAS2 Library/`) — per-function specs in `Document/SpecE/Misc/`, status codes in `Document/SpecE/ERRCODE.HTM`.
- The load-meter function codes and their record layout were read off the official library's own traffic: the 64-bit SDK is driven over a local TCP proxy and the frames the vendor DLL puts on the wire are decoded (`tools/probe-funcsupport.js` prints the whole opcode support map for a controller). Guessing an opcode is what made the load meters silently report `null` — see `tools/verify-node-load.js`.
- Opcodes are **per-series**, not universal: `cnc_diagnoss` (0x30) answers `EW_FUNC` on a controller that does not implement it, and `cnc_rdparam3` uses a different code on 16i than on 30i/0i-D. Where a function is optional, the node reports the `EW_*` status instead of degrading to `null`.
- FOCAS errors are surfaced, not swallowed: a request that the CNC rejects raises (e.g. `cnc_rdalmmsg: CNC returned EW_ATTRIB (4)`). An empty array from `readalarmcode()` therefore means *no alarms*, nothing else.
- Measured limits of the controllers this has been run against, and the changes deliberately put off for now, are kept in [`docs/notes.md`](docs/notes.md).

---

## License

MIT
