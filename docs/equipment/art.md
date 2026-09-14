# Equipment art

The downloaded equipment models replace the procedural grenades, heal items and loot boxes. Everything here is optional at runtime: when `equipment/manifest.json` or one model fails to load, that item falls back to its procedural mesh (and the throw arms fall back to the pistol's frozen arms), so the game never depends on it.

Sources, sizes and licenses of the downloads: `assets-src/DOWNLOADS-2026-09-15.md`. Research and candidates: [../assets-research/equipment-environment-2026-09-15.md](../assets-research/equipment-environment-2026-09-15.md). Credits ship in `apps/client/public/assets/equipment/credits.json` and in the equipment manifest, so `AssetLibrary.requiredCredits` (the HUD credits list) includes them.

## Commands

| Command | What it does |
|---|---|
| `node tools/assets/equipment.ts` | Builds `apps/client/public/assets/equipment/` (13 models, the throw arms, `manifest.json`, `credits.json`). Flags: `--force`, `--only=frag,throw_arms`, `--textures=webp` (fast preview), `--timeout=S`. Run after `pnpm assets` (it reuses its decoders and texture cache). |
| `pnpm assets:verify` | Also checks the equipment files, decodes their KTX2 textures and runs the equipment runtime self-check. |
| `pnpm assets:analyze throw_arms` | Clip-boundary analysis of the throw arms (same method as the weapons). |
| `node --experimental-transform-types --no-warnings tools/assets/equipment/framing.ts` | First-person framing check. It drives the real `ThrowableViewmodel` headless through every throw and heal phase, CPU-skins the arms and rasterizes arms and item through the game camera (90° horizontal at 16:9, near 0.05 m). It fails on stretched skin, more than 25% coverage while holding (35% during the throw), an arm crossing the upper-left quadrant, a hand or item closer than 0.28 m, a grenade outside the lower-right quadrant, or an item less than 40% unoccluded by the fist. Flags: `--only=frag cooked,medkit`, `--tune=file.json` (try `poses`/`grips`/`clip` overrides), `--ascii=<sample>` (print the coverage mask). |

The build is incremental like `pnpm assets` (stamps in `node_modules/.cache/twobullets-assets/equipment/`, textures in the shared texture cache). A cold KTX2 build took about 3.5 minutes with one encoder worker; most of it is decoding and encoding the 4K sources. There is no root `package.json` script for it yet (`assets:equipment` would be the natural name).

## Outputs

| Model | File | Tris | Textures (px) | Size (m, x × y × z) | Source notes |
|---|---|---|---|---|---|
| `throw_arms` | 1.54 MB | 9,816 | color 2048, ORM 1024, normal 1024 | rig | DJMaesen "Arms throwing" |
| `frag` | 1.45 MB | 4,862 | color 2048, ORM 1024, normal 1024 | 0.059 × 0.089 × 0.063 | M67; exploded copy dropped; spoon and ring+pin separate; simplified from 5,046 to fit the 5k loot budget |
| `smoke` | 1.68 MB | 1,704 | color 2048, ORM 1024, normal 1024 | 0.065 × 0.145 × 0.063 | M18; 4K downscaled; normal green flipped (DirectX); single mesh, no separate spoon |
| `flash` | 1.59 MB | 3,808 | color 2048, ORM 1024, normal 1024 | 0.049 × 0.150 × 0.059 | M84; 4K downscaled; 2 scattered copies dropped; spoon and pin+ring separate |
| `molotov` | 0.82 MB | 4,522 | 2× color 2048, 2× ORM 1024 | 0.102 × 0.290 × 0.073 | flat normal map dropped |
| `bandage` | 0.81 MB | 2,588 | color 1024, ORM 1024, normal 1024 | 0.140 × 0.072 × 0.014 | flat vacuum pack; product label painted out |
| `first_aid` | 1.44 MB | 3,632 | color 1024, ORM 1024, normal 1024 | 0.137 × 0.190 × 0.124 | |
| `medkit` | 0.97 MB | 3,718 | color 1024, ORM 1024, normal 1024 | 0.400 × 0.074 × 0.267 | Poly Haven `medical_box` (CC0), scaled from 52.5 cm to 40 cm |
| `energy_drink` | 0.54 MB | 1,940 | color 1024, 2× ORM 1024, 2× normal 1024 | 0.073 × 0.168 × 0.073 | flat aluminium color folded into the factor |
| `painkiller` | 0.62 MB | 732 | color 1024, ORM 1024, normal 1024 | 0.047 × 0.085 × 0.047 | 4K downscaled |
| `helmet` | 0.51 MB | 4,242 | color 1024, ORM 512, normal 512 | 0.223 × 0.215 × 0.290 | BLEND → OPAQUE (the alpha only marks unused UV space) |
| `vest` | 0.28 MB | 2,960 | color 1024 | 0.447 × 0.500 × 0.402 | color map only; `KHR_materials_specular` removed, roughness 0.88 |
| `backpack` | 0.70 MB | 2,730 | 2× color 1024, 2× ORM 512, 2× normal 512 | 0.479 × 0.550 × 0.569 | spec/gloss → metal/rough |
| `ammo_can` | 0.40 MB | 1,998 | color 1024, ORM 512, normal 512 | 0.300 × 0.205 × 0.161 | skinned "Open_Close" can baked at its closed rest pose |

Total about 13.4 MB. Every GLB uses meshopt + quantization and KTX2 (ETC1S color/ORM, UASTC+zstd normals), like the weapons.

## Pipeline (`tools/assets/equipment/`)

- **`config.ts`**: one spec per model (source, which copy to keep, part patterns, rotation, real-world size, triangle budget, texture tier, fixes, credit), the throw-arms spec and clip table, and the credits.
- **`item.ts`** (static models):
  1. **Bake.** Every kept mesh node is baked into source world space (skinned meshes with linear-blend skinning at their rest pose). Vertex colours and second UV sets are dropped.
  2. **Item space.** The spec rotation is applied, the model is scaled so the chosen extent matches `size.meters`, and the origin moves to the body's bounding-box centre. +Y is up (a grenade's fuse axis) and +Z is the front.
  3. **Parts.** `spoon` and `ring` (the ring together with its pin) become child nodes of the root, each at its own centre. Everything else joins into `body`, merged by material.
  4. **Materials.** Spec/gloss becomes metal/rough (diffuse to base colour, roughness = 1 − glossiness, metalness 0), `KHR_materials_specular` goes, and flat textures fold into factors or disappear. DirectX normals get a green flip. Labels are painted out: light marks are masked, grown to swallow dark lettering inside banners, and filled by normalized blur plus borrowed grain.
  5. **Budget.** If the model is over its triangle budget, it is welded and simplified with meshoptimizer.
  6. **Compress.** KTX2 by tier, then meshopt.
