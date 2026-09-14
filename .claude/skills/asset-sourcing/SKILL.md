---
name: asset-sourcing
description: Find, license-check and download free realistic 3D models, animations, textures, VFX and sounds for twobullets (Sketchfab, Mixamo, Poly Haven, ambientCG, OpenGameArt), then hand them to the asset pipelines. Use when the user wants real models/animations instead of procedural or placeholder art.
---

# Sourcing free assets

## 1. Research first (delegate to a research agent, web only, no downloads)
Brief it with the art style (realistic, PUBG-like, matching the DJMaesen FP arms and guns and the Mixamo Swat soldier), the target budgets (tris, texture size) and the license rules below. Ask for 3–6 verified candidates per category, plus a "recommended starter set" with exact download steps.

### License rules
- **Accept:** CC0 (best); CC-BY 4.0 (credit title, author, link, license); Mixamo terms (free for games, never redistribute raw FBX); Poly Haven and ambientCG (CC0).
- **Reject:** CC-BY-NC, "editorial", ripped game assets, unclear origin, Unity/Unreal-only EULAs, or models that credit NC parts. Past example: the Cransh FP packs reuse CC-BY-NC arms.
- **Web builds:** assets are extractable, so the license must allow distribution inside a game.

### Verification techniques that work
- **Sketchfab:** WebFetch of model pages returns empty. Use the public API instead: `https://api.sketchfab.com/v3/models/<uid>`. It gives `license.label`, `faceCount`, `animationCount`, `isDownloadable` and `description`, which often holds the clip frame ranges. It rate-limits (HTTP 429) after many calls; space them out.
  - GLB downloads contain no `license.txt`, so the API check (re-run right before downloading) is the license record. Copy the label into the downloads record.
- **API calls:** send a generic, project-named User-Agent (e.g. `twobullets-asset-research`, like `tools/environment/fetch.mjs`) and nothing that identifies the user: no email, name or tokens in headers, URLs or payloads.
- **Poly Haven:** `https://api.polyhaven.com/info/<id>` and `https://api.polyhaven.com/files/<id>` list the files and URLs. No login; agents may fetch these directly with curl.
- **Mixamo:** scripted access is blocked. Confirm clip names via the GitHub snapshot `RobertRosic/Mixamo-Gif-Thumbnails` or community lists, then check them in the browser.
- **Fab:** pages return 403 to fetch. Its Standard License allows any engine, but verify the terms on extractable web builds before relying on it.

## 2. Record the batch
List every file with source URL, author, format, size (from the download dialog, then `ls -lh`) and license in `assets-src/DOWNLOADS-<date>.md` (see `DOWNLOADS-2026-09-15.md` for the format). Don't wait for approval: the owner's rule is that researched, license-verified downloads need none ("download file don't need my approval"). Report what was downloaded when done. The user logs in to Sketchfab and Adobe themselves; never handle credentials.

## 3. Download via Chrome (claude-in-chrome, the user's logged-in profile)
- **Sketchfab:**
  1. Open the model page and `find` "Download Free 3D Model button". Use `scroll_to` on that ref, then click the "Download 3D Model" link.
  2. The 3D viewer swallows scroll and clicks, so if the dialog doesn't open, re-find and click the ref.
  3. In the dialog, scroll inside it and zoom-screenshot to read the rows. Prefer **.glb, 2K textures**. Some models only offer 1K and 4K (or 8K): take the 4K GLB and let the pipeline downscale it; note "2K not offered → 4K" in the record.
  4. Don't use JS fetches to Sketchfab's internal endpoints; they get blocked.
- **Mixamo:**
  1. Search via URL: `https://www.mixamo.com/#/?page=1&query=<words>&type=Motion` (or `&type=Character`).
  2. Use `find` for the card with the exact title and description (the rifle variant), then click it. Clicking once more may be needed before the right panel shows the clip name.
  3. Tick **In Place** with `form_input` on locomotion clips.
  4. Click the orange Download button, then set the dialog's **Skin** select with `form_input`: "With Skin" for the character, "Without Skin" for animations. The setting resets after navigation, so set it every time. FBX Binary, 30 fps, keyframe reduction none.
  5. If the tab freezes, close it and open a fresh tab in the MCP group.
- **Moving files:** files land in `~/Downloads`. Move only the files you downloaded into `assets-src/<category>/<name>/`, never the user's other files. Check sizes with `ls -lh`.

## 4. Process through the pipelines (delegate to agents)
- **Weapons and characters:** `tools/assets` (`pnpm assets`, `pnpm assets:verify`). FBX→GLB uses the three.js FBXLoader in Node; there is no Blender or Rosetta. Single-baked-clip FP models get clip tables in `tools/assets/config.ts` (published ranges, or `pnpm assets:analyze`).
- **Equipment (throwables, consumables, gear, throw arms):** `tools/assets/equipment` (`pnpm assets:equipment`, after `pnpm assets`). See `docs/equipment/art.md`.
- **Environment, props and vegetation:** `tools/environment` (Poly Haven fetch/process/props, LODs, leaf cards, KTX2; Sketchfab GLBs through `external.mjs`).
- **VFX flipbooks:** `node tools/vfx/build.mjs` (see `docs/fx-throwables.md`).
- **Materials:** Sketchfab GLBs are often spec-gloss (`KHR_materials_pbrSpecularGlossiness`) or carry `KHR_materials_specular`, sometimes with DirectX normals or only a base-colour image. The game expects metal-rough: check the materials when recording the batch; `tools/assets/equipment/item.ts` and `tools/environment/external.mjs` convert them (roughness = 1 − gloss, drop the specular extensions).
- **Audio:** `tools/audio` (CC0 sources in `sources.ts`, loudness-normalized, verify).
- **Credits:** record them in `apps/client/public/assets/**/credits.json`. The HUD credits screen shows them.

## Known good sources (already used)
- DJMaesen/@bumstrum FP weapons (CC-BY)
- Mixamo Swat plus rifle clips
- Poly Haven textures, HDRI, props and trees (CC0)
- Free Firearm Sound Library, Kenney, and rubberduck/OpenGameArt sound packs (CC0)

Full list: `docs/assets-plan.md`, `docs/map/environment-assets.md`, `docs/audio.md`.
