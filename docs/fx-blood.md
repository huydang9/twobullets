# Blood hit effects

Realistic, PUBG-style feedback for bullets hitting characters. It replaces the old stylized burst, ring and model tint
("highlight"). The soldier's hit-reaction animation is unchanged.

Code: `apps/client/src/fx/BloodEffects.ts` (effects), `fx/bloodAtlas.ts` (procedural textures),
`fx/bloodSettings.ts` (switches), wired in `fx/WeaponPresentation.ts`.

## What a hit does

Every hit on a soldier bleeds: body (chest, abdomen, pelvis, neck), head and limbs. Hits on the same target within
one frame, such as shotgun pellets, merge into one burst. The burst is placed at the pellets' centroid and scales
gently with the pellet count (size +6% and density +15% per extra pellet, capped at 8), so a blast never stacks into
a blob.

| Part | What | Zone scaling |
|---|---|---|
| Core puff | One dense, short (0.2 s) mist sprite at the wound. It makes a hit read instantly, even on a limb or at range. | size ×1.35 head, ×1.1 body, ×0.85 limb |
| Mist | 2–8 soft sprites drifting along the bullet's exit direction (drag, slight sink), 0.45–0.8 s, plus a faint back-spatter toward the shooter. | count ×1.6 / ×1.2 / ×0.8 |
| Droplets | 6–26 velocity-aligned streaks. 80% fly out with the bullet in a cone, 20% splash back. Full gravity. | same density |
| Wall splatter | One ray (two on a kill or a 4+ pellet blast) along the bullet from the hit point, 2.5 m reach (3.2 m for head or sniper). On a hit, a splatter decal goes on the surface normal. It uses the directional spray variant, aligned with the bullet, at grazing angles; otherwise a round spatter or cluster with a random rotation. The decal grows with distance and appears after the drops' flight time. | size |
| Ground drip | One ray down (two on a kill) from just ahead of the hit. A splat decal lands after the free-fall time. | size |
| Wound | A small stain decal stored in the nearest hitbox bone's space, so it rides the animation, including the death fall. Up to 6 per soldier (oldest replaced), at most 2 per merged hit. Cleared when the soldier respawns. | half size 4.5 cm head and limb, 6 cm body |
| Kill | Burst size ×1.3 and density ×1.8, extra splatter and drip. After 0.6 s, a pool decal appears under the pelvis (one ray) and grows over 2.2 s with an ease-out, drifting with the settling body. It fades out over 0.5 s on respawn. | |

### Look

- Everything is alpha-blended (`ALPHA_COMBINE`), never additive. Colors are dark reds in display space, because the FX
  shader is unlit and writes after tone mapping, like the PBR output.
- Shading comes from the atlas RGB: thick blood is darker and thin spray is lighter. The texture is multiplied with
  the instance color.
- Light: one ray toward the sun per burst. Particles in shadow are drawn at 45% brightness. Decals additionally get a
  Lambert term from the surface normal, plus their own sun ray.
- Fog: the blood batches apply the scene's EXP2 fog, so distant puffs sit in the haze.
- Distance: mist sprites have a screen-size floor of 3 px (half size). A clamped sprite loses up to half its alpha
  instead of turning into a solid dot. A body hit at 150 m unscoped is still a 6 px puff, and much larger through a
  scope.
- Decals fade in over 60 ms, live for 26 s, and fade out over their last 6 s.

## Pools, caps and cost

| Pool | Cap | Recycling |
|---|---|---|
| Mist particles | 96 | oldest (closest to death) |
| Droplet particles | 192 | oldest |
| Splatter and drip decals | 48 | ring buffer |
| Death pools | 12 | a free slot, or the oldest |
| Wounds | 64 total, 6 per body | the body's oldest, or a free slot, or the oldest globally |
| Pending hits per frame | 8 targets | extra targets fold into the last slot |