- **Texture tiers.**

  | Tier | Used for | Color | ORM | Normal |
  |---|---|---|---|---|
  | held | throwables | 2K | 1K | 1K |
  | consumable | heal items | 1K | 1K | 1K |
  | gear | loot-only models | 1K | 512 | 512 |
  | arms | throw arms | 2K | 1K | 1K |

- **Budgets.** At most 10k triangles for the arms, and 5k for everything else, because the grenades also lie on the ground as loot.
- **`arms.ts`**: the same restructure as the weapons (a `throw_arms` root at 0.01 scale, wrappers removed), minus the IK `_Pole`/`_Goal` helpers. It adds a `grip` node under the right wrist: the centroid of the curled finger joints at the ready frame, with +Y from the little finger toward the index finger (out of the thumb side of the fist) and a 100× scale so its children are in meters. The Sketchfab GLB is the source; the original FBX holds the same single 21-frame clip (identical key times), skin and textures.
- **`verify.ts`**: file-level checks: hashes, meshopt, tier texture sizes and mips, metal/rough only, triangle budgets, sizes against the spec, part nodes, the arms' skin, clip order and release frame, and credits.

## Throw arms: clip phases

One baked clip, 21 frames at 30 fps (0.67 s). `pnpm assets:analyze throw_arms` finds no rest holds. Its edges are the wind-up peak (f3, the right shoulder at 62°), the release jump (f4–f5), the follow-through freeze (f5–f13) and the recovery. The fingers open from f3 to f5 and close again from f17 to f20.

| Clip | Frames | Content |
|---|---|---|
| `ready` | 0 | Grenade in the right fist, low right; left hand low left |
| `windup` | 0–3 | Right arm cocks up beside the head (the hand leaves the top of the view at f3) |
| `throw` | 3–5 | Forward swing; fingers open (`releaseFrame` 4.5) |
| `follow` | 5–13 | Arm extended, nearly still |
| `recover` | 13–20 | Arm returns near the ready pose (not identical: wrist ~16°, hand ~10 cm higher) |

## Driving the arms (`ThrowableViewmodel`, `HandsRig`)

The throw state is unchanged (`equipping` 0.5 s, `ready`, `primed`/`cooking`, `releasing` 0.35 s). Rig placement comes from springs toward `ARM_POSES` (camera space). The clip frame is set directly from the event timestamps:

