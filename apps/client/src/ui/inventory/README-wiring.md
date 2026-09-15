# Inventory icons: Game.ts wiring

`InventoryScreen` takes an optional fourth argument with the model sources for the baked item icons. Without it the
screen still works and shows SVG silhouettes.

In `apps/client/src/game/Game.ts`, replace

```ts
const inventory = new InventoryScreen(hudRoot, equipment, input);
```

with

```ts
// Item icons are baked from the real models a few ms per frame right after load (inventory.update() runs the baker).
const inventory = new InventoryScreen(hudRoot, equipment, input, {
  icons: { scene, assets, models: presentationLootModels(presentation.itemMeshes) },
});
```

`presentationLootModels` is already imported there. `inventory.update()` must stay after `this.scene.render()` in the
frame loop (it is today): the icon studio renders its own offscreen scene and must never run inside the game scene's
render.

DEV tuning: `ICON_VIEWS` / `ICON_LIGHTING` in `icons/IconStudio.ts` are mutable; change them from the console via a
module import or edit and reload, then `__twobullets.inventory.icons.rebake()`.
