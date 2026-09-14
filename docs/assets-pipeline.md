# Asset pipeline

This pipeline turns raw downloads in `assets-src/` (gitignored) into web-ready files in `apps/client/public/assets/`. The client loads them through `apps/client/src/assets/`. For licenses and sources, see [assets-plan.md](assets-plan.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm assets` | Builds everything that changed. Flags: `--force`, `--only=rifle,swat`, `--textures=webp` (fast preview without KTX2), `--workers=N` (texture encoder threads, default 1), `--timeout=S` (hard abort, default 600) |
| `pnpm assets:verify` | Checks the outputs at the file level, decodes every KTX2 texture, then runs the client loader headless (Babylon NullEngine) |
| `pnpm assets:analyze [weapon]` | Prints the clip-boundary analysis for the baked weapon animations and checks the clip tables in `tools/assets/config.ts` against it |
| `pnpm assets:typecheck` | Type-checks `tools/assets` |

The build is incremental. Each output is rebuilt only when its source files, its spec in `config.ts`, or the pipeline code changes, or when the output file is missing or was modified. Encoded textures are cached in `node_modules/.cache/twobullets-assets/`. A cold build with 8 encoder workers took about 1 minute, mostly UASTC encoding. With the default single worker (chosen to keep memory low on shared machines), expect several minutes. A no-op build takes 0.2 s, and a rebuild with cached textures about 1 s. `assets:verify` peaks at about 500 MB RSS and aborts after 300 s; `assets:analyze` aborts after 120 s. Outputs are byte-for-byte deterministic, so it is safe to commit them.

The pipeline only writes `weapons/`, `characters/`, `decoders/` and `manifest.json`. `environment/` belongs to the world pipeline.

## Outputs

```
apps/client/public/assets/
  manifest.json            typed by apps/client/src/assets/manifest.ts
  weapons/rifle.glb        3.8 MB   19.6k verts  25.1k tris  7 textures
  weapons/shotgun.glb      4.1 MB   12.6k verts  16.7k tris  6 textures
  weapons/pistol.glb       4.1 MB   15.0k verts  21.3k tris  6 textures
  weapons/sniper.glb       4.1 MB   18.2k verts  20.7k tris  7 textures
  characters/swat.glb      1.6 MB   12.6k verts  19.5k tris  6 textures, 69 bones, 20 clips
  decoders/                0.7 MB   meshopt + Babylon KTX2 transcoders (no CDN at runtime)
```

Every GLB uses `EXT_meshopt_compression` with `KHR_mesh_quantization`, and all textures are KTX2 (`KHR_texture_basisu`).

## Tool choices

- **FBX → glTF: three.js `FBXLoader`, running in Node, plus our own converter to glTF Transform.** The `fbx2gltf` npm binary is x86_64-only, and this Mac has no Rosetta. `FBXLoader` handles Mixamo's pre-rotations, clusters and curves. We stub its DOM texture loader and keep the embedded image bytes instead. See `tools/assets/lib/fbx.ts` and `character.ts`.
- **glTF Transform + meshoptimizer** handle dedup, prune, resampling, quantization and meshopt compression. Babylon decodes meshopt natively. It produces smaller files than Draco for skinned or animated data, and it compresses animation too.
- **Textures: `ktx2-encoder`** (Basis Universal compiled to wasm, in a `worker_threads` pool, 1 worker by default) together with `sharp` for resizing. `toktx` isn't installed. We measured a 2K texture:

  | Format | File size | GPU memory |
  |---|---|---|
  | WebP q85 | 0.3 MB | 21 MB (RGBA plus mips) |
  | ETC1S | 0.6–0.85 MB | about 5 MB (BC7, or 2.7 MB as BC1) |
  | UASTC+zstd, normals | 2.5–2.9 MB | about 5 MB |

  All five assets together would take roughly 350 MB of VRAM as WebP, against about 85 MB as KTX2, so KTX2 wins. The chosen settings:

  | Map | Codec | Max size |
  |---|---|---|
  | Base color | ETC1S | 2K |
  | ORM (occlusion, roughness, metalness) | ETC1S | 2K for guns, 1K for arms and character |
  | Normal | UASTC+zstd (ETC1S artifacts show badly on normals) | 1K |

  Change the rules in `WEAPON_TEXTURES` / `CHARACTER_TEXTURES`. `--textures=webp` still works for quick iteration.
- **Decoders**: `meshopt_decoder.js` is copied from `meshoptimizer`. Babylon's KTX2 worker module is bundled with `rolldown` from `@babylonjs/ktx2decoder` into the UMD global it expects, and its wasm files are copied next to it.

## Weapons

The sources are DJMaesen's Sketchfab GLBs: one skin, and one baked clip at 30 fps. Keyframe times are exact multiples of 1/30 s.

Processing steps (`tools/assets/lib/weapon.ts`):

1. **Root.** The Sketchfab wrapper nodes (Z-up rotations and inconsistent scales of 0.021, 0.01 and 1) are replaced by one `viewmodel` root at a 0.01 scale. All four source files are authored in cm, and the arm segments are about 30 cm. After the glTF loader converts the file, the gun points along +Z, Y is up, and units are meters.
2. **Cleanup.** The IK pole helpers and their channels are removed, along with empty leftover nodes. The skinned node is renamed `arms` and the animation is renamed `all`.
3. **Generated nodes.** Both are children of the animated gun `body`, so they follow recoil:
   - `muzzle`: the center of the barrel mesh's frontmost 1 cm slice.
   - `ejection`: the bounding-box center of the bolt mesh (rifle), the chambered round (pistol, sniper) or the shell (shotgun). Treat this as approximate, within about 2 cm.
4. **Manifest data.** `anchors` (muzzle, ejection, scope lens) and `bounds` are measured at the first idle frame in Babylon space. The source camera is not at the origin. For example, the rifle's scope lens is at (0, 0.221, 0.048), so tune the viewmodel offset from the anchors.

### Clip tables (source frames, inclusive)

| Clip | Rifle | Shotgun | Pistol (published) | Sniper (published) |
|---|---|---|---|---|
| fire | 0–8 | 0–12 | 0–11 | 0–11 |
| fireLast | | | 83–94 | |
| bolt / pump | | pump 13–25 | | bolt 12–60 |
| reload | 69–134 | 26–71 | 12–82 | 61–115 |
| reloadEmpty | 9–68 | | 95–175 | |
| reloadStart / Insert / End | | 26–34 / 35–60 / 60–71 | | |
| hide | 135–144 | 72–82 | 176–187 | 116–127 |
| ready | 144–177 | 82–102 | 187–233 | 127–142 |
| idle | 178–204 | 103–123 | 234–264 | 143–165 |
| melee | 205–222 | 124–140 | | 166–195 |

**Method** (`tools/assets/analyze-clips.ts`): sample every channel at every frame, then measure pose distance from frame 0 (the sum of rotation angles plus 3° per cm of translation). Boundaries fall into four kinds:

- **Rest holds.** Every clip starts and ends at the rest pose. The next clip begins on the last rest frame before motion resumes.
- **Freezes.** A duplicated non-rest frame. For example, the pistol's `fireLast` ends with the slide locked back.
- **Peaks.** `hide` and `ready` share the frame where the gun body is furthest from rest.
- **Jumps.** A one-frame discontinuity.

Run on the pistol and sniper, the method reproduces the author's published tables exactly (every edge within ±1 frame, most exact). Segments were labeled from the parts that move in each one: mag travel means reload, pump or bolt travel means pump or bolt, a large body offset followed by return means hide/ready, a small triangle wave means idle, and a quick rotated thrust means melee. The author's order (fire → action → reload → hide → ready → idle → melee) is the same across the family.

**Confidence**

| Item | Confidence | Why |
|---|---|---|
| Rifle and shotgun boundaries | High | Every edge sits on a detected boundary |
| Labels fire, pump, reload, hide/ready, idle, melee | High | |
| Rifle `reload` vs `reloadEmpty` | Medium | Clip 9–68 keeps the bolt locked back during the mag swap and releases it with the bolt catch, so we call it `reloadEmpty`. Clip 69–134 swaps the mag with the bolt forward, then pulls the charging handle. Swap the two in `config.ts` if they look wrong in game. |
| Shotgun `reloadInsert` 35–60 loops seamlessly | High | Frames 35 and 60 are identical except for the shell, which reappears in the hand |

## Character (SWAT)

Processing steps (`tools/assets/lib/character.ts`):

- **Skeleton.** `FBXLoader` duplicates bones that are shared between the head and body skins. These are merged into one glTF skeleton of 69 `mixamorig:*` joints, with inverse binds taken from the FBX clusters. The head and body are merged into a single mesh, `swat_mesh`, with one primitive per material and one skin, so Babylon creates exactly one skeleton.
- **Units and geometry.** Centimeters are baked to meters (translations, vertices, inverse binds). The model is Y-up and faces +Z. The bind pose is 1.78 m tall with feet at y = 0. UV v is flipped to glTF convention.
- **Materials.** Phong is converted to PBR: diffuse becomes base color, the normal map is kept, and roughness is derived from specular luminance (metalness 0).
- **Animations.** All 20 clips retarget by bone name onto the same skeleton. The rest poses of the animation FBXs match the character, apart from a 0.36 mm hips offset. The FBXs were exported without "In Place", so for locomotion clips the pipeline removes the linear X/Z drift of the hips, leaving the natural sway. The removed velocity is stored as `clips[name].rootMotion` in m/s, which you can use to sync playback speed with movement. For example, `walk_fwd` is 1.84 m/s, `run_fwd` 4.61 m/s and `sprint_fwd` 6.91 m/s. Death, hit and jump clips keep their hips motion.
- **Hitbox and attachment bones.** The `bones` map in the manifest covers `hips`, `spine`, `chest`, `neck`, `head`, both upper arms, forearms, hands, up-legs, legs and feet.

## Manifest

See `apps/client/src/assets/manifest.ts` for the full documented types. The top level:

```ts
AssetManifest {
  version: 1
  weapons: Record<"rifle"|"shotgun"|"pistol"|"sniper", WeaponAsset>
  characters: Record<"swat", CharacterAsset>
  credits: Credit[]
  decoders: DecoderUrls
}
```

The assets:

```ts
WeaponAsset {
  url, hash, bytes, fps, animation: "all", lastFrame
  clips: { [WeaponClipName]: [start, end] }
  nodes: { body, arms, muzzle, ejection, mag?, bolt?, chargingHandle?, slide?, pump?, shell?, trigger?, scope?, scopeLens?, reticle? }
  anchors: { muzzle, ejection, scopeLens? }
  bounds, stats, credit
}

CharacterAsset {
  url, hash, bytes, height, bounds
  clips: { [CharacterClipName]: { duration, loop, rootMotion? } }
  bones: { [CharacterBoneRole]: "mixamorig:..." }
  stats, credit
}

Credit { id, title, author, authorUrl?, url, license, licenseUrl?, attributionRequired, notes? }
```

All positions are in meters, in Babylon's left-handed space, relative to the instance root.

## Client API (`apps/client/src/assets`)

```ts
import { AssetLibrary, installAssetDevTools } from "../assets";

const library = await AssetLibrary.load(scene, ({ progress }) => loading.set(progress));
if (import.meta.env.DEV) installAssetDevTools(library); // logs a self-check; window.__assets.check()

// First person
const rifle = library.instantiateWeapon("rifle");
rifle.root.parent = viewmodelAnchor;           // meters, +Z forward
rifle.play("ready", { onEnd: () => rifle.play("idle", { loop: true }) });
rifle.play("fire", { speed: 1.5, onEnd: () => rifle.play("idle", { loop: true }) });
rifle.nodes.muzzle;                             // TransformNode for flashes and tracers
rifle.clipDuration("reload");                   // seconds at speed 1, to sync with simulation reload time

// Third person (any number of independent instances)
const enemy = library.instantiateCharacter("swat");
enemy.root.position.set(x, y, z);
enemy.play("run_fwd", { speed: speed / 4.607, blend: 0.2 });
enemy.play("death_back", { onEnd: () => ragdollOrFreeze() });
enemy.bones.head.getAbsolutePosition();         // hitboxes; parent a weapon to enemy.bones.rightHand

library.requiredCredits;                        // CC-BY entries for the credits screen
```

### `AssetLibrary`

| Member | What it does |
|---|---|
| `static load(scene, onProgress?, { baseUrl?, fetch?, headless? })` | Fetches the manifest, points the meshopt and KTX2 decoders at `/assets/decoders`, downloads every GLB with byte-level progress, and parses each into an `AssetContainer` template. Textures are uploaded during load. |
| `instantiateWeapon(id)` / `instantiateCharacter(id)` | Clones nodes, the skeleton and animation groups with `instantiateModelsToScene`, keeping original node names |
| `credits`, `requiredCredits`, `manifest` | Manifest data |
| `dispose()` | Disposes the templates. Dispose instances first. |

### `WeaponInstance`

- **Properties:** `root`, `meshes`, `skeleton`, `animation` (one `AnimationGroup`), and `nodes` (TransformNodes by role; `nodes.arms` is the skinned `Mesh`).
- **Playback:** `play(clip, { loop, speed, onEnd })` plays a frame sub-range. It converts source frames to Babylon's 60 fps glTF frames. `onEnd` only fires on natural completion.
- **Other methods:** `stop()`, `goToFrame(frame)`, `hasClip`, `clipDuration`, `setEnabled`, `dispose`.

### `CharacterInstance`

- **Properties:** `root`, `meshes`, `skeleton`, `animations` (a Map from clip name to AnimationGroup), and `bones` (animated TransformNodes by role).
- **Playback:** `play(clip, { loop = manifest loop, speed, blend = 0.15 s, restart, onEnd })` cross-fades by group weights.
- **Other methods:** `stop()`, `setEnabled`, `dispose`.

## Wiring notes for `Game.ts`

1. Create the scene, then `await AssetLibrary.load(scene, onProgress)` before constructing the systems that need models, such as the viewmodel and remote players. Hook `onProgress` to a loading screen or the play overlay. The download is about 18 MB of GLBs plus 0.7 MB of decoders, cached by the browser via `?v=hash`.
2. In DEV, call `installAssetDevTools(library)` next to `installDebugTools`.
3. Pass `library` (or the specific instances) into the viewmodel and character systems. Hand `library.requiredCredits` to the UI.

## Verification

`pnpm assets:verify` runs three layers of checks. All pass as of this writing.

**File level:**

- Hashes match the manifest, and each weapon is at most 6 MB.
- Exactly one skin per file; meshopt is used.
- Weapon animation name and last frame match; node names are unique.
- KTX2 textures: power-of-two sizes up to 2K, mipmaps present, codec and supercompression consistent, sRGB transfer only on base color.
- Character: 20 clips with matching durations, every channel targets a skin joint, locomotion hips drift under 1 mm, all bone roles present.
- Skinned bounds recomputed from the compressed files match the pre-compression manifest bounds within 2 mm, which proves quantization kept the skinning intact.

**Texture decoding:** all 32 KTX2 textures transcode with the hosted decoder bundle and wasm (to BC7 with desktop caps), with the correct gamma flags.

**Runtime:** the real `AssetLibrary` loads headless in a NullEngine, and `runAssetSelfCheck` then checks:

- Each weapon instantiates, all clips play, and `goToFrame` works.
- Muzzle and ejection world positions match the manifest anchors within 2 mm.
- Babylon CPU-skinned bounds match the manifest within 1 cm.
- Two character instances have independent skeletons, and posing one doesn't move the other.
- Head height in rifle idle is 1.53 m; the head ends under 0.6 m at the end of `death_back`.
- Hips stay in place across locomotion cycles.

Not covered: real GPU rendering and visual quality. There's no browser automation in this workflow, so look at it in the running game. In DEV, `installAssetDevTools` runs the same self-check in the browser with real textures.

## Known issues and risks

- **Texture budget.** GPU memory is about 5 MB per 2K texture on BC7. Loading all four weapons and the character comes to roughly 85 MB of texture memory; the arms textures are duplicated in each weapon file. If needed, drop gun ORM maps to 1K in `WEAPON_TEXTURES`.
- **Rifle reload labels.** `reload` vs `reloadEmpty` are a judgment call; see Confidence above.
- **Shotgun clips.** It has no separate `fireLast` or `reloadEmpty`. Rack after reloading an empty gun by playing `pump` after `reloadEnd`.
- **Approximate nodes.** The `ejection` node positions are approximate, and the source camera origin differs per weapon, so the viewmodel needs per-weapon offsets.
- **Character look.** Roughness is derived from specular maps. Grade the character under the scene's HDRI.