| Phase | Clip | Procedural layer |
|---|---|---|
| Draw / put away | ready frame | **Procedural:** the rig springs in from below (`hidden` → `ready`), 0.28 s down. (The shotgun's hide/ready clips share bone names but hold a long gun; they'd need blending into the grenade grip, so they aren't used.) |
| Ready | ready frame | The rig sits 0.41 m out, and the right wrist turns −1.6 rad so the palm faces the camera. The item sits 2 cm out of the fist into the palm so it isn't hidden. Breathing sway |
| Pin pull (0.2 s) | ready frame | **Procedural:** the left arm swings in level (`pinPull`, yaw 0.5, no raise). Raising it brings the upper arm next to the camera as a band across the top left. The ring and pin follow the left hand, then vanish |
| Primed / cooking hold | f0.5, reached over 0.28 s | Cook tremble; the spoon flips off in the hand on cook. Holding deeper into the wind-up puts the fist above the view and 0.2 m from the lens |
| Underhand (aim held) | f0 | **Procedural:** right arm pitched down 0.12 rad (`cockUnderhand`); the release uses the same clip with the pitch springing back |
| Release (0.35 s) | hold frame → f5 over 0.10 s (rest of the wind-up and the throw), `follow` 0.09 s, `recover` 0.16 s | Rig kept 0.38–0.40 m out so the upper arm stays behind the camera; the item hides when the clip passes f4.5 |
| Item use | ready frame | The item in the fist low in front of the chest (`use`: root x −0.2, 0.41 m out, wrist −2.2), left hand in. Drinks and pills rise toward the mouth only between 55–92% (62–92% for pills) of the use, and stay 0.3 m from the lens. The medkit case rests flat on the fist like a tray |

Framing measured by `framing.ts` (NDC boxes, x right / y up, −1..1). The hip rifle, for reference, covers 11%.

| Phase | Coverage | Grenade/item box | Unoccluded | Nearest |
|---|---|---|---|---|
| Ready / pin pull (frag) | 13% / 10% | x 0.29..0.49, y −0.53..−0.10 | 87% | hand 0.29 m |
| Cook hold (frag) | 11% | x 0.31..0.51, y −0.23..0.14 | 88% | 0.30 m |
| Release (all kinds) | 8–21% | none in the upper-left quadrant | – | 0.28 m |
| Heal (bandage, first aid, medkit, energy drink, pills) | 6–19% | centres below the middle | 56–84% | item 0.33–0.37 m |

Across every frame of every phase: at most 21% coverage, and no vertex further than 1.2 m.

**DEV live tuning.** `__twobullets.presentation.equipment.hands.poses` (per-pose position, rotation, left, right, wrist), `.grips` (item placement in the fist) and `.clip` (hold frames and segment seconds).

**Thrown grenades** (`ThrowableRenderer`) are the baked body without pin, ring or spoon, thin-instanced as before. Rolling radius and the molotov rag tip are measured from the model. With a separate spoon (frag, flashbang), an uncooked grenade pops its spoon at launch: a thin-instanced lever tumbling off sideways for 0.8 s.

**Loot.**
- Grenades and bottles lie on their side, packs lie flat, and the medkit case lies as modelled (`LOOT_REST` in `itemMeshes.ts`).
- The helmet sits on its rim and the ammo can stands upright.
- The vest lies on its back and the backpack on its harness. Both are flattened (×0.4, ×0.55) because the models keep their worn, filled shape.
- One model serves every armor level. Level 1 is tinted tan, level 2 olive, and level 3 keeps the model's own colours. Ammo cans are tinted per calibre.

## Known issues

- **The "stretched skin" band was the arms next to the lens, not a skinning fault.** With the rig 0.2–0.28 m out, a raised left arm (pin pull) or the throwing arm's upper arm crossed just in front of the near plane and projected as a huge band to the top left. The sweep found no skinned vertex further than 1.2 m from the camera in any frame. The fix is the framing above, and `framing.ts` guards it.
- **Framed headless.** The numbers are checked by projection, not in a rendered frame. Lighting, and how far the grenade sits proud of the fingers, still need a look.
- **M18 normal flip.** It follows the research note (DirectX) and hasn't been checked against lighting. If the bumps look inverted, drop `flipNormalGreen`.
- **Tints above 1.** The level tints brighten dark textures with albedo multipliers above 1, which isn't physically based. Check them under the HDRI.
- **No M18 spoon.** The M18 has no separate spoon, so no lever flies off smoke grenades.
- **Recover pop.** The recover clip ends about 10 cm above the ready pose. It is hidden by the put-away or the next draw spring.
