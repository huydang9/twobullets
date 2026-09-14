# ADR 0205: Server-simulated projectiles tested against hitboxes rewound by the shooter's view delay, capped at 200 ms

- Status: Proposed
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §5](../netcode.md#5-hit-registration-with-projectiles), ADR 0206, `tools/bench/netcode/lagcomp.mjs`; Platform Q7

## Context

- Weapons fire simulated projectiles with drop (350–900 m/s, up to 2.5 s of flight), not hitscan.
- Shooters see remote players in the past (interpolation delay) and act in the future (prediction lead).
- Without compensation, a 60 ms player must lead moving targets by ~100 ms. With unbounded compensation, victims die behind cover.
- The shared weapon step derives pellet directions from `shotCounter`, so the server can recompute exactly what the client fired, given the same quantized aim.

## Decision

1. The server spawns authoritative projectiles from its own `stepWeapon` at the input tick `T`. The client sends no hit data.
2. Each tick `T+k`, every projectile segment is tested against player hitboxes **sampled at `T + k − D`** (fractional ticks, lerped between stored poses), plus one Havok ray against the static world. Nearest hit wins.
3. `D` = the shooter's view delay:
   - On fire and throw inputs the client sends it as `viewOffset` (1/8 tick).
   - The server clamps it to `expected ± 2 ticks`, where `expected = (RTT_ewma + inputBuffer + clamped interpDelay)/Δ`, and then to **`MAX_REWIND = 200 ms`**. Clamp events go to telemetry.
4. The rewind offset is constant for a projectile's whole flight, so **history depth depends on `MAX_REWIND`, not flight time**. Ring of 32 ticks (533 ms) of pose inputs per player (24 B each).
5. **Edge rules:**
   - Shots from a shooter dead at server tick `T` are rejected.
   - Bullets already in flight survive the shooter's death.
   - Victims dead at present server time take no damage.
   - Explosions, fire and zone use present time (no rewind).
6. Shotgun pellets are aggregated per (shotId, victim, tick) into one `HitConfirm` / `DamageTaken`.
7. **Client cosmetics:** tracer, world impacts and a subtle predicted body-hit sound immediately. Hitmarker, damage, blood and kill only on server confirmation.

## Consequences

- Full favor-the-shooter up to ~150 ms RTT (RTT + ~17 ms buffer + ~33 ms interpolation ≤ 200 ms). Higher-ping players lead by the excess.
- Hit-confirm latency ≈ RTT + 23 ms after the local tracer lands, independent of distance.
- **Cost (measured):** 0.7–0.84 µs per projectile-step including rewind sampling and broadphase against 9 targets; 0.13 ms/tick at 150 bullets in flight. The Havok world ray per segment (Runtime to measure) likely dominates.
- Backtracking cheats are bounded to ±2 ticks around the physically plausible delay. Aimbots remain a detection problem.
- Victims can be hit up to 200 ms + their own RTT/2 after reaching cover in their view.

## Alternatives considered

- **Client hit claims validated by the server.** Pixel-exact for the shooter but a larger cheat surface (fabricated claims within tolerances) and the same server history cost. Rejected as authority; its good part lives on as cosmetic prediction.
- **No rewind.** Unplayable leading at typical RTT. Rejected.
- **Rewinding the whole world per shot, hitscan-style.** Doesn't fit projectiles with flight time. Rejected.
- **Cap 100–150 ms.** Degrades 80–100 ms players in SEA. **Cap 300 ms+.** Frequent "died behind cover". 200 ms chosen; the ring supports tuning to 500 ms.
