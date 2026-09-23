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