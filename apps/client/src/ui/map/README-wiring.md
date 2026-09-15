# Map (M) and minimap: Game.ts wiring

For the lead to apply (the HUD agent does not edit `game/Game.ts`). Only map modes get a map: `?map=v1`, `?bench=v1` and `?bots=1`. The arena has no `world`, so nothing is attached and M does nothing there.

## 1. Import

```ts
import { cameraMapSource } from "../ui/map";
```

## 2. `Game.create`: attach after the equipment HUD

Right after `hud.attachEquipment(equipment);` (before `new InventoryScreen`, so the map shares the HUD layer order the inventory uses):

```ts
    // M: full-screen map (N zooms, wheel/drag), minimap bottom right. The image renders in ≤8 ms slices from MapData.
    // Plain map mode shows the player only; OfflineMatch swaps in zone and teammates when the match starts.
    if (world && !benchmark) hud.attachMap({ world, input, source: cameraMapSource(player.camera) });
```

`world` is the `MapRuntime` (it has `map`, `terrain` and `layout`); `player.camera` satisfies `MapCamera` (globalPosition + rotation.y). Skipping the benchmark keeps its numbers comparable with earlier runs; drop `!benchmark` to include the map cost.

Nothing else: `Hud.update` already drives the map at ≈15 Hz, `Hud.setLocked`/`setModal` handle minimap visibility and close the map for death/result screens, and `OfflineMatch.start()` calls `hud.setMapSource(matchMapSource(sim, frame))` itself.

## Optional

- Play overlay control list (`ui/PlayOverlay.ts`, not owned by the HUD map agent): add `M` "Map" and `N` "Map zoom".
- Networked play (`?net=`) runs the arena, so no map; when the server gets Map v1, attach the same way and give `setMapSource` a source built from the net match state.
