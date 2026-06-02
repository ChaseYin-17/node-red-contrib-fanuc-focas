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
| **All Data** | Full combined snapshot | `controller`, `machine_state`, `active_program`, `timers`, `part_count`, `feedrate_spindle`, `active_alarms` |
| **Status Info** | Machine run state | `mode`, `run_state`, `motion`, `mstb`, `emergency`, `alarm`, `edit` |
| **System Info** | Controller identity | `cnc_type`, `mt_type`, `series`, `version`, `axes` |
| **Timers** | Accumulated time counters | `power_on_time`, `auto_operation_time`, `cutting_time`, `cycle_time` |
| **Axes Data** | Position / load / feed | See sub-types below |
| **Parameters** | Raw CNC parameters | `{ [param_number]: value, … }` |
| **Program Number** | Active program | `running_program`, `main_program`, `running_comment`, `main_comment` |
| **Part Count** | Parts produced | `required_parts`, `lifetime_total` |
| **Alarm Messages** | Active alarms | Array of `{ type, code, axis, text }` |
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

### Timer format

Each timer returns both a machine-readable value and a formatted string:

```json
"cutting_time": {
  "total_seconds": 53594.237,
  "formatted": "14h 53m 14.237s"
}
```

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
- The FOCAS wire protocol is reverse-engineered from [`diohpix/pyfanuc`](https://github.com/diohpix/pyfanuc) with several bug fixes applied (valtype-2 unpack, readparam3 fallback guard, statinfo cnctype matching).

---

## License

MIT