- Draw calls: two thin-instanced meshes, `fx_bloodParticles` (288 instances) and `fx_bloodDecals` (124 instances),
  and one 1024×512 mipmapped RGBA atlas, about 2.7 MB of GPU memory. The draw calls happen only while something is visible.
- Havok rays: 3 for a typical hit (sun, splatter, drip) and at most 7 for a kill, plus 1–2 when a pool is placed.
  Rays skip hitbox triggers, blocker capsules and the local player's capsule. Each costs about 2–3 µs.
- CPU: the per-frame update does no allocation. This is verified headless with 288 live particles, 48 decals, pools and
  wounds.
  - Decals, wounds and particles push through `FxBatch.decalFrom` and `spriteFrom`/`streakFrom`, which read struct
    fields. Doubles passed to a call that V8 declines to inline are boxed, and that showed up as about 16 bytes per
    particle.
  - The same change fixed the existing sparks and dust: 928 live particles went from 15.6 KB to 0 per frame.
  - Spawning creates no objects. What remains is about 2 KB of transient number boxing per merged hit inside Babylon
    math calls. Havok's own raycast allocates about 2.8 KB per ray.

### Why FX quads, not `MeshBuilder.CreateDecal`

`CreateDecal` clips the target mesh's triangles into a new mesh for every decal. On terrain chunks and merged building
meshes that means thousands of triangles tested per hit, a fresh `Mesh` with GPU buffers per decal, and one draw call
each, or rebuilding a merged mesh.

A quad on the Havok hit normal costs nothing extra per decal, since it is already in the thin-instanced batch. The
trade-off is that a quad can overhang an outside corner or a sharp terrain crest, and it stays flat on curved
surfaces. Splatters are at most about 0.9 m across, so this is rare.

## Settings and DEV console

`fx/bloodSettings.ts`:

```ts
export const BLOOD_ENABLED = true;        // master switch
export const BLOOD_INTENSITY = 1;         // 0..2: counts, mist size/opacity, decal opacity, pool size
export const BLOOD_WOUNDS_ENABLED = true; // wound decals on the body
```

The live values are in `bloodSettings`. In the browser console (DEV builds):

```js
const p = __twobullets.presentation;
p.debugHit("body")              // blood 4 m ahead of the camera: mist, droplets, splatter on anything within reach behind, drip
p.debugHit("head", true)        // headshot kill burst (no body, so no wound or pool)
p.debugHit("limb", false, 60)   // limb hit 60 m out, checks the screen-size floor
p.debugBlood()                  // print settings and pool usage
p.debugBlood({ intensity: 0.5 })
p.debugBlood({ enabled: false })  // also clears everything on screen
p.debugBlood({ wounds: false })
__audio.impact("flesh", 10, 0, "head")  // the spatial flesh impact alone
```

For wounds and pools, shoot the practice soldiers.

## Sound

Target impacts play the spatial `impact.flesh` recording (Kenney, CC0) once per merged hit, separate from the
shooter's UI hit-confirm tick. The sound is shaped per zone in `GameAudio` (`FLESH_ZONE`):

- Head: pitched up 20%, at full gain, with a 12 ms high-passed noise snap on top.
- Body: gain 0.85.
- Limb: gain 0.7, pitched up 8%.

## Soldier side

- `SoldierCharacter` implements `BloodBody`:
  - `life` increments on `revive()`.
  - `pelvis` is the hips bone.
  - `woundBone(point, zone)` returns the bone of the nearest hitbox of that zone.
- The hit tint overlay (`overlayColor`/`renderOverlay`) is removed.
- `SoldierHitboxes` now refreshes the bone chain's world matrices every frame, even while disabled, so wounds follow a
  dead body. Previously the refresh stopped with the hitboxes. The cost is about 25 matrix updates per soldier.
- The bullet direction is taken from the camera to the hit point, since every shot is the local player's for now.
  Remote shots (M3) should pass their trajectory direction to `BloodEffects.hit`.
