# Offline bot match: Game.ts wiring

For the lead to apply (agent C does not edit `game/Game.ts`). Everything is gated on `?bots=1`, which is DEV-only like `?map=v1` and implies it. Without the flag nothing changes.

## 1. Import

```ts
import { OfflineMatch, readOfflineMatchOptions } from "../match";
```

## 2. `Game` constructor: one more field

```ts
    private readonly dynamicResolution: DynamicResolution | null,
    private readonly match: OfflineMatch | null,
  ) {}
```

## 3. `Game.create`

Map selection (replace the `mapV1` line):

```ts
    // DEV: `?bots=1` runs the offline bot match (docs/bots/design.md §11); it implies `?map=v1`.
    const matchOptions = readOfflineMatchOptions(window.location.search);
    const botsMatch = import.meta.env.DEV && !benchmark && !netConfig && matchOptions.enabled;
    const mapV1 = import.meta.env.DEV && !netConfig && (params.get("map") === "v1" || benchmark === "v1" || botsMatch);
```

Combat without practice soldiers (replace the `new CombatSystem` line):

```ts
    const combat = new CombatSystem(scene, input, player, levelData, environment, assets, { targets: !botsMatch });
```

Life without respawn (replace the `new PlayerLife` line):

```ts
    const life = new PlayerLife(player, equipment, equipment, { teammate: import.meta.env.DEV && params.get("teammate") === "1", respawn: !botsMatch });
```

After `installDebugTools(...)` and before the perf tools block:

```ts
    // Builds the nav grid (≈0.5 s), pooled bot soldiers and the spawn plan; the match starts on the first pointer lock.
    const match = botsMatch && world ? await OfflineMatch.create({ scene, input, player, combat, equipment, life, presentation, hud, world, assets, environment }, matchOptions) : null;
```

`new Game(...)`: pass `match` last:

```ts
    const game = new Game(engine, scene, input, player, combat, equipment, presentation, hud, loot, inventory, world, perf, dynamicResolution, match);
```

DEV handle: add `match` to the `__twobullets` object:

```ts
      Object.assign(window, { __twobullets: { engine, scene, input, player, combat, equipment, life, presentation, hud, loot, inventory, assets, world, perf, net, match: match?.createDevHandle() ?? null } });
```

## 4. Frame loop (`start`)

Right after the player update, before combat/presentation (bots are posed and the spectate camera overrides the player camera before anything reads it):

```ts
      if (!perf?.drivesCamera) this.player.update(dt);
      this.match?.update(dt);
      this.net?.lateUpdate(dt);
```

## Notes

- Order matters: `OfflineMatch` subscribes to `player.onTick` when the match starts, after CombatSystem, EquipmentSystem and PlayerLife subscribed, so `MatchSim.tick()` runs after the human's weapon, equipment and life steps.
- `mountMatchLayer()` must run after `hud.attachCombat(...)` (it does: the match is created later in `create`).
- `soldierTargets(combat.targets.dummies, ...)` stays; with `targets: false` the list is empty and the match installs its own equipment targets and teammates (`setTargetsSource`, `setTeammatesSource`).
- The nav grid builds on the main thread after the map loads (≈0.5–0.7 s hitch while the play overlay is up). Moving it into the map worker is a follow-up in `world/mapRuntime` (not C's).
- HUD preview without bots (DEV console, any page): `import("/src/match/mockMatchView.ts").then((m) => m.previewMatchHud(__twobullets.hud))`.
