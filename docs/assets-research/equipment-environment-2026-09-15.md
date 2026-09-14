# twobullets equipment and environment assets: vetted shortlist (research only)

**How this was checked**
- **Sketchfab:** every model was checked against the public API (`api.sketchfab.com/v3/models/<uid>`) and `sketchfab.com/i/models/<uid>` on 2026-09-15. That covers license label, downloadability, triangle count (`metadata.totalTriangle`, which equals `faceCount`), rig and clip count, and the original texture sizes.
- **Poly Haven:** checked via `api.polyhaven.com/assets` and `/files`, including real-world size.
- **Mixamo:** checked against the live catalog API. Names, durations and In Place flags are all verified.
- **Looks:** I judged realism from Sketchfab thumbnails wherever the API allowed. It rate-limited me (HTTP 429) near the end, so a few picks are marked "thumbnail not reviewed".
- **Nothing went into the repo.** The VFX research agent unpacked a few CC0 archives in the scratchpad to read sheet layouts and alpha.

**Logins:** Sketchfab downloads need a free account. Mixamo needs an Adobe login. Poly Haven, ambientCG, the Unity Labs flipbooks and Kenney need none.

---

## 1. First-person grenade throw animations (top priority)

**Key finding:** DJMaesen (@bumstrum) published **three rigged, animated "throwing" FP arms**, all CC-BY and downloadable. What each one contains:
- **Arms only.** Each has one material and only `arm*` textures, so there is **no grenade mesh**. You attach your grenade to the hand bone.
- **One baked clip.** None of the descriptions give frame ranges, so split it with `pnpm assets:analyze`.
- **Small files.** The source is `source/arms@throwing.fbx`, about 0.7 MB.

| Name | URL | License | Tris / textures | Clips | Style match |
|---|---|---|---|---|---|
| **Arms throwing** (2019-06-16) | https://sketchfab.com/3d-models/arms-throwing-1f9a5c717aae4d0f9b77232b7da4b875 | CC Attribution | 9,816 / 4× 2K (color, smoothness, normal, AO) | 1 baked clip ("throwing stuff (like a grenade)") | **Best match.** Black leather gloves, bare forearm, olive sleeve, the same arms as our **shotgun** (published the same day, same texture set). |
| **FPS arms throwing** (2020-04-25) | https://sketchfab.com/3d-models/fps-arms-throwing-9556627e4b704063aee5a410e7e7de26 | CC Attribution | 7,552 / 5× 2K metal-rough | 1 clip | Probably the tan fingerless-glove arms from his 2020 knife. Its thumbnail doesn't render, so this is a guess from the texture colours. Not a match for our four guns. |
| **Fps Arms throwing** (2020-02-15) | https://sketchfab.com/3d-models/fps-arms-throwing-99ff0b0e5b144cbfbf67cb34f8ce83bb | CC Attribution | 9,900 / 4× 2K | 1 clip | Brown leather gloves. Weaker match. |

