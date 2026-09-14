# ADR 0001: Reconciled capacity, bandwidth and cost baseline, with three tiers of tick targets

- Status: Accepted
- Date: 2026-09-14
- Owner: Principal Architect
- Related: [architecture.md §5–§6](../architecture.md#5-reconciled-numbers), ADR 0103, ADR 0202, ADR 0303 → [0004](0004-match-process-model-and-packing-trigger.md), ADR 0304, ADR 0305; [platform.md §4.6, §9.1](../platform.md#46-cost-model), [runtime-performance.md §2, §4](../runtime-performance.md#4-tick-budget-and-capacity-plan), [netcode.md §2.4](../netcode.md#24-bandwidth-maths-measured)
- Amends (does not supersede): the cost figures in ADR 0103 and platform.md §4.6; Runtime R4/R5 values (runtime-performance.md §8.1); Platform assumptions A2, A3 and A5 (platform.md §9.1).

## Context

The three specialist documents were written in parallel, so their planning numbers disagree:

| Quantity | Platform (assumed) | Runtime (measured/estimated) | Netcode (measured) |
|---|---|---|---|
| CPU per 10-player match | 0.25 / 0.5 vCPU | 0.15 / 0.25 vCPU | — |
| Memory per match process | 150–300 MB | ≤ 150 MB (est. 110–150) | — |
| Downstream per player | 40 kbps | uses Netcode's 85 kbps | 80 (combat) / 87 (glide) kbps, WebTransport IPv4, 60 Hz |
| Upstream per player | ≤ 30 kbps | — | 45 kbps typical, 64 p99 |
| Tick target | p99 ≤ 16.7 ms | work p99 ≤ 4 ms, lateness p99 ≤ 2 ms | total p99 ≤ 8 ms |
| Havok world ray | — | 1.5 µs | assumed 5–20 µs |
| Fractional vCPU on burst | fine down to 0.25 | ≥ 0.5 vCPU, no CFS quota below | — |

Checks made while merging:

- Runtime's real-time capacity runs (`tools/bench/runtime/lib/matchWorker.ts`) tick the **direct** minimal controller, not the Babylon `CharacterBody` the design keeps. The Babylon path adds about +0.16 ms per match-tick (`havok-tick-babylon-nohitbox.json` vs `havok-tick-direct-nohitbox.json`).
- The Babylon deep-import match measured 181 MB RSS after setup and 243 MB after warm-up, including about 40 MB of TypeScript stripping (`havok-tick-babylon-deep.json`, `startup.json`). That puts a bundled process at about 140–200 MB, above Runtime's 110–150 MB estimate. The scenario still built 200 Havok hitbox bodies and render meshes that the server won't have.
- Runtime §4.2 fits matches into 11 of 12 threads, while Runtime §3.3 reserves a full core (2 threads) for the agent, kernel and IRQs.
- Every CPU number comes from a swapping M2 Pro laptop. Tails and low-duty-cycle behaviour (1.66 ms per tick for an isolated match vs 0.39 ms packed) won't transfer to Linux x86.

## Decision

1. **Planning values** (re-measured on the first OVH Advance-1 during M3; see step 6):

   | Quantity | Low | **Plan** | High |
   |---|---|---|---|
   | CPU per full 10-player match, one process per match, SMT vCPU | 0.12 | **0.20** | 0.30 |
   | RSS per match process (bundled, deep imports, no Havok hitbox bodies) | 140 MB | **200 MB** | 256 MB (alert) |
   | Downstream per in-match player, mean | 60 kbps | **85 kbps** | 120 kbps |
   | Downstream p99 budget / upstream mean / upstream p99 | | **160 / 45 / 64 kbps** | |
   | Matches per OVH Advance-1 (10 threads × 70%) | 58 | **35** | 23 |
   | Peak concurrent matches | | **P / 7.5** (Platform's population model) | |

   Derivation of 0.20 vCPU: on an M2 P-core a typical match-tick costs ≈ 1.2 ms (sim ≈ 0.37 measured, netcode ≈ 0.2, transport ≈ 0.4–0.8 est., timer spin ≈ 0.2) and a heavy one ≈ 1.9 ms. Blend 70/30, multiply by 1.3 for the low-duty-cycle penalty, and divide by 0.6 for an SMT thread: ≈ 3.1 ms per 16.67 ms ≈ 0.18, **rounded up to 0.20**.

2. **Egress** is costed at 85 kbps: **38 MB per in-match player-hour**, or **12.3 GB per month per peak CCU** (with average CCU = 0.55 × peak and 80% of players in a match).

3. **Burst deployments request ≥ 0.5 vCPU per single-match container.** 0.25 vCPU is not allowed at 60 Hz (answers Platform Q11; agrees with ADR 0304). If `nr_throttled` exceeds 0.1% of periods in the Edgegap staging test, move to 1 vCPU.

4. **Owned vs burst break-even.** An Edgegap match-hour costs ≈ **$0.0575**: $0.0345 compute at 0.5 vCPU plus $0.023 egress for 6 players. Gameye costs ≈ $0.035 with egress included. A $136 box therefore pays for itself above **~3.2 average concurrent burst matches** in a region (Gameye: ~5.3). ADR 0103's buy rule ("burst spend > 60% of a box price") stays, and **burst spend includes egress**. Evaluating Gameye becomes a Phase 2 priority.

5. **Three tick-target tiers** replace the three conflicting targets:

   | Tier | Metric | Target | Used for |
   |---|---|---|---|
   | Engineering budget | work p99 per match-tick; start lateness p99 | **≤ 4 ms; ≤ 2 ms** on target hardware | CI gates, per-host admission control (stop allocating on breach) |
   | Player SLO | lateness + work, p99 per match-minute | **≤ 8 ms in ≥ 99% of match-minutes** | 30-day SLO |
   | Page | host tick-end p99 | **> 16.7 ms for 5 min** | On-call alert; players feel it at this point |

6. **Re-measure before Phase 1 exit** on an OVH Advance-1 (Linux, pinned, `performance` governor), using the commands in runtime-performance.md Appendix A.4 plus the M3 transport soak. The measurements replace:
   - the 0.6× SMT conversion;
   - the 1.3× duty-cycle penalty;
   - transport CPU;
   - RSS;
   - matches per host.

   Capacity per host is **min(N at work p99 ≤ 4 ms and lateness p99 ≤ 2 ms, N at 70% CPU)**, not "N until p99 > 16.7 ms" (platform.md §7.5 scenario 1 is amended).

## Consequences

- Owned match compute at 1,000 peak CCU: 5 boxes ≈ **$680/month** (Platform had $816–1,360). At 10,000: 43 boxes ≈ **$5,848** (Platform had $6,800–13,328).
- Burst-only is now ≈ **$3,075/month at 1,000 CCU** (Platform had $1,501–2,424), because measured bandwidth doubles egress and the 0.5 vCPU floor doubles compute. That strengthens ADR 0103's owned-first choice.
- At 10k CCU, a hybrid with Edgegap burst (≈ $6.0k) costs about the same as owned-only (≈ $5.8k). Hybrid is justified by elasticity, not savings, unless the burst provider includes egress (Gameye hybrid ≈ $5.0k).
- Memory is not binding: 35 × 200 MB = 7 GB on a 32 GB host.
- Every number in this ADR is flagged "provisional until Linux re-measure". The cost table in architecture.md §5.5 carries a sensitivity table.

## Alternatives considered

- **Keep Platform's 40 kbps.** Contradicted by the measured codec (netcode.md §2.4). Rejected.
- **Plan at Runtime's 0.15 vCPU.** That figure is based on the direct controller and 11 threads, with transport unmeasured. Rejected as too optimistic for committing money. It remains inside the low/plan range.
- **Plan at 30 Hz snapshots to halve bandwidth.** Bandwidth is free on owned hosts. The 25 ms of extra peeker's advantage costs more than egress saves (ADR 0202). Rejected; 30/20 Hz remain adaptive fallbacks.
- **A single tick target.** 16.7 ms is too late for admission control, and 4 ms is too strict for a player SLO. Rejected in favour of the three tiers.
