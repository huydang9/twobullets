# ADR 0004: One process per match at launch, a `MatchHost` that can pack matches from M3, and measured triggers for switching

- Status: Accepted
- Date: 2026-09-14
- Owner: Principal Architect
- Supersedes: [ADR 0303](0303-process-per-match-with-packable-match-host.md). Its architecture is kept; its switch triggers and prerequisites are replaced.
- Related: ADR 0001, ADR 0002, ADR 0304, ADR 0306; [runtime-performance.md §2.7, §3](../runtime-performance.md#3-process-and-threading-model), [platform.md §3.1, §4.3, §4.5](../platform.md#45-autoscaling-and-warm-pools)

## Context

- **ADR 0303** made single-match processes the default and packed workers an option. It named "host exceeds ~60 matches" as a trigger. On the planned OVH Advance-1 that trigger can never fire: 10 usable threads × 70% / 0.2 vCPU = 35 matches (ADR 0001).
- **Duty cycle:** the only measured evidence for packing is that a match ticked alone on a cold macOS core cost 1.66 ms, against 0.39–0.45 ms per match when 15–30 matches shared a busy thread (runtime-performance.md §2.7). How much of that 4× survives on a tuned Linux host (`performance` governor, limited C-states, cpusets) is unknown.
- **Transport:** packing needs transport terminated outside the sim workers (runtime-performance.md §3.2). That is the same component as the QUIC sidecar in ADR 0002 §4.
- **Platform tooling** (agent, warm pool, recycle-by-exit, crash abort) assumes a process per match (platform.md §3).

## Decision

1. **Launch default (M3 → public launch): `--mode=single-match`**, one OS process per match, on owned hosts and on burst hosts (≥ 0.5 vCPU, ADR 0001).
   - The simulation runs on the main thread.
   - Transport runs on the same event loop between ticks.
   - One tick scheduler per ADR 0304 (1 ms spin).

2. **Build `MatchHost` from M3** so packing is a deployment flag:
   - `createMatch(config) → Match`;
   - a scheduler over N matches;
   - per-match `Session` bindings;
   - identical agent IPC in every mode.

   CI runs `--mode=packed --workers=2 --matches-per-worker=2` in the integration suite, so the mode doesn't rot.

3. **Switch a region's owned hosts to `--mode=packed`** when a trigger in group A fires **and** every prerequisite in group B is met.

   **A. Triggers**
   - A1. **Measured gain:** on the production instance type at production load, packed mode fits ≥ 1.5× the matches per host of single-match mode within the ADR 0001 engineering budget, **and** the region runs ≥ 3 owned hosts (saving ≥ 1 box per month).
   - A2. **Lateness:** the lateness p99 ≤ 2 ms budget is missed on hosts below 70% CPU on 3 consecutive days, after host tuning (ADR 0304 §5) has been verified.
   - A3. **Big hosts:** moving to hosts with ≥ 32 threads, where more than ~100 processes per host make per-process timers, spin and memory a measurable fraction.
   - A4. **Burst billing:** a burst provider bills by memory or boot time such that packed containers are ≥ 30% cheaper per match-hour.

   **B. Prerequisites**
   - B1. Transport runs outside the sim workers: the QUIC sidecar (ADR 0002 §4) or a transport worker with `SharedArrayBuffer` input and output rings.
   - B2. Worker recycling: drain after 200 matches or when the Havok heap exceeds 256 MB (ADR 0303 §5).
   - B3. Blast-radius canary: 5% of hosts for 7 days with the match abort rate within 10% of baseline.
   - B4. The agent restores recycle-by-exit semantics per worker: nothing carries over between matches except shared static shapes.

4. **Starting packed caps:** K ≤ 15 matches per worker at 60 Hz, one worker per physical core (both SMT threads), static level shapes shared per worker, heightfield in a `SharedArrayBuffer` per host. Re-measure before production.

5. **Measurement cadence:** the M3 Linux re-measure (ADR 0001 §6) runs both modes with the same bot load and records matches per host at the engineering budget. The comparison is repeated each quarter and after every Node or Havok upgrade.

## Consequences

- **Launch:** keeps Platform's isolation, crash semantics and simple tooling. Costs ~200 MB per match and some duty-cycle CPU that packing could reclaim later. At launch scale that is below one box.
- **Switching** is a flag plus the sidecar, not a rewrite. The sidecar becomes the shared prerequisite for UDP 443 and for packing, which concentrates native-code risk in one component.
- **Blast radius:** packed mode puts a worker crash or long GC on up to 15 matches, so it is gated by a canary.

## Alternatives considered

- **Packed from day one.** Per-match CPU gains are unproven on Linux, blast radius grows before there is crash data, and packing requires the sidecar early. Rejected.
- **Worker thread per match.** Loses process isolation without packing's gains. Rejected (as in ADR 0303).
- **Never pack.** Leaves a measured 3–4× per-match CPU gain (on macOS) and ~30× memory gain unexploited at scale. Rejected.
