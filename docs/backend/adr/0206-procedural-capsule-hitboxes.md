# ADR 0206: Networked player hitboxes are procedural shapes computed from replicated pose inputs, not bone-driven

- Status: Superseded by [ADR 0003](0003-hitbox-model-and-shared-hitbox-table.md)
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §5.3](../netcode.md#53-hitbox-history-storage), ADR 0205, `docs/assets-pipeline.md` (Mixamo SWAT, 69 bones), `apps/client/src/targets/soldierRig.ts` (`SOLDIER_HITBOXES`) and `SoldierHitboxes.ts`

## Context

- Remote players use an animated Mixamo soldier (69 bones, 20 clips, cross-faded `AnimationGroup`s whose weights depend on render timing).
- Rewinding bone-driven hitboxes would require the server to run skeletal animation for every player every tick and store bone transforms per tick.
- Client and server skeletons would still differ, because blend timing is frame-dependent.
- Babylon/Havok ANIMATED trigger bodies (used by dummies today) only become visible to ray casts after the next physics step (`HavokRaycaster.ts`). That adds a tick of lag and can't be rewound without re-stepping the world.
- While this ADR was written, the client team added bone-driven Havok hitboxes for the soldier dummy (`SoldierHitboxes.ts`). They place 13 shapes along bones: head sphere, neck capsule, chest/abdomen/pelvis boxes, and upper-arm, forearm, thigh and shin capsules. That's the right answer for a single-player dummy whose pose only exists on the rendering client, and its shape table is the best available description of the soldier's hittable volume.

## Decision

1. A pure function `poseHitboxes(pose) → shapes` in `packages/netcode/src/hitreg/rig.ts`.
   - Input: feet position, yaw, pitch, stance blend (and later lean/prone/downed).
   - Output: world-space shapes with zones that **mirror the 13 `SOLDIER_HITBOXES` entries** (same names, zones and sizes):
     - head sphere, neck capsule
     - chest/abdomen/pelvis boxes (body)
     - arm capsules pitched around the shoulder line with aim (limb)
     - leg capsules (limb)
   - Joint positions are fitted offline from the soldier's idle-aim and crouch-aim poses (a small script extends `assets:analyze` and emits the rig table). Stance blend lerps between fits.
   - The benchmark uses an 11-capsule approximation; boxes add a slab test at similar cost.
2. The server stores only pose inputs per tick (24 B per player; ring of 32 ticks) and poses capsules lazily after a bounding-capsule broadphase hit. Posed capsules are cached per (shooter rewind, target, tick).
3. **Hit tests are analytic** (ray-capsule, ray-sphere, ray-box) in TypeScript, not Havok queries. The static world still uses the Havok ray.
4. **The client uses the same rig** on interpolated remote poses, for cosmetic hit prediction and a debug overlay (`?debug=hitboxes`). The overlay draws the procedural shapes next to the bone-driven `SoldierHitboxes`, so drift is visible.
5. **Art constraint:** locomotion, aim offsets and reload animations must keep the mesh inside the capsules (±5 cm). The asset pipeline adds a check that samples clips and reports mesh-outside-capsule percentages, as an extension of `assets:verify`.
6. Offline dummies and practice ranges may keep bone-driven `SoldierHitboxes`; they aren't networked.

## Consequences

- Deterministic, cheap (measured < 1 µs per projectile-step including broadphase), rewindable and identical on server and client.
- Hitboxes don't follow every animation detail: an exaggerated lean or reload pose that moves the head outside the capsule won't be hittable there. Mitigated by the art check and slightly generous radii. Players in competitive shooters accept simple hitboxes when they're consistent.
- New stances (prone, downed, parachute) need rig variants — data, not code.
- Dummies can keep their Havok trigger hitboxes; players and dummies share the `Damageable` interface and the `SOLDIER_HITBOXES` table.
- The `SOLDIER_HITBOXES` table should move to `packages/shared` (it's data, with zones), so the server rig and the client both import it. That's a request to the client team, not an edit made here.

## Alternatives considered

- **Bone-driven capsules with server animation.** CPU for 10 skeletons at 60 Hz, larger history (≈ 15 bone matrices per tick), and client/server divergence anyway. Rejected.
- **Pre-baked per-clip tracks of the `SOLDIER_HITBOXES` shapes** (sample the bone-placed shapes offline per clip and normalized time). More faithful, but it needs deterministic locomotion and action blend weights replicated from the server. Kept as the first upgrade if playtests show hitbox complaints; the history ring would then also store blend parameters (~8 extra bytes per player per tick).
- **A single capsule per player + zone by hit height.** Too coarse for limb and head differentiation. Rejected.