**Other DJMaesen gear:**
- **Usable (CC-BY):**
  - knife animated ([e5db6b73](https://sketchfab.com/3d-models/knife-animated-e5db6b73878f4123baa48cea6d9af84c), 11.5k): black gloves, the shotgun arms again.
  - Knife Animated ([f3140db9](https://sketchfab.com/3d-models/knife-animated-f3140db917cc43389c14b5b2536c1dc8), 16.5k): dark sleeve arms like the carbine and pistol.
  - Knife animated ([5f83f0bd](https://sketchfab.com/3d-models/knife-animated-5f83f0bd4b2c429aa14aa46461efe404), 9.2k): tan fingerless gloves.
  - Syringe, static ([cdcc401b](https://sketchfab.com/3d-models/syringe-cdcc401bf48d42e3895965d52eb2f3d8), 2.7k, 2K).
  - Ammo & healthbox, static ([0195d3e4](https://sketchfab.com/3d-models/ammo-healthbox-0195d3e483e94f68964bbfa1ebb5c6f5), 2.2k, 2K). Stylised game pickups rather than realistic.
- **Rejected:**
  - "syringe health shot" (animated healing): **Standard license, not downloadable**.
  - "syringeshot": **Editorial**.
  - "grenadier animated": **Editorial**.
  - "FPS Arms gloved" and "FP Arms" (8416c380): **CC-BY-NC**.
- He has no bandage or medkit FP animations.

**Other artists (checked):**
- "Medical syringe healing FPS Animation" by BURNER (@Alexander_Ovelar):
  - Link: [8de32be8](https://sketchfab.com/3d-models/medical-syringe-healing-fps-animation-8de32be8633a4c87ba7ed1d125b45ec9)
  - CC-BY, 12k tris, rigged, 1 clip, 4K arm textures.
  - **Bare pink stylised arms**, a poor style match. Only worth using for the timing reference.
- ccransh FP packs: rejected, because they reuse CC-BY-NC arms (known from earlier work).
- Nothing else found: no free CC-BY/CC0 FP grenade clip set with separate pin, cook, overhand and underhand clips exists on Sketchfab.
  - "grenade-model" (nikhilmohan) and "Grenade Animated" (seanwilkesj) are prop animations with no textures.
  - "Throw Grenade" and "Grenade Throw" are third-person bodies.

**How to get a pin/cook/overhand/underhand set:**
- **Overhand throw:** split the one baked clip in Arms throwing into ranges (ready, wind-up, release, recover).
- **Pin pull and cook hold:** add these procedurally, as a bone offset on the left hand and a hold frame.
- **Underhand throw:** play the throw with a pitched-down arm rig offset.
- **Equip and unequip:** reuse the hide/ready ranges from the existing pistol and sniper clips. Same author, same rig family, but check that the bone names match.

## 2. Throwable models (all CC-BY, downloadable, 10k tris or fewer, unless noted)

| Item | Name / author | URL | Tris | Textures | Note |
|---|---|---|---|---|---|
| Frag | **M67** by Firewarden3D | [52dc34ff](https://sketchfab.com/3d-models/m67-52dc34ff97984927b0322326e3171467) | 10,092 | 2K metal-rough + AO | **Best.** Realistic olive M67 with spoon, ring and stencils. Separate spoon and pin. |
| Frag | M67 Fragmentation Grenade by FJH | [26eda181](https://sketchfab.com/3d-models/m67-fragmentation-grenade-26eda181849f4d188f69105302fd7b65) | 13,068 | 4K | Very good, dark metallic finish. Moving parts are separate meshes. |
| Frag | M67 GRENADE by Tiago Lopes | [d202644d](https://sketchfab.com/3d-models/m67-grenade-d202644dfaf441a0a145befbd7add45a) | 4,747 | 4K, 5 materials | Split into parts, but too many materials. |
| Frag | Grenade m67 by etwo | [dcfc56fe](https://sketchfab.com/3d-models/grenade-m67-happy-or-sad-grunge-pass-dcfc56feb4664522a695b058f872104b) | 2,068 | 1K spec-gloss | Cheap LOD or world-pickup option. |
| Smoke | **M18 Smoke Grenade** by Vanillatography | [46343925](https://sketchfab.com/3d-models/m18-smoke-grenade-46343925ad0e47cf927e66da7953c372) | 5,112 | 4K (normal is DirectX, flip green) | **Best.** Clean realistic M18 with red cap bands. |
| Smoke | M18 smoke grenade red by Slava Zemlyanik | [f4356d45](https://sketchfab.com/3d-models/m18-smoke-grenade-red-f4356d459a4a4ca6bcbdbba6ced8a774) | 8,990 | 2K + alpha | Worn, very realistic. Includes a separate spoon. |
| Smoke | M18 Smoke Grenade by RedRogueXIII | [6dbb4815](https://sketchfab.com/3d-models/m18-smoke-grenade-6dbb48151a9147b4830aa7bf55fc8282) | 2,500 | 2K spec-gloss | Has separate FP and world OBJs. Older (2015). |
| Smoke | M18 Smoke Grenade by Eric Wallbank | [d0614d2c](https://sketchfab.com/3d-models/m18-smoke-grenade-d0614d2c359e4e5ba4e14064dc2c8d59) | 4,690 | 2× 2K | Author says "poorly optimized". |
| Flash | **M84 Stun Grenade "Flashbang"** by Vanillatography | [3dbda8fe](https://sketchfab.com/3d-models/m84-stun-grenade-flashbang-3dbda8fe68ff4efdbf59f7d414c5619c) | 11,424 | 4K | **Best.** Same artist as the M18, so the two match. |
| Flash | Flashbang grenade by Nikolay Kudrin | [2799b0b8](https://sketchfab.com/3d-models/flashbang-grenade-2799b0b859c74db6ae8752fdc6bb4c04) | 8,290 | 4K | Very realistic (522 likes). |
| Flash | M84 Stun Grenade by Coozy | [81afe3b5](https://sketchfab.com/3d-models/m84-stun-grenade-flashbang-81afe3b572ba4e2f92f2c001eaccb83d) | 7,684 | 4K | Good. |
| Flash | Stun Grenade Game Model [2K] by Lyndschoko | [12df17b5](https://sketchfab.com/3d-models/stun-grenade-game-model-2k-12df17b5d67b4f6f85d0c63faeb1ea6d) | 12,320 | 2K | Ships at 2K already. |
| Molotov | **Molotov Cocktail** by godlike (@thisisruslan) | [d78c0bfa](https://sketchfab.com/3d-models/molotov-cocktail-d78c0bfaf7e2448cbd98a485ab079ad2) | 4,522 | 2K (bottle, rag) | **Best.** Green glass with a hanging rag. No label, so no trademark risk. |
| Molotov | Molotov Cocktail by Shaggy6736 | [ed00b521](https://sketchfab.com/3d-models/molotov-cocktail-ed00b521c7cb48ec930e42d9adf5ff17) | 6,976 | 2K bottle, 1K cloth | Dark bottle with a rag. |
| Molotov | Molotov Cocktail by Da_Feee | [26c3a5a5](https://sketchfab.com/3d-models/molotov-cocktail-26c3a5a55f464e1b98a7e67b8aec24bf) | 10,152 | 2K | Beer bottles with fictional labels, plus a matchbox. |
| Bonus | **Stick Grenade** (Poly Haven, **CC0**) | https://polyhaven.com/a/stick_grenade | 6,250 | 1K–4K | Realistic, no login. |

**Rejected throwables:**
- PUBG Mobile, CS:GO, CoD and EFT lookalikes: ripped or game fan art.
- LiliumLetifer's Molotov: uses PngItem brand-label images.
- BlueOxel flashbang and PatrykKamionka M84: CC-BY-SA.
- user77 M84: not downloadable.

## 3. Consumables and gear pickups (all CC-BY and downloadable unless marked CC0)

| Item | Name / author | URL | Tris | Max texture | Note |
|---|---|---|---|---|---|
| Bandage | **Bandage Game Ready** by dwalsh | [1ef457cb](https://sketchfab.com/3d-models/bandage-game-ready-1ef457cb19484eb7bf826dd0bb973ede) | 2,588 | 2K | Very realistic vacuum-packed trauma bandage. The label copies the real "THE EMERGENCY BANDAGE" product, so **retexture the label**. |
| Bandage | Bandage Roll by Tactical_Beard | [dd33fad8](https://sketchfab.com/3d-models/bandage-roll-dd33fad87aec468daeb0398ea4a6389f) | 752 | 2K | Plain gauze roll. |
| Bandage | Medical Tape (Poly Haven, CC0) | https://polyhaven.com/a/medical_tape | 1,408 | 1K–4K | Real 4.5 cm roll. Works as a small bandage roll. |
| First aid | **Tactical FIRST AID KIT** by Ruslan Koschey | [011c33c1](https://sketchfab.com/3d-models/tactical-first-aid-kit-011c33c121284bc88bb765a85511dae1) | 3,632 | 2K | **Best.** Coyote MOLLE pouch with a red cross. Looks like PUBG's first aid kit. |
| First aid | IFAK (desert) by BarnusModels | [9442b75d](https://sketchfab.com/3d-models/individual-first-aid-kit-ifakdesert-color-9442b75d62f14269ab82100e922a6911) | 13,538 | 4K | Detailed, but over the tris budget. |
| Medkit | Medical Box (Poly Haven, CC0) | https://polyhaven.com/a/medical_box | 3,718 | 1K–4K | Real 52×35×10 cm case. Best CC0 medkit. |
| Medkit | Ammunition And First Aid Kit Pack by CGMeller | [0a8390f8](https://sketchfab.com/3d-models/ammunition-and-first-aid-kit-pack-0a8390f8452646509cffddc304bc95db) | 12,566 total | 4K, 1 material | Kit box 3.3k, kit bag 2.8k, bottle 1.3k, ammo boxes 600 each. Soviet style with Cyrillic labels. |
| Medkit | Medkit_army by 3dmodelsst | [98b38489](https://sketchfab.com/3d-models/medkit-army-98b384895226421a9105d9d663212859) | 3,983 | 1K spec | STALKER-style army kit. Lower quality. |
| Energy drink | **Energy Drink Game Ready** by dwalsh | [83676feb](https://sketchfab.com/3d-models/energy-drink-game-ready-model-83676feb8b0a4589952cf3676299311b) | 1,940 | 2K | Black "BLAZING ENERGY DRINK" can. The name looks fictional, but I didn't check it against real brands. |
| Energy drink | Cans – Dirty and Crumpled by Sunbox Games | [5f4c354c](https://sketchfab.com/3d-models/cans-dirty-and-crumpled-3-piece-set-5f4c354cf4474c58bad147b346399a5f) | 612 | 4K | Crumpled soda can (empty-can prop). |
| Painkillers | **Simple Pain Pills** by Blender3D | [e8ff733b](https://sketchfab.com/3d-models/simple-pain-pills-e8ff733b5a184335aac1e59d4c0820e0) | 732 | 5000 px (downscale) | Generic "Pain Reliever" bottle. |
| Painkillers | Simple Pill Bottle by Blender3D | [21f392ee](https://sketchfab.com/3d-models/simple-pill-bottle-21f392ee64fb4297a578a1ae210dcb33) | 4,168 | 6000 px | Amber prescription bottle. |
| Helmet | **Combat helmet K6-3** by shamanoff | [94701874](https://sketchfab.com/3d-models/combat-helmet-k6-3-94701874d8b949718708b018c8d4f61d) | 4,242 | 2K | Russian K6-3 with visor. This is the PUBG "Level 3 helmet" look. |
| Helmet | Tactical Helmet with Headset by Exactly | [82adf376](https://sketchfab.com/3d-models/tactical-helmet-with-headset-game-ready-82adf376164f4d99a4e0b2949930e2ad) | 19,147 | 4K | FAST-style helmet in multicam. Not flagged as AI-generated. Published 2026-07. Heavy. |
| Vest | **Tactical Plate Carrier Vest** by Exactly | [3b51e632](https://sketchfab.com/3d-models/tactical-plate-carrier-vest-game-ready-3b51e6329dbb4b0aa14e43f12eb6c42a) | 2,960 | 4K | Black plate carrier with magazine pouches and a US flag patch. Not flagged as AI-generated. |
| Vest | Low Poly Game Ready Armor Vest by DanlyVostok | [90c084b9](https://sketchfab.com/3d-models/low-poly-game-ready-armor-vest-90c084b9a56441b1afcfa9293b6fe4af) | 5,428 | 4K spec | Tan plate carrier. |
| Backpack | **Low Poly Game Ready Military Tactical Backpack** by DanlyVostok | [95a4fc73](https://sketchfab.com/3d-models/low-poly-game-ready-military-tactical-backpack-95a4fc7300584384b56ce3add58dbc9f) | 2,730 | 4K | Retopology of a scan "downloaded from here", most likely Liam3D's CC-BY scan below; credit both. |
| Backpack | Military Tactical Backpack by Liam3D | [9fa2da2c](https://sketchfab.com/3d-models/military-tactical-backpack-9fa2da2c42234b58896e8d23393cac24) | 1,474 | 4K | Photoscan made for an Arma 3 mod. |
| Ammo | **AmmoCans GameReady Animated** by Alexandr Chub | [4d14272e](https://sketchfab.com/3d-models/ammocans-gameready-animated-pbr-free-4d14272e44bd4bb6898d91b223296606) | 1,998 | 4K | Realistic US .50 cal ammo can with a lid animation. Author asks: "provide the original link". |
| Ammo | Ammo 7.62×51 NATO by Pedro Belthori | [7442e915](https://sketchfab.com/3d-models/ammo-762mm-x-51mm-nato-7442e91500804c7f859f0934b855c92f) | 1,872 | 2K | Loose 7.62 rounds. |
| Ammo (12ga) | Pack Of Ammo by Gnossiennes | [01bc4d63](https://sketchfab.com/3d-models/pack-of-ammo-01bc4d633e8a4f94826edc7d30b5213b) | 7,120 | 2K | Shotgun shells and boxes. |
| Ammo | Ammo Can by Caboose3d | [975d4155](https://sketchfab.com/3d-models/ammo-can-975d4155d0fc4602984b14084e51ce82) | 5,828 | 2K | Alternative ammo can. |
| Ammo | Ammo Box (Poly Haven, CC0) | https://polyhaven.com/a/ammo_box | 4,382 | Already used in the game | Reuse it, retinted per caliber. |

**Rejected or flagged gear:**
- TampaJoey "Ammo Boxes Pack": real Federal, Blazer and Browning branding.
- Monster, Pepsi and PRIME cans: trademarks.
- PUBG Mobile bandage, painkiller and adrenaline: ripped.
- "Free – Armor Plate Carrier – Metahuman": Free Standard license, not CC.

**Ammo by caliber:** 5.56 and 9mm boxes have no good realistic CC0/CC-BY model. Use Poly Haven `ammo_box` or the CGMeller boxes with caliber decals of your own.

## 4. Third-person animations (Mixamo, checked against the live catalog)

- **Character:** Mixamo lists it as **"Swat Guy"**.
- **License:** free for commercial and non-commercial use, no credit required. "The only thing you can't do is distribute the raw character and animation files" (Adobe community restatement of the FAQ; the helpx page itself returned 403). Don't commit raw FBX to a public repo.

| Need | Exact name (description) | Duration | In Place |
|---|---|---|---|
| Grenade toss | **Toss Grenade** (Throwing Something Holding Rifle Aimed) | 3.83 s | Yes |
| | Throw Grenade (Throwing Grenade While Crouched) | 1.83 s | No |
| | Throw Grenade (Throw Grenade While In Prone Position) | 1.40 s | No |
| | Grenade Throw (Throwing A Grenade While Walking) | 3.33 s | Yes |
| | Grenade Throw (…Kneeling Pulling Pin With Teeth) | 5.73 s | No |
| | Run And Throw Grenade | 3.33 s | Yes |
| Healing | **No bandage, medkit or syringe clips exist.** Closest stand-ins: **Kneeling Inspecting** (4.93 s), Rummaging (4.83 s), Searching Pockets (5.00 s), Shoulder Rubbing (5.80 s), Taking A Pill (lying, 1.80 s) | | No |
| Drinking | **Drinking** (Male Drinking) | 8.87 s | No |
| | Sitting Drinking (canned beverage) | 15.20 s | No |
| Downed crawl | **Crawling** (hands and knees) | 3.00 s | Yes |
| | Low Crawl | 2.33 s | Yes |
| | Crawl Backwards | 3.97 s | Yes |
| | Prone Forward | 3.33 s | Yes |
| Fall into downed | **Knocked Down** (To Stomach) | 2.77 s | No |
| | Falling Down | 2.27 s | No |
| Downed idle | **Writhing In Pain** (on back) | 5.67 s | No |
| | Dying (Laying On The Ground Dying) | 6.80 s | No |
| | Laying Moaning | 2.10 s | No |
| Get up | **Getting Up** (From Being Knocked Down On The Ground) | 2.70 s | No |
| | Getting Up (From Stomach) | 6.67 s | No |
| Revive | **No "Revive" or "Helping Up" clips.** Use **Administering Cpr** + **Receiving Cpr** (both 8.60 s, likely a pair), **Kneeling Down** (2.77 s), **Kneeling Idle** (4.23 s), **Rifle Kneel Idle** (1.70 s) | | No |
| Pick up | **Pick Up Item** (Left or Right Item Pick Up Into Pack When Running) | 1.2 s | Yes |
| | Picking Up Object (one hand) | 3.40 s | No |
| | Picking Up | 4.20 s | No |

**Mixamo download settings:**
1. Select **Swat Guy** first.
2. Format **FBX Binary**.
3. Skin **Without Skin** for clips (the character once "With Skin").
4. **30 fps**, keyframe reduction **none**.
5. **In Place** on for crawl, prone movement, Toss Grenade, walking Grenade Throw and Run And Throw.
6. Pick the rifle variant when names repeat.

## 5. VFX textures (web-safe)

| Category | Pick | License | Format | Note |
|---|---|---|---|---|
| Explosion | **Unity Labs "Free VFX image sequences & flipbooks"**: Explosion00/01/02, **Explosion01-nofire** (dust), Explosion02HD. [Blog post](https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks); files at `unity3d.com/files/labs/downloads/vfx/assets01/<Name>/<Name>-flipbooks.zip` | **CC0**: "image sequences we want to share with you under CC0 license". Not tied to Unity. | TGA/EXR, 5×5 at 1024² (HD at 2048²), straight alpha | High realism. Resample to 1020² so the cells divide evenly. |
| Explosion (alt) | Babylon `assets.babylonjs.com/particles/textures/explosion/` (FlameBlast 4×4, Smoke 8×8, Flash, Flare) plus a ready-made `explosion.json` | **CC-BY 4.0** (BabylonJS/Assets LICENSE) | 1024² greyscale + alpha | Medium realism, fastest to drop in. |
| Explosion (hero, later) | JangaFX free VDBs (Ground Explosion, Grenade Dust Impact) | CC0 | OpenVDB volumes | Render to flipbooks yourself. |
| Explosion (fallback) | Soluna "Lots of game effects" Explosion25 | CC0 | 512², 4×4 | Low-res fallback. |
| Smoke | **Unity Labs WispySmoke01–03**, Cloud01–04, DiscSmoke01 | CC0 | 8×8 at 1024² | Best smoke-grenade loop. |
| Smoke (alt) | Fupi "Smoke Vapor Particles" (OGA); Kenney Smoke Particles; Babylon Smoke_SpriteSheet_8x8 | CC0 / CC0 / CC-BY | | |
| Fire | **Unity Labs Flame03** (16×4, 1024×512) and Flame02; FireBall01–04 | CC0 | | FireBall01's TGA has no alpha, so additive only. |
| Fire (alt) | zookeeper "Seamless animated fire" (OGA) for the burning puddle; Babylon Fire_SpriteSheet1–3 | CC0 / CC-BY | | |
| Fire (optional) | CGHEVEN flipbooks | CC0 on the free tier only | | Check each asset's license tag. |
| Sparks | **Kenney Particle Pack `trace_01..07`** (avoid `spark_*`, electric style); Babylon `sparkStretched.png` | CC0 / CC-BY | | |
| Glass shards | **Weak category.** Kenney `dirt_01..03` tinted, plus shard meshes built in code | CC0 | | Keith333 "Broken Glass" (CC-BY 3.0) photos would need cutting out. The Sketchfab broken-glass models it found were **not re-verified** (rate limit). |
| Scorch decal | **Weak category.** Poly Haven `burned_ground_01` masked by Kenney `scorch_01` | Both CC0 | | ambientCG has no burn or scorch decals (API search), only AsphaltDamage decals. Poly Haven has no decal category. |

**Rejected VFX sources:**
- Unity Particle Pack: Asset Store EULA, "cannot be … extract[ed] from your final product".
- Unity VFX Graph samples: Unity Companion License.
- Unreal Starter Content and Infinity Blade: UE only.
- ActionVFX and Fab Megascans decals: could not verify.
- Anything CC-BY-SA or GPL.

**Babylon's built-in particle presets:** `ParticleHelper` presets and the default `flare.png` all come from BabylonJS/Assets, so they are **CC-BY 4.0**. Shipping them is fine; credit "Babylon.js Assets, CC BY 4.0".

## 6. Cover trees with thick trunks

- **Already in the game (Poly Haven):** fir_tree_01, fir_sapling_medium, tree_small_02, island_tree_01, searsia_lucida. From the glTF bounds, fir trunk meshes are only about 1.1–1.2 m across *including root flare*.
- **Budget note:** `tools/environment` already turns multi-million-tri film trees into card and impostor LODs. So source triangle count matters less than trunk thickness and texture quality.

| Name / author | URL | License | Size / tris / textures | Note |
|---|---|---|---|---|
| **Large oak tree with parasitic fungi** by ZiemniaQ | [1a475a11](https://sketchfab.com/3d-models/large-oak-tree-with-parasitic-fungi-1a475a11690d4bf5aa1af1850c628fff) | CC Attribution | **~1.2 × 1.2 × 6.0 m** (stated by author) / 43,479 / 8K diffuse, 4K normal and AO | Photogrammetry trunk, delit. Just the right thickness to hide behind. Pair it with a card crown. Collision: cylinder. Thumbnail not reviewed. |
| **Oak tree** by massive-graphisme | [3dc59560](https://sketchfab.com/3d-models/oak-tree-3dc59560f2d24345bdbe65c44636453b) | CC Attribution | 7,112 / 2–4K bark, 4K leaf cards | Full tree with a thick flared trunk and alpha cards. Size not stated; measure after import. Collision: cylinder. |
| **Realistic Tree** by Daniel Petrov | [d989c0f8](https://sketchfab.com/3d-models/realistic-tree-d989c0f801d847b9a74992ec4ddcfdfc) | CC Attribution | 19,921 / 4K trunk PBR, 256 px leaves | Thick root-flared trunk. Leaf texture is too small; regenerate the crown with the card pipeline. |
| **3 English Oak Set** by Yag1z | [750fac73](https://sketchfab.com/3d-models/3-english-oak-set-quercus-robur-updated-750fac732a8c453e9dd748f1396275fa) | CC Attribution | 3 trees, 8–10k each / 2K | Gnarled dead or bare oaks with root flares. Good dead-tree cover. |
| **Tree 002** by OlegYurkov | [2e1824ab](https://sketchfab.com/3d-models/tree-002-2e1824ab0d8543f1b43093cc0c46777b) | CC Attribution | 30,000 / 4K diffuse and normal | Scanned mossy trunk base with big roots. Trunk only. |
| **Beech Tree Trunk Roots Processed Scan** by Pers Scans | [40209ba4](https://sketchfab.com/3d-models/beech-tree-trunk-roots-processed-scans-forest-40209ba426a64381b435106ad0509bff) | CC Attribution | 8,861 / 4K PBR | Tall cut beech trunk with a root flare, delit. Works as a thick stump or broken-tree cover. |
| **Maple Tree Scan Trunk 4 LOD** by EFX | [82825157](https://sketchfab.com/3d-models/maple-tree-scan-trunk-4-lod-82825157e5dc45418f08ee7ac297f6cc) | CC Attribution | 36,259 across 4 LODs (LOD0 is 15k verts) / 4K | Scanned trunk with LODs down to a billboard. Thumbnail not reviewed. |
| Lowpoly Scan Trees Pack 1: Live Oak and Pack 3: Black Walnut + Dead Tree by EFX | [19d8e9a7](https://sketchfab.com/3d-models/lowpoly-scan-trees-pack-1-live-oak-w-graffiti-19d8e9a7c32f4c3b87ae787884d03e09), [64872314](https://sketchfab.com/3d-models/lowpoly-tree-scan-pack-3-black-walnutdead-tree-6487231452e540e19cf8c572c8c07715) | CC Attribution | ~27–29k / 2K | Scanned trunks. Pack 1 has **graffiti** (third-party art risk), so prefer Pack 3. Thumbnails not reviewed. |

**Rejected trees:**
- PlantCatalog "Realistic HD" oaks (CC-BY): living mature oaks are 150k–1.2M tris, and the dead ones are spindly.
- Skovfogedegen oak scan: gloss and normal maps only, no colour.
- perz_scans' big oak and beech trunk packs: "Standard" license, not downloadable.
- Fab/Megascans: the Standard License allows any engine and shipping inside a project but forbids "redistribut[ing] the asset… on a standalone basis". Free Megascans ended in 2025, and the full EULA page returned 403, so I couldn't check how it treats extractable web builds. **Don't rely on it.**

## 7. Big rocks and cover set pieces

| Item | Name / source | URL | Real size | Tris | Textures | Collision |
|---|---|---|---|---|---|---|
| Rock outcrop | **Rock Face 01** (Poly Haven, **CC0**) | https://polyhaven.com/a/rock_face_01 | 7.1 × 5.6 × **5.0 m** | 20,174 | 1K–8K | Convex hull (or 2–3 hulls) |
| Rock outcrop | **Rock Face 02** (Poly Haven, CC0) | https://polyhaven.com/a/rock_face_02 | 4.9 × 3.5 × **4.7 m** | 29,566 | 1K–8K | Convex hull |
| Boulder | **Namaqualand Boulder 04** (CC0) | https://polyhaven.com/a/namaqualand_boulder_04 | 2.5 × 2.5 × **1.9 m** | 110,746 (decimate) | 1K–8K | Convex hull |
| Boulder | Namaqualand Boulder 03 (CC0) | https://polyhaven.com/a/namaqualand_boulder_03 | 2.4 × 3.1 × **1.5 m** | 121,546 | 1K–8K | Convex hull |
| Boulder | Boulder 01 (CC0) | https://polyhaven.com/a/boulder_01 | 1.3 × 1.8 × 1.0 m | 123,976 | 1K–8K | Convex hull |
| Cliff chunk | Namaqualand Cliff 01 (CC0) | https://polyhaven.com/a/namaqualand_cliff_01 | 8.3 × 4.4 × 5.0 m | 176,938 | 1K–8K | Several hulls |
| Boulder | Gray Big Rock by 3dhdscan | [70b586d5](https://sketchfab.com/3d-models/gray-big-rock-70b586d54a1e46ab9398f25369a39df3) | Not stated (~2 m) | 34,969 | 4K diffuse, normal, AO | Hull. Comes with a ground patch to sink below terrain. |
| Rock cluster | Coastal Ground Cliff Rocks by Pers Scans | [68d53a16](https://sketchfab.com/3d-models/coastal-ground-cliff-rocks-68d53a1623aa47008fb7088a5694d79b) | Not stated | 24,868 | 8K PBR | Hulls |
| Fallen log | **Mossy old tree log** by Julian Malik | [c65a00ca](https://sketchfab.com/3d-models/mossy-old-tree-log-c65a00ca4a174653beb4c59cb42b9143) | Not stated | 20,390 | 4K metal-rough | Hull. Thick, scanned and retopologised; very realistic. |
| Fallen log | Lying trunk covered with moss by 3dhdscan | [93d02c92](https://sketchfab.com/3d-models/lying-trunk-covered-with-moss-93d02c929dca418fbe9ebf03de6208f2) | Not stated | 59,238 | 4K | Hull |
| Fallen log | Poly Haven `dead_tree_trunk_02` | Already used as `log_fallen` (4.05 m long, 1.06 m thick) | | | | |
| Stump | **Boubín Stump** by 3dhdscan | [b968b5dc](https://sketchfab.com/3d-models/boubin-stump-b968b5dc462148989cb87b072885da85) | Not stated | 23,581 | 4K | Cylinder or hull |
| Stump | Photoscanned Dead Oak Stump by chrisg4919 | [c6b6469f](https://sketchfab.com/3d-models/photoscanned-dead-oak-stump-c6b6469facad4fc3b77d866bfc2bd913) | Not stated | 53,925 | 4K colour and normal | Hull |
| Stump | Poly Haven `tree_stump_02` (CC0) | https://polyhaven.com/a/tree_stump_02 | 1.5 × 1.4 × 0.5 m | 62,345 | 1K–8K | Cylinder |
| Car wreck | **Destroyed Car 03** by Renafox | [efc4dfe2](https://sketchfab.com/3d-models/destroyed-car-03-backrooms-car-gameready-ver-efc4dfe2c7284a64bc9281eb4f61d402) | Full-size sedan (~5.4 m) | 9,997 | 4K colour and normal, 2K ORM | Box or hull. Very realistic scan (Caprice-style). "Free to use… as long as I'm credited." |
| Car wreck | Crashed Abandoned Car by Rashad Ibrahimli | [66ef51a8](https://sketchfab.com/3d-models/crashed-abandoned-car-game-ready-66ef51a84c9843dda53bf0b4b9020011) | SUV | 8,334 | 4K (DirectX normal) | Box or hull. Separate doors. |
| Car wreck | Burned-out Cars by Renafox | [701066df](https://sketchfab.com/3d-models/burned-out-cars-701066df6b914fd08318524c7ccd96a7) | 2 cars | 3,451 | 2K | Box. Author calls it placeholder quality. |
| Concrete pipe | Concrete Pipes_12_MB by Mehdi Shahsavan | [7b156401](https://sketchfab.com/3d-models/concrete-pipes-12-mb-7b156401a8aa4f01880618c938a219f9) | Not stated | 13,154 | 2K | Hollow cylinder: 2 half-shells or a box ring |
| Concrete pipe | Concrete pipe (Game ready) by PT34 | [92d1cbc2](https://sketchfab.com/3d-models/concrete-pipe-game-ready-92d1cbc20e8c440aad9be60586d5efa6) | Not stated | 768 | 4K | Looks bland white; tint it. |
| Hay bales | **Hay bales** by Zbrojmistrz | [d6e087f9](https://sketchfab.com/3d-models/hay-bales-d6e087f9a2a9416c94918f0503943c17) | ~1 m square bales | 3,060 | 4K | Box. Realistic, with loose straw. |
| Hay bales | Hay Bales by FrodoUndead | [6b775049](https://sketchfab.com/3d-models/hay-bales-6b775049e57e4d9da87977905493ebfb) | | 3,272 | 2K | Box |
| Sandbags | Sandbag Barrier by G4AGamingLabs | [59380067](https://sketchfab.com/3d-models/sandbag-barrier-ready-for-unreal-engine-593800671c8e45eca93b8b7c765c0f77) | Wall segment | 19,975 | 2K | Box. CC-BY despite "Unreal" in the title. Thumbnail not reviewed. |
| Sandbags | Sandbags by Evan | [8cda4370](https://sketchfab.com/3d-models/sandbags-8cda4370170746d393aa311a7c080c50) | Loose bags | 5,824 | 2K | Stack them into walls in code. |
| Cable spool | **Cable Spool** by wolfgar74 | [22ddb8e0](https://sketchfab.com/3d-models/cable-spool-22ddb8e02f944fb7b5662f14fdc50e5e) | ~1 m | 1,664 | 2K | Cylinder. Realistic plank spool. |

**Rock sizes:** Sketchfab doesn't publish real-world sizes, so measure bounds after import. Poly Haven sizes come from its API.

---

## Recommended starter set (one pick per need)

**Sketchfab download steps (all Sketchfab picks):**
1. Log in and open the model page.
2. Click **Download 3D Model**.
3. Choose **glTF (.glb), 2K textures** where offered.
4. For animated FP arms, also grab the **Original format (FBX)**. It keeps the exact single clip for `tools/assets` and `pnpm assets:analyze`.
5. Put files in `assets-src/<category>/<name>/`.
6. Record title, author, URL and "CC BY 4.0" in `credits.json`.

**Poly Haven steps:** fetch by ID with `tools/environment/fetch.mjs` (no login, CC0).

| Need | Pick | How to get it |
|---|---|---|
| FP throw arms | **Arms throwing**, DJMaesen (1f9a5c71). Matches the shotgun arms. | FBX original + GLB. Split the clip with `pnpm assets:analyze`. Attach grenade meshes to the right-hand bone. |
| Frag | **M67** by Firewarden3D (52dc34ff) | GLB 2K |
| Smoke | **M18 Smoke Grenade** by Vanillatography (46343925) | GLB 2K. Flip the normal's green channel (DirectX) if you use the original. |
| Flashbang | **M84 "Flashbang"** by Vanillatography (3dbda8fe) | GLB 2K |
| Molotov | **Molotov Cocktail** by godlike (d78c0bfa) | GLB 2K |
| Bandage | **Bandage Game Ready** by dwalsh (1ef457cb) | GLB 2K. Retexture the product label. |
| First aid kit | **Tactical FIRST AID KIT** by Ruslan Koschey (011c33c1) | GLB 2K |
| Medkit | **Poly Haven `medical_box`** (CC0) | fetch.mjs, 1K |
| Energy drink | **Energy Drink Game Ready** by dwalsh (83676feb) | GLB 2K |
| Painkillers | **Simple Pain Pills** by Blender3D (e8ff733b) | GLB 2K (downscale from 5000 px) |
| Helmet | **Combat helmet K6-3** by shamanoff (94701874) | GLB 2K |
| Vest | **Tactical Plate Carrier Vest** by Exactly (3b51e632) | GLB 2K |
| Backpack | **Military Tactical Backpack** by DanlyVostok (95a4fc73) | GLB 2K. Credit DanlyVostok and the source scan (Liam3D). |
| Ammo | **AmmoCans GameReady** by Alexandr Chub (4d14272e) plus Poly Haven `ammo_box` retinted per caliber | GLB 2K. Credit with the original link. |
| TP grenade | Mixamo **Toss Grenade** (rifle) and **Throw Grenade** (crouched) | Swat Guy, FBX Binary, Without Skin, 30 fps, no reduction, In Place on for Toss Grenade |
| TP heal | Mixamo **Kneeling Inspecting** (medkit), **Searching Pockets** (bandage) | Same settings, In Place not offered |
| TP drink | Mixamo **Drinking** | Same settings |
| Downed | Mixamo **Knocked Down**, **Writhing In Pain**, **Crawling** (In Place), **Getting Up** (From Being Knocked Down) | Same settings |
| Revive | Mixamo **Administering Cpr** + **Receiving Cpr** | Same settings |
| Pick up | Mixamo **Pick Up Item** (Right…, In Place) | Same settings |
| Explosion | Unity Labs **Explosion01** + **Explosion01-nofire** (CC0) | Direct zip, no login |
| Smoke | Unity Labs **WispySmoke01** + **Cloud01** (CC0) | Direct zip |
| Fire | Unity Labs **Flame03** (CC0) | Direct zip |
| Sparks | Kenney Particle Pack **trace_01** (CC0) | kenney.nl |
| Glass | Shard meshes made in code, plus Kenney **dirt_01** tinted (CC0) | kenney.nl |
| Scorch | Poly Haven **burned_ground_01** masked by Kenney **scorch_01** (CC0) | fetch.mjs + kenney.nl |
| Thick tree | **Large oak tree with parasitic fungi** by ZiemniaQ (1a475a11), with a card crown from the pipeline. Full-tree alternative: **Oak tree** by massive-graphisme (3dc59560). | GLB 2K. Cylinder collision around 1.1 m. |
| Big rock | **Poly Haven `rock_face_02`** (4.9 × 3.5 × 4.7 m, CC0) + `namaqualand_boulder_04` (1.9 m) | fetch.mjs. Decimate the boulder in the pipeline. Convex hulls. |
| Fallen log | **Mossy old tree log** by Julian Malik (c65a00ca) | GLB 2K, hull |
| Stump | **Boubín Stump** by 3dhdscan (b968b5dc) | GLB 2K, cylinder |
| Car wreck | **Destroyed Car 03** by Renafox (efc4dfe2) | GLB 2K, box or hull |
| Concrete pipe | **Concrete Pipes_12_MB** by Mehdi Shahsavan (7b156401) | GLB 2K, 2 half-shell boxes |
| Hay bale | **Hay bales** by Zbrojmistrz (d6e087f9) | GLB 2K, box |
| Sandbag wall | **Sandbag Barrier** by G4AGamingLabs (59380067) | GLB 2K, box |
| Cable spool | **Cable Spool** by wolfgar74 (22ddb8e0) | GLB 2K, cylinder |

**Things to check before downloading:**
- **Thumbnails not reviewed:** ZiemniaQ oak, EFX maple and tree packs, G4A sandbag barrier.
- **Sketchfab glass-shard models:** not re-verified.
- **Arms throwing clip content:** it only has one baked clip, so whether it includes a pin-pull pose isn't known until it's imported and analysed.

**Sources**
- Sketchfab Data API: https://api.sketchfab.com/v3/models
- Poly Haven API and license: https://api.polyhaven.com, https://polyhaven.com/license
- Mixamo FAQ, via the Adobe community restatement: https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400
- Unity Labs CC0 flipbooks: https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks
- BabylonJS/Assets LICENSE: https://github.com/BabylonJS/Assets
- Kenney Particle Pack: https://kenney.nl/assets/particle-pack
- ambientCG license: https://docs.ambientcg.com/license/
- JangaFX free VDBs: https://jangafx.com/software/embergen/download/free-vdb-animations
- Megascans free until end of 2024: https://www.cgchannel.com/2024/10/epic-games-has-made-megascans-free-to-all-but-only-until-the-end-of-2024/
- Fab Standard License: https://www.fab.com/eula?lang=en and https://forums.unrealengine.com/t/fab-license-terms-standard-license/2094243
