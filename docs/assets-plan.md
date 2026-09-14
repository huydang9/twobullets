# Realistic asset plan (free only)

Researched 2026-09-14. Licenses were verified from each asset page or API at that time. Re-check the license on the page before downloading.

## Where to put files

- Put raw downloads (FBX, Blend, the original glTF from Sketchfab) in `assets-src/<category>/<asset-name>/`. This folder is gitignored: the files are large, and Mixamo's terms forbid redistributing raw files.
- Processed, compressed GLB/KTX2 files go in `apps/client/public/assets/`. The asset pipeline generates them.

## License rules

| License | Credit required | Notes |
|---|---|---|
| CC0 (Poly Haven, ambientCG, Free Firearm Sound Library) | No | No restrictions |
| CC-BY 4.0 (Sketchfab picks) | Yes | Show author, title, link and license on a credits screen |
| Mixamo | No | Ship characters and animations only converted and packed into our own GLBs, never the raw FBX files |
| Sonniss GDC bundle | No | Never ship the sounds as a separate sound pack |

## Starter set

### First-person arms and weapons

One artist, DJMaesen (@bumstrum), CC-BY 4.0. Free Sketchfab login required. Choose **Download 3D Model → glTF**, and also grab the original FBX if it's offered.

Each model has **one baked clip**, which gets split by frame range:

| Weapon | URL | Frame ranges |
|---|---|---|
| Rifle | https://sketchfab.com/3d-models/fps-animated-carbine-62977bb4c53047a185b9f3a0cdf56b87 | Not published; read them in Blender |
| Shotgun | https://sketchfab.com/3d-models/shotgun-animated-c3d3cf425869463a84d650c15e3af0d2 | Not published; read them in Blender |
| Pistol | https://sketchfab.com/3d-models/animated-pistol-bd896167e7ca44f19597d3afe6a8d83f | fire 0–11, reload 12–82, fire-last 83–94, reload-empty 95–175, hide 176–187, ready 187–233, idle 234–264 |
| Sniper | https://sketchfab.com/3d-models/sniper-animated-eae1ba5b43ae4bc89b0647fb5d8a2d27 | fire 0–11, bolt 12–60, reload 61–115, hide 116–127, ready 127–142, idle 143–165 |

- **License check:** another fp-arms upload by the same author is marked CC-BY-NC, while these weapon pages say CC-BY. That's fine for a hobby project. Confirm with the author before commercial release.
- **Don't mix these with haoliu95's 4K guns in first person.** Their detail level is very different.

### Third-person character (Mixamo, free Adobe ID)

1. **Character:** search **"Swat"**. Download FBX Binary, T-pose, **With Skin**.
2. **Animations:** FBX Binary, **Without Skin**, 30 fps, no keyframe reduction. Tick **In Place** for locomotion clips.

| Group | Clip names |
|---|---|
| Idle | Rifle Aiming Idle, Idle |
| Walk | Walk Forward / Backward / Left / Right, and the four diagonals |
| Run and sprint | Run Forward / Backward / Left / Right, Sprint Forward |
| Crouch | Idle Crouching, Walk Crouching Forward / Backward / Left / Right |
| Jump | Jump Up, Jump Loop, Jump Down |
| Fire and reload | Firing Rifle, Reloading |
| Hit and death | Hit Reaction, Death From The Front, Death From The Back |

Several Mixamo clips share a name. Pick the one whose description mentions a rifle.

### Environment (Poly Haven, CC0, no login; Claude can fetch these)

| Kind | Assets |
|---|---|
| Terrain | aerial_grass_rock, leafy_grass, forrest_ground_01, asphalt_02 |
| Surfaces | concrete_floor_worn_001, concrete_wall_008, weathered_planks, corrugated_iron_02, rusty_metal_02 |
| Sky and lighting | kloofendal_48d_partly_cloudy_puresky (HDRI) |
| Props | old_military_crate, wooden_military_crate, ammo_box, metal_jerrycan_green, Barrel_01, concrete_road_barrier_02 |
| Container | Shipping container by Sousinho (Sketchfab, CC-BY): https://sketchfab.com/3d-models/freight-shipping-container-rusted-2b787d1a02174d0bbca9eac34eb3a486 |

### Audio

| Library | URL | License |
|---|---|---|
| Free Firearm Sound Library | https://opengameart.org/content/the-free-firearm-sound-library | CC0, no login |
| Sonniss #GameAudioGDC bundle | https://sonniss.com/gameaudiogdc | Royalty-free; check the zip contents for guns and footsteps |

## Rejected (do not use)

- Cransh FP packs: they use bumstrum arms, which may be CC-BY-NC.
- 1Matzh "First Person Animations": the arms appear to be ripped from other games.
- dan741vlasov AKs-74u: sourced from GameBanana modders.
- 42manako KSK operator: ripped from Call to Arms.
- The Hugging Face Mixamo dataset: it redistributes raw Mixamo files.

## Risks

- **Mixamo characters** (2014–2018 quality) look older than Poly Haven's scanned environment. Grade everything under one HDRI and exposure, and use 1–2K textures.
- **Heavy models:** third-person soldiers at 80–100k triangles need decimation or LODs, plus meshopt/KTX2 compression.
- **Houses:** no clean-licensed free realistic enterable houses were found. We'll model simple houses in code or Blender and texture them with Poly Haven materials.
