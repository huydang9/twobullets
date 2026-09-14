# ADR 0304: Drift-free hybrid tick scheduler with catch-up; pin match processes with cpusets, never CPU quotas

- Status: Proposed
- Date: 2026-09-14
- Owner: Server Runtime & Performance Engineer
- Related: [runtime-performance.md §2.8, §3.3–3.5](../runtime-performance.md#34-tick-scheduling), Netcode A2, Platform A3 and Q11, ADR 0303

## Context

Tick-start lateness at 60 Hz with 1 ms of work per tick (Node 24.19, macOS):

| Strategy | Lateness p50 / p99 / max | Thread CPU |
|---|---|---|
| `setInterval` | Drifts 430 ms in 8 s | 6.4% |
| Re-armed `setTimeout` | Drifts 914 ms | 6.2% |
| Absolute-deadline `setTimeout` | 1.17 / 8.35 / 58.7 ms | 6.3% |
| Hybrid, 1 ms `setImmediate` spin | 0.39 / 1.35 / 2.1 ms | 7.5% |
| Hybrid, 2 ms spin | 0.011 / 0.38 / 10.7 ms | 8.4% |
| Pure spin | 0.010 / 0.12 / 1.2 ms | 23.7% |

- libuv timers have millisecond resolution, and Linux adds timer slack.
- A 60 Hz process that is idle most of the time pays 3–4× more per tick than a busy core (see ADR 0303).
- Under CFS quotas, a GC or JIT burst can stall a process for most of the 100 ms quota period.

## Decision

1. The scheduler targets **absolute deadlines** `t0 + n·period`. It sleeps with `setTimeout` until `spinMs` before the deadline, then yields with `setImmediate` until the deadline.
   - `spinMs` = 1 ms in single-match processes and 2 ms in packed workers.
   - `setInterval` and relative `setTimeout` are banned for ticking.
2. **Catch-up:** when a tick finishes late, the next one runs immediately. Tick numbers are never skipped (Netcode A2). After more than 250 ms behind (e.g. a VM stall), emit a `hitch` event so netcode can resync clocks.
3. Tick order: drain bounded input rings → simulate all matches → hit registration → build and encode snapshots → hand datagrams to the transport → record metrics. No `await` inside a tick.
4. **Metrics per match:** lateness and work histograms, overruns and hitches. SLO: lateness p99 ≤ 2 ms and work p99 ≤ 4 ms. The host allocator stops placing matches on a host that breaches it.
5. **Host policy:**
   - pin match processes and workers with **cpusets** (`taskset`, cgroup v2 `cpuset.cpus`), both SMT siblings together;
   - **no `cpu.max` quota below 0.5 vCPU** for match containers;
   - `performance` cpufreq governor, limited deep C-states, NIC IRQs off sim cores.

## Consequences

- Sub-millisecond tick-start precision costs about 1–2% of a core per process.
- Across 30+ processes that adds up to a fraction of a core per host. This is one of the reasons to prefer packing at scale.
- Fractional-vCPU burst offerings need ≥ 0.5 vCPU (answers Platform Q11), which raises burst cost.

## Alternatives considered

| Option | Why not |
|---|---|
| `setInterval` | Drifts |
| Absolute-deadline timers without a spin | 8 ms p99 lateness on macOS; better on Linux but still ≥ 1 ms |
| Busy spin | 24% of a core per process doing nothing |
| Native high-resolution timer addon / `Atomics.wait` with a timeout on a worker | Possible later for packed workers (blocks the worker, so messages must go through SAB rings); not needed at measured precision |
