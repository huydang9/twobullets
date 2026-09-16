# ADR 0207: Replicate enemies only when potentially visible or audible; audible-only enemies at reduced precision

- Status: Proposed
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §6.7, §9, §10](../netcode.md#67-priority-and-relevance), Riot's [Fog of War](https://technology.riotgames.com/news/demolishing-wallhacks-valorants-fog-war)

## Context

- With 10 players, bandwidth doesn't require interest management. Information exposure does: any enemy position in a snapshot is available to ESP/radar cheats regardless of rendering.
- The audio overhaul adds footsteps, gunshots, near-miss cracks, reloads, grenade pins and bounces, and explosions for remote players.
- Smoke grenades (35 s volumes) block vision but not bullets.
- Landing-spot selection would reveal every team's plan if broadcast.

## Decision

1. **Relevance per (viewer, enemy)**, evaluated server-side at 20 Hz:
   - **Full:**
     - potentially visible (Havok LOS rays from the viewer's eye and from the eye extrapolated 150 ms, to 5 points on the enemy's bounding capsule; analytic smoke volumes count as opaque)
     - or within 15 m
     - or visible within the last 500 ms
   - **Audible-only:** the enemy's current loudest noise radius covers the viewer. Radii come from shared data (crouch 8 m, walk 20, sprint 40, reload/heal 12, suppressed shot 150, rifle 800, explosion 300).
     - Sent as position at 0.5 m, noise class and stance.
     - No aim, weapon, health or equipment.
   - **Absent:** neither. No position, `Shot` or `PlayerHit` data at all.
   - Teammates and everyone during glide: always full.
   - Spectators: relevance from the spectated player's viewpoint.
2. **Audio:**
   - **Derived client-side** from replicated state: footsteps (with a client surface ray), jump/land, reload/equip/bolt, pin pull, heal, parachute, bounces (local throwable sim), near-miss cracks (local tracer sim from `Shot` events).
   - **Explicit events:** `Shot`/`AudioShot` (1 m precision when not visible), `PlayerHit`, `Detonate`, `AreaEffectStart`, `ZoneWarning`.
3. **Other information hiding:**
   - Landing choices go to teammates only.
   - Future zone centers are sent only when their phase starts, salted with a server secret.
   - Loot layout is seeded and public.
4. LOS work is capped at ~150 rays/tick with round-robin; no pair drops below 10 Hz.
5. **Phasing:** all-relevant in M3/M4 (correctness first); culling ships in M5 with leak and pop-in tests.

## Consequences

- Wallhacks and radar get only what the player could see or hear; audible-only data is too coarse to pre-aim.
- Pop-in risk at corners is managed by the lookahead eye, the 15 m radius and hysteresis; it must be tuned with playtests and a pop-in test bot.
- Server CPU: up to ~150 world rays per tick (Runtime budget A3).
- Clients can't compute audibility themselves; the audio mixer consumes whatever arrives, and noise radii live in shared data so mixing and relevance agree.

## Alternatives considered

- **Send everyone always.** Simplest; full ESP exposure. Rejected for competitive play after M4.
- **Distance-only culling.** Weak on a 1 km map with long sightlines and buildings. Rejected. *Superseded on 2026-09-16: the maps are now 500 × 500 m; the sightlines and the decision are unchanged.*
- **Client-side audibility decisions.** Trusting the client with data it shouldn't have. Rejected.
