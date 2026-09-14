# ADR 0202: 60 Hz simulation, 60 Hz redundant input, 60 Hz adaptive snapshots

- Status: Proposed
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §2, §4, §5.4, §11](../netcode.md#2-tick-input-and-snapshot-rates); Platform Q6

## Context

- `SIMULATION.tickRate` is 60. Weapon timers (`TIMER_EPSILON`, RPM overshoot) and client prediction are tuned for it.
- 10 players make bandwidth cheap. Peeker's advantage and hit-confirm latency are what players feel.
- Measured with `tools/bench/netcode/snapshot-codec.mjs` (10 players, per-recipient deltas, 2% loss, RTT 30–200 ms):

| Snapshot rate | Mean payload | kbps down per client (WebTransport IPv4) |
|---|---|---|
| 60 Hz | 108 B | 80 |
| 30 Hz | 112 B | 41 |
| 20 Hz | 119 B | 28 |

- Input datagrams: 15–43 B for 1–5 inputs → ~45 kbps up.

## Decision

- **Server sim:** 60 Hz fixed tick, no sub-stepping.
- **Client input:** one datagram per client tick (60 Hz), carrying all inputs not yet acked, capped at 6.
- **Snapshots:** per client at **60 Hz** by default.
  - Lowered to 30 Hz (then 20 Hz) on sustained loss > 10%, datagram congestion or WSS backlog.
  - Raised again after 5 s clean.
  - Warmup 30 Hz; landing selection and end 10 Hz.
- **Interpolation delay:** adaptive: `interval × (1 + lossCushion) + 2.5σ + 1 ms`, clamp [25, 150] ms.
- **Budgets per client:**
  - down 80–90 kbps typical, 160 kbps p99
  - up 45 kbps typical, 64 kbps p99
  - ~75 MB server egress per 12-minute match

## Consequences

- Peeker's advantage at 60 ms RTT: **~111 ms at 60 Hz vs ~136 ms at 30 Hz** (netcode.md §5.4).
- Hit confirms arrive ~RTT + 23 ms after the local tracer at any distance.
- Server encode cost ≈ 2 µs per client per snapshot (prototype): 0.12 ms per tick for 10 clients.
- Egress is double that of 30 Hz. At Platform's hosting (unmetered OVH; $0.10/GB on Edgegap burst) that is ≈ $0.0075 per burst match.

## Alternatives considered

- **30 Hz sim with 2× sub-steps.** Same CPU, worse input granularity, and prediction would need matching sub-steps. Rejected.
- **128 Hz.** Doubles CPU for little gain with projectile weapons and browser frame jitter. Rejected.
- **30 Hz snapshots fixed.** Saves ~40 kbps per client but adds ~25 ms peeker's advantage. Kept as the adaptive fallback.
- **Batched 30 Hz input.** Saves ~20 kbps up, adds ~8 ms average input delay. Rejected.
