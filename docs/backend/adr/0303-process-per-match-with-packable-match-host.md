# ADR 0303: One OS process per match by default, with a `MatchHost` that can pack several matches per worker thread

- Status: Superseded by [ADR 0004](0004-match-process-model-and-packing-trigger.md)
- Date: 2026-09-14
- Owner: Server Runtime & Performance Engineer
- Related: [runtime-performance.md §2.7, §3](../runtime-performance.md#3-process-and-threading-model), Platform A1, A2 and §4.5, ADR 0304

## Context

Measured (M2 Pro, Node 24.19, worker threads loading a stripped-JS build):

- **Idle worker thread:** +15.8 MB RSS. **Worker with one match** (own Havok instance): +25–33 MB.
- **Extra match in the same worker:**
  - with its own static shapes: +2.3 MB WASM, +3.7 MB RSS;
  - with terrain and building shapes shared across Havok worlds: **+0.2 MB WASM**, 3–4 MB RSS.
- **WASM heap growth when packing:** 16.9 MB → 105 MB at 40 worlds with own shapes. It never shrinks.
- **Real time at 60 Hz, quiet host:** 1 match alone costs 1.66 ms per tick (cold core, low duty). Packed matches cost 0.39–0.45 ms each: 20 matches take 7.9 ms p50 and 9.7 ms p99, and **6 workers × 15 matches = 90 matches** run at work p99 11.5–12.3 ms.
- **Busy host:** the same 15–20 matches reached p99 of 48–97 ms.
- **`postMessage` latency** parent↔worker: p50 0.02–0.09 ms, p99 ≤ 0.3 ms (quiet).
- Platform plans one process per match, agent-supervised, on owned 6c/12t hosts with a warm pool.

## Decision

1. `apps/server-match` is built around a **`MatchHost`**. It creates matches, runs one tick scheduler over N matches (ADR 0304) and binds per-match transport sessions. The agent IPC (Platform A8) is the same in every mode.
2. **Default deployment, M3–M5: `--mode=single-match`**, one OS process per match (Platform A1). Simulation runs on the main thread. Transport starts on the same event loop and moves to a worker or sidecar if tick lateness requires it.
3. **Packed deployment: `--mode=packed --workers=W --matches-per-worker=K`**, with:
   - K ≤ 15 at 60 Hz as the starting cap (re-measure on target hardware);
   - one Havok instance per worker, with static level shapes shared across its worlds;
   - the heightfield loaded once per host into a `SharedArrayBuffer` for JS-side height queries;
   - transport terminated outside the sim workers and forwarded through bounded rings.
4. **Switch owned hosts to packed** when any of these holds: a host runs > ~60 matches, low-duty processes miss the lateness SLO, or warm-pool memory costs money. Burst providers use single-match with ≥ 0.5 vCPU, or packed when they bill by memory.
5. **Recycle packed workers** after 200 matches or when the WASM heap exceeds 256 MB, via drain.

## Consequences

- We keep Platform's isolation and operational simplicity now, and the code doesn't lock us in.
- Packing cuts memory per match by ~30× and gives busy cores that tick 3–4× cheaper per match. The cost is a larger blast radius: a worker crash or long GC hits K matches.
- A `MatchHost` abstraction and the scheduler must be written from the start (small).

## Alternatives considered

| Option | Why not |
|---|---|
| Worker per match only | Gives up process isolation without packing's savings |
| Packed only | Larger blast radius before we have crash data; Platform tooling assumes process per match |
| Several matches on the main event loop with I/O | Transport and GC jitter would land on every match's tick. Local dev only |
