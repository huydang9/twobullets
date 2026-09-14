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
- **Sketchfab:** WebFetch of model pages returns empty. Use the public API instead: `https://api.sketchfab.com/v3/models/<uid>`. It gives `license.label`, `faceCount`, `animationCount`, `isDownloadable` and `description`, which often holds the clip frame ranges.
- **Poly Haven:** `https://api.polyhaven.com/info/<id>` and `https://api.polyhaven.com/files/<id>` list the files and URLs. No login; agents may fetch these directly with curl.
- **Mixamo:** scripted access is blocked. Confirm clip names via the GitHub snapshot `RobertRosic/Mixamo-Gif-Thumbnails` or community lists, then check them in the browser.
- **Fab:** pages return 403 to fetch. Its Standard License allows any engine, but verify the terms on extractable web builds before relying on it.

## 2. Get the user's OK
List every file with source, format, size (read the size from the download dialog) and license. Wait for an explicit yes. The user logs in to Sketchfab and Adobe themselves; never handle credentials.

## 3. Download via Chrome (claude-in-chrome, the user's logged-in profile)
- **Sketchfab:**
  1. Open the model page and `find` "Download Free 3D Model button". Use `scroll_to` on that ref, then click the "Download 3D Model" link.
  2. The 3D viewer swallows scroll and clicks, so if the dialog doesn't open, re-find and click the ref.
  3. In the dialog, scroll inside it and zoom-screenshot to read the rows. Prefer **.glb, 2K textures**.
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
- **Environment, props and vegetation:** `tools/environment` (Poly Haven fetch/process/props, LODs, leaf cards, KTX2).
- **Audio:** `tools/audio` (CC0 sources in `sources.ts`, loudness-normalized, verify).
- **Credits:** record them in `apps/client/public/assets/**/credits.json`. The HUD credits screen shows them.

## Known good sources (already used)
- DJMaesen/@bumstrum FP weapons (CC-BY)
- Mixamo Swat plus rifle clips
- Poly Haven textures, HDRI, props and trees (CC0)
- Free Firearm Sound Library, Kenney, and rubberduck/OpenGameArt sound packs (CC0)

Full list: `docs/assets-plan.md`, `docs/map/environment-assets.md`, `docs/audio.md`.
