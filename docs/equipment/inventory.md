# Items, inventory and loot (equipment phase 2)

How weapons, ammo, ground loot, pickups and the inventory screen work on top of the phase 1 rules in [design.md](design.md). Everything gameplay-relevant is pure shared code; the client adds Havok sight lines, rendering and DOM.

Contents:

1. [Code map](#1-code-map)
2. [Weapon slots and ammo from the inventory](#2-weapon-slots-and-ammo-from-the-inventory)
3. [Weapon gate](#3-weapon-gate)
4. [Ground loot and interaction](#4-ground-loot-and-interaction)
5. [Loot rendering](#5-loot-rendering)
6. [Inventory screen](#6-inventory-screen)
7. [Damage through armor](#7-damage-through-armor)
8. [Life control for Game](#8-life-control-for-game)
9. [Wiring](#9-wiring)
10. [Verification](#10-verification)
11. [Risks and follow-ups](#11-risks-and-follow-ups)
12. [Networked play (B5)](#12-networked-play-b5)

## 1. Code map

| File | Contents |
|---|---|
| `packages/shared/src/weapons/types.ts`, `weaponStep.ts` | `WeaponState.slots: (WeaponSlotState \| null)[]`, `createWeaponState([id \| null])`, `cycleWeaponSlot` (wheel skips empty slots) |
| `packages/shared/src/equipment/weaponLoadout.ts` | `weaponStateFromInventory`, `syncWeaponsFromInventory`, `commitWeaponsToInventory`, `gateCombatInput` |
| `packages/shared/src/equipment/inventory.ts` | `wantsAutoPickup`; `pickUp(…, replaceSlot)` now prefers `replaceSlot` when it is an empty slot of the right class |
| `packages/shared/src/equipment/presets.ts` | `createTestLoot(spawns)`: arena test piles |
| `apps/client/src/combat/CombatSystem.ts` | `attachEquipment(link)`, `gate`, `armed`, `AMMO_FROM_INVENTORY`, `targetArmor` |
| `apps/client/src/combat/CombatInputQueue.ts` | Number keys and wheel over filled slots only |
| `apps/client/src/combat/TargetArmor.ts` | Helmets/vests on practice soldiers; DEV `?targetArmor=1` mix |
| `apps/client/src/combat/types.ts` | `CombatEquipmentLink`, `CombatView.armed`, armor fields on `DamageEvent` |
| `apps/client/src/combat/hitboxes.ts` | `DamageHit.kind` |
| `apps/client/src/equipment/EquipmentSystem.ts` | Loot interaction, auto pickup, revive, `EquipmentPlayerControl`, `CombatEquipmentLink` |
| `apps/client/src/equipment/types.ts` | Appended: `ReviveTarget`, `ReviveActionEvent`, `EquipmentItemsView`, `EquipmentItemActions` |
| `apps/client/src/equipment/loot/LootRenderer.ts` | Thin-instanced ground loot, distance culling, outline highlight |
| `apps/client/src/equipment/loot/lootModels.ts` | Gun bodies from the weapon GLBs, procedural gear/ammo/placeholder meshes, `LootModelFactory` |
| `apps/client/src/equipment/loot/presentationModels.ts` | Adapter from the presentation's `ItemMeshLibrary` to `LootModelFactory` |
| `apps/client/src/equipment/loot/lootAction.ts` | `previewLootAction`: "Pick up" / "Swap" / "Equip" for prompts |
| `apps/client/src/ui/inventory/InventoryScreen.ts`, `inventory.css` | Tab screen |

## 2. Weapon slots and ammo from the inventory

The inventory is the source of truth for which weapons are carried, their magazines and the ammo. `CombatSystem` keeps simulating a `WeaponState`, mirrored from the inventory every tick once `attachEquipment` has been called. Without it, combat runs the old standalone 4-weapon loadout.

Per tick, inside `CombatSystem.tick` (combat ticks before equipment):

1. If `equipment.loadoutVersion` changed (respawn kit), rebuild with `weaponStateFromInventory`: drawn and ready.
2. `syncWeaponsFromInventory(state, inventory)`. Slot *i* mirrors `inventory.weapons[i]` (0 primary 1, 1 primary 2, 2 sidearm):
   - The same weapon (id **and** magazine) keeps its slot state.
   - Anything else is a different weapon: picked up, swapped or dropped.
   - `reserve` = rounds of the weapon's ammo item in the bag (`reserveFor`).
   - If the active slot's weapon changed, a reload is cancelled and the new one is drawn (`equipStarted`). If the active slot emptied, the first filled slot is drawn. With every slot empty the player is unarmed (nothing fires, aims or reloads), and the first weapon picked up is drawn.
3. Gate the input (§3), then `stepWeapon`.
4. `commitWeaponsToInventory(before, after, inventory)` writes magazines back and removes the rounds a reload loaded: `consumeAmmo(reserveBefore − reserveAfter)`. `EquipmentSystem.commitWeapons(inventory, activeSlot)` stores it and remembers the slot in hand.

Consequences:

- A weapon's magazine travels with it: drop a rifle with 27 rounds, pick it up later, it still has 27.
- The HUD reserve (`weaponState.slots[i].reserve`) is the bag count, one tick behind a pickup at most.
- Keys 1/2/3 select filled slots; 4 is unbound until melee. The wheel skips empty slots (`cycleWeaponSlot`).
- `CombatView.activeWeapon` never throws: while unarmed it stays the last weapon held. Check `CombatView.armed` before drawing a viewmodel or ammo readout.
- `AMMO_FROM_INVENTORY = true` in `CombatSystem.ts`. With `false`, reserve is per weapon (`WeaponDef.reserveAmmo` on a new weapon) and ammo items are never consumed.

## 3. Weapon gate

`gateCombatInput(input, allowWeapons, fireLatched)`, with `allowWeapons` from `combat.gate?.()` or the attached equipment's `modifiers`:

- Blocked (throwable drawn or in the throw animation, item in use, downed, reviving a teammate): `fire`, `aim` and `reload` are dropped; weapon selection still goes through (the equipment side puts the throwable away on 1–3/wheel).
- After the gate lifts, fire stays blocked until the trigger is released. The click that throws a grenade, or that cancels a heal, never also fires the gun.
- After a throw with more of that kind carried, the next grenade is drawn automatically (PUBG), so the gun stays gated until 1/2/3 or X.
- The gate reads last tick's equipment state (equipment ticks after combat): at most 16 ms late.

## 4. Ground loot and interaction

Ground loot always exists now:

- **Map mode** (`options.map`): `generateLoot` (design.md §6).
- **Otherwise**: `options.loot`, defaulting to `createTestLoot(ARENA_LEVEL.spawnPoints)`. That is one pile 3 m in front of every arena spawn: shotgun, 12 Gauge, 5.56mm, P-9, helmet L3, vest L1, backpack L3, bandages, med kit, frag, smoke and energy drink.

Rules in `EquipmentSystem` (the server re-validates reach, sight and capacity):

| Rule | Value |
|---|---|
| Nearby list | Items within `INTERACT.reach` (2.6 m) of the eye **and visible**: a static-world ray from the eye to 0.15 m above the item. Refreshed at 10 Hz. |
| Look-at target | `pickLootTarget` every tick over the nearby list: the smallest angle inside a 35° cone, else the nearest |
| F pressed | A downed teammate in revive reach takes priority (hold). Otherwise picks up the look-at target |
| Pickup distance | Eye to item ≤ reach + 0.4 m slack |
| Weapon swap | Both primaries full: replaces the primary in hand (primary 1 when holding the sidearm or unarmed). The old weapon drops where the new one lay, with its magazine. Inventory drag onto a slot uses that slot. |
| Armor/backpack | Swaps; the worn piece drops with its durability. A smaller backpack that can't hold the bag fails with `overCapacity`. |
| Stacks | As much as fits by weight; the remainder stays with its loot id |
| Auto pickup (`equipment.autoPickup`, default on; toggle in the inventory, stored in `localStorage`) | At 10 Hz, visible items within 1.1 m horizontally of the feet (−0.6..+0.4 m in height) when `wantsAutoPickup`: ammo for a carried weapon, heals, boosts and throwables with at least one unit fitting. Never gear. Never an item the player dropped. Failures are silent. |
| Failed explicit pickup | `onItem { type: "pickupFailed", error }`: `full` or `overCapacity` |
| Drops | 0.55 m in front of the feet on a small ring (at the feet if a wall is in the way), settled onto the floor below. `onItem dropped`; `dropFailed { error }` when a vest/backpack can't come off |
| Looting while busy | Allowed while healing or holding a throwable (it doesn't cancel anything); not while downed or dead |

**Revive.** `options.teammates: () => ReviveTarget[]` (`{ id, displayName?, feet, vitals, setVitals }`):

- A downed teammate within `VITALS.reviveRange` (2 m horizontal, ±1.2 m height), with the local player's hands free, becomes the candidate. `equipment.revive = { targetName, progress: null }` drives the "F  Revive" prompt.
- Pressing F starts `stepRevive`, and holding it continues it. Releasing, leaving range, using an item, drawing a throwable or being knocked cancels it.
- Events: `onReviveAction` `started`/`progress`/`cancelled`/`completed`; `equipment.revive.progress` is 0..1.
- While reviving, `modifiers` roots the player (speed 0, no sprint, jump or weapons).
- Nothing offline provides teammates yet. The DEV `?teammate=1` flow revives the **local** player through `setReviver` (§8).

## 5. Loot rendering

`LootRenderer` (`equipment/loot/`), one `update()` per frame:

- **Batches.** One template mesh per item id (26 in the catalog), created on first sight and drawn with **thin instances**. Map v1 (414 items) costs at most 26 draw calls, plus one per material of the multi-material gun meshes. In the headless check near a town house, 134 items were in the buffers.
- **Culling.** Only items within 70 m of the camera are in the buffers (ammo, meds and grenades within 40 m). Buffers are rebuilt from the 8 m spatial hash when `groundLoot.version` changes or the camera has moved 4 m; `thinInstanceRefreshBoundingInfo` keeps frustum culling per batch.
- **Placement.** On the floor point + 4 mm. The yaw is shared by the pile, with ±20° jitter per item, deterministic from the pile and loot ids.
- **Highlight.** The `lootTarget` instance is zeroed in the buffer, and a clone of the template (shared geometry and materials) with a thin warm outline (`renderOutline`, 6 mm) is drawn in its place.
- **Models:**
  - **Weapons.** The gun body of each first-person GLB (`nodes.body` parts at the idle pose, like the soldiers' rifle), merged with private vertex data (only attributes every part has) and laid on its side: rifle 1.01 m, sniper 1.53 m, shotgun 1.05 m, pistol 0.25 m long. Without assets (headless) they're box placeholders.
  - **Throwables and consumables.** `LootModelFactory.createLootModel(itemId)`. `presentationLootModels(new ItemMeshLibrary(scene))` adapts the presentation's meshes: a private copy resting on its flattest side. Without a factory they're procedural vertex-coloured placeholders.
  - **Ammo boxes** (coloured by caliber), **helmets, vests, backpacks** (tan/olive/black by level, more pouches and rails at higher levels). Procedural, vertex-coloured, one shared PBR material, excluded from `skyFill` (lit by the IBL), receiving shadows.

## 6. Inventory screen

`new InventoryScreen(hudRoot, equipment, input)` and `inventory.update()` every frame. It is DOM inside `.tb-hud`, so it uses the HUD tokens.

**Layout** (three columns on a dim full-screen backdrop):

| Vicinity | Bag | Equipment |
|---|---|---|
| Visible ground items within reach, nearest first (name, quantity / durability % / loaded rounds) | Weight bar `used / max` (amber when full), one row per stack in catalog order | Weapon cards 1–3 (name, `magazine / bag ammo`, caliber; dashed when empty). Helmet, vest (level + durability bar, amber under 30 %), backpack. Throwable chips (count, selected outlined) |

The footer has the hints and the **Auto pickup** toggle. Refusals (`pickupFailed`, `dropFailed`) show as an amber notice.

**Controls:**

| Action | Result |
|---|---|
| Tab (the `inventory` binding) while playing | Opens: releases pointer lock, look and movement input stop, the game keeps running. The play overlay is hidden by CSS while open. |
| Tab or Esc while open | Closes and requests pointer lock again (keydown is a user gesture); if the browser refuses, the play overlay's click re-locks |
| Drag vicinity → bag or equipment | Pick up (equip/swap for gear) |
| Drag vicinity weapon → weapon card | Pick up into that slot (swap if full) |
| Drag primary card ↔ primary card | Swap primaries |
| Drag bag stack / weapon / armor / backpack → vicinity | Drop (the whole stack) |
| Ctrl/Shift + drag a stack → vicinity | Quantity popover (slider + number, Enter to confirm) |
| Right-click vicinity item | Pick up |
| Right-click bag heal/boost | Use |
| Right-click bag throwable, or click a throwable chip | Select it for key 5 (`selectThrowable`) |
| Right-click bag ammo | Quantity popover to drop |
| Right-click weapon card / helmet / vest / backpack | Drop |

**Performance.** All nodes are created once (the bag has a row per stackable id; vicinity rows are pooled). While open, each frame compares the inventory object and a `lootId:quantity` signature of the vicinity list, and writes text only where a row's key changed. Closed, `update()` returns immediately.

## 7. Damage through armor

- **Local player.** Every hit goes through `applyDamage` (armor → health → knocked/eliminated) in `EquipmentSystem.damageLocal`:
  - grenades (vest), fire (no armor)
  - `damagePlayer` for falls now and bot bullets later: a bullet with `zone` head → helmet, body → vest
  - `canBeKnocked` decides knock vs eliminate
- **Practice soldiers.** `CombatSystem.targetArmor` (`TargetArmor`) holds per-target loadouts:
  - **Bullets:** `applyArmor(armor, damage, "bullet", zone)` before `owner.applyDamage({ …, amount: afterArmor, kind: "bullet" })`.
  - **Grenades:** go through the same registry when Game passes it to `soldierTargets(dummies, combat.targetArmor)`.
  - **Respawn:** a soldier gets its issued armor back when it respawns.
  - **Default:** soldiers wear nothing. DEV `?targetArmor=1` gives every third soldier an L2 helmet and vest, and the next one an L1 vest.
- `DamageEvent` carries `armorAbsorbed`, `armorSlot` and `armorDestroyed` for hit markers and audio.
- `DamageHit.kind` is `"bullet"` for gunfire and the area kind for grenades and fire.

## 8. Life control for Game

`EquipmentSystem` implements `EquipmentPlayerControl`:

| Member | Behaviour |
|---|---|
| `damagePlayer(hit)` | Same path as grenade damage: armor, `onArmor`, `onVitals damaged/knocked/eliminated` |
| `canBeKnocked` | Settable, default false (solo) |
| `setReviver(id \| null)` | While set and downed: `stepRevive` each tick before vitals (bleed pauses), `reviveStarted` → `reviveProgress` (0..1 every tick) → `revived` + `healed { source: "revive" }`. `null` cancels (`reviveCancelled`) |
| `resetLoadout(inventory?)` | Fresh inventory (default `createStartingInventory()`: AR-4, P-9, 1 frag, 1 smoke), idle throw/use, full vitals, cancels revives, bumps `loadoutVersion` (combat rebuilds its weapons) and emits `respawned`. Game owns the respawn timer; `EquipmentSystem` no longer respawns or touches `player.modifiers`. |

`equipment.modifiers` are the combined gates (equipment state plus the reviving root) that Game feeds to `player.setMoveGates`.

## 9. Wiring

`Game.ts` (integration owner) needs, after creating `combat` and `equipment`:

```ts
combat.attachEquipment(equipment); // slots, magazines, ammo items, gate, health
const targets = soldierTargets(combat.targets.dummies, combat.targetArmor);
// EquipmentSystem can take `player` directly now (it no longer writes player.modifiers).
const loot = new LootRenderer(scene, equipment, {
  assets,
  skyFill: environment.skyFill,
  models: presentationLootModels(new ItemMeshLibrary(scene)), // or the presentation's own library instance
});
const inventory = new InventoryScreen(hudRoot, equipment, input);
// frame loop, after equipment.update(): loot.update(); inventory.update();
```

## 10. Verification

- **`pnpm test`** (shared): `weaponLoadout.test.ts` covers:
  - empty slots (creation, selection, unarmed, wheel skipping)
  - inventory mirroring
  - swap keeps magazines
  - drop draws the next weapon, and unarmed draws the first pickup
  - reload consumes ammo items (full and partial)
  - the flag-off reserve
  - the gate, including "can't shoot while holding a grenade" with `stepPlayerEquipment`
  - auto pickup rules and test piles
- **Headless** (NullEngine + Havok, Map v1 terrain and 43 buildings, real `PlayerController` with scripted input, `CombatSystem` attached, `LootRenderer` with the real GLBs):
  1. **Grenade.** A drawn smoke with fire held for 40 ticks (pin pulled) fired 0 shots. Fire still held through the throw: 0 shots. Key 1 put the auto-drawn next smoke away, and a fresh click fired 1 shot.
  2. **Reload.** The rifle fired 8 (29 → 21), R reloaded to 30, and 5.56mm in the bag went 120 → 111. HUD reserve 111.
  3. **House pile.** The player walked into `town_house_nw1/living` to a pile (painkiller, smoke, backpack L2). Auto pickup took the painkiller and smoke; F with the outline highlight on the backpack swapped it ("Swap").
  4. **Weapon swap.** F on a shotgun with full primaries swapped the rifle in hand: the rifle dropped with its 28 rounds, and combat got `equipStarted:shotgun` with slot 1 = shotgun 3/0.
  5. **Drops.** Dropping 2 bandages left them on the ground (auto pickup ignored them). Dropping the backpack with a full bag → `dropFailed`.
  6. **Life control.** `damagePlayer` with `canBeKnocked` → knocked (gate closed, 0 shots) → `setReviver` → revived at 10 HP after 5 s. `resetLoadout` → combat back to rifle 30/120, sniper 5/20, pistol 12/48.

## 11. Risks and follow-ups

1. **One-tick windows.** Combat reads the gate and the inventory before equipment ticks, so a weapon pickup shows in `WeaponState` one tick later, and a throwable key press can coincide with one last gun tick.
2. **Magazine identity.** "Same weapon" means same id and magazine. Dropping a weapon and picking up an identical one with the same magazine in one tick keeps the old slot state (harmless).
3. **Unarmed presentation.** With every slot empty `activeWeapon` is the last weapon; the viewmodel/HUD should hide on `!combat.armed`.
4. **Sight line.** It targets 0.15 m above the floor point, so an item under a low table edge can be hidden from some angles.
5. **Outline cost.** The highlight uses Babylon's outline renderer (an extra pass for one small mesh). Swap to an emissive pulse if it shows in profiles.
6. **Drag and drop** uses HTML5 DnD: no custom drag image, and on macOS Ctrl+click is a right-click (use Shift+drag to split).
7. **`groundLoot`** is never null any more; the phase 1 doc comment on `EquipmentView.groundLoot` still says "null outside map mode".

## 12. Networked play (B5)

Online matches use the same shared rules with the server as the only authority (protocol v7; wire details in [../backend/netcode.md](../backend/netcode.md) §8.3 and §9.5).

| Piece | Where | What it does |
|---|---|---|
| Generation | `apps/server-match/src/level/serverLevel.ts` (`createLoot`) | The practice call, `generateLoot(seed, pois, buildings, { flatten, terrain, layout })`, on the server's map data (arena: `createTestLoot`). Clients never generate loot online. |
| Ground loot and actions | `apps/server-match/src/match/ServerLoot.ts` | Drops throwables, validates `pickup`/`drop`/`equipAttach` actions (reach 3.5 m from the eye, sight ray, not reviving, shared `pickUp`/`drop`/`swapWeapons`), death piles, per-client area-of-interest streaming. |
| Inventory on the server | `Player.inventory`, `ServerMatch.step` | Weapons follow it every tick (`syncWeaponsFromInventory`/`commitWeaponsToInventory`, reserve from ammo items); `Player.armor` mirrors its helmet and vest for `applyDamage`. |
| Starting kit | `createNetStartingInventory()` (`presets.ts`) | Practice kit without grenades: AR-4, P-9, 60 + 24 spare rounds, Lv1 backpack. Join and every respawn, humans and bots. |
| Server bots | `ServerBots` (`queryLoot`) | The shared bot brain's loot goals against server loot, through the same `pickup` action. |
| Client mirror | `apps/client/src/net/NetLoot.ts` | Applies `LootUpdate` ops to a `GroundLoot`, remembers the player's own drops. |
| Client view | `apps/client/src/net/NetEquipmentView.ts` | Inventory from the owner groups (weapons from the predicted weapon state), nearby items with a sight ray, F target and F, auto pickup, inventory-screen pickups/drops/swap as actions, `picked`/`dropped` events when the loot stream confirms. |
| Rendering | `Game.ts` | `LootRenderer` runs online on the net view (`net.equipmentFor(equipment)`). |

**Throwables are not online.** Frag, smoke, flash and molotov are left out of online loot, the starting kit and death piles because the match server doesn't simulate throwables (no flight, detonation, smoke or fire on the server). Offline practice keeps them. Networking them is the next B5 step (netcode.md §9.1–9.3).

**Not predicted.** Pickups, drops and swaps apply when the server's result arrives (about one RTT). The client only refuses early what the shared rule already refuses on its copy of the server inventory (full bag, nothing to drop).

**Gaps:** remote players show the generic rifle model for any held gun; a drop quantity above 255 goes out as several ground stacks; ids past 16,383 are reused for drops.
