import { Observable, Vector3 } from "@babylonjs/core";
import { encodeThrowArg } from "@twobullets/protocol/messages/throwables";
import type { OwnerItemsBlock } from "@twobullets/protocol/messages/snapshot";
import { createMoveState, SIMULATION, type MoveState } from "@twobullets/shared";
import { countItem } from "@twobullets/shared/equipment/inventory";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { PlayerActionType, type PlayerAction } from "@twobullets/shared/input";
import { createSimWorld, type SimWorld } from "@twobullets/sim/index";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EquipmentSystem, type EquipmentInputSource, type EquipmentPlayer } from "../../src/equipment/EquipmentSystem";
import type { Action } from "../../src/input/bindings";
import { HoldToggles } from "../../src/input/holdToggle";
import { NetEquipmentView, netEquipmentOptions, THROW_PENDING_MS } from "../../src/net/NetEquipmentView";
import type { PlayerTick } from "../../src/player/PlayerController";

// Networked grenade counts on the real local EquipmentSystem (the options Game.ts builds for networked play): a throw is
// sent to the server rather than spawned locally, the bag drops one at once, owner items groups that predate the throw
// don't put it back, and the server's counts win once it has processed the throw.

const DT = 1 / SIMULATION.tickRate;

let world: SimWorld;

beforeAll(async () => {
  world = await createSimWorld(await loadHavok(), ARENA_LEVEL);
}, 60_000);

afterAll(() => world?.dispose());

class FakeInput implements EquipmentInputSource {
  isLocked = true;
  readonly down = new Set<Action>();
  pressed = new Set<Action>();
  readonly holds = new HoldToggles(this);
  isActionDown(action: Action): boolean {
    return this.down.has(action);
  }
  wasActionPressed(action: Action): boolean {
    return this.pressed.has(action);
  }
  wheelDelta(): number {
    return 0;
  }
}

function setup() {
  const [x, y, z] = ARENA_LEVEL.spawnPoints[0]!.position;
  const onTick = new Observable<PlayerTick>();
  const move: MoveState = createMoveState();
  const player = {
    onTick,
    moveState: move,
    tickFeet: { x, y, z },
    getEyeToRef: (out: Vector3) => out.set(x, y + 1.62, z),
    getAim: () => ({ yaw: 0, pitch: 0 }),
  };
  const input = new FakeInput();
  let now = 1000;
  let net!: NetEquipmentView;
  const equipment = new EquipmentSystem(
    world.scene,
    input,
    player as unknown as EquipmentPlayer,
    netEquipmentOptions((release) => net.queueThrow(encodeThrowArg(release.kind, release.style, release.fuse))),
  );
  net = new NetEquipmentView(equipment, () => now);
  let tick = 100;
  const sent: { tick: number; action: PlayerAction }[] = [];
  // NetGame's per-tick order: the equipment's tick, then the input's action; per frame: `lateUpdate`'s items handling.
  const step = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      tick++;
      onTick.notifyObservers({ dt: DT, input: { yaw: 0, pitch: 0 }, playerInput: { tick }, state: move, landingSpeed: 0 } as unknown as PlayerTick);
      const action = net.takeAction(tick);
      if (action !== null) sent.push({ tick, action });
      input.pressed = new Set();
      equipment.update();
      now += DT * 1000;
    }
  };
  let pending = false;
  const serverItems = (throwables: number[], lastProcessedInputTick: number) => {
    const items: OwnerItemsBlock = { useItem: 0, useTicks: 0, counts: [0, 0, 0, 0, 0], backpack: 1, ammo: [60, 0, 24, 0], throwables };
    net.setItems(items);
    pending = true;
    if (pending && net.throwCountsSettled(lastProcessedInputTick)) {
      pending = false;
      equipment.setThrowableCounts(throwables);
    }
  };
  const throwOne = () => {
    input.pressed.add("throwable");
    step(40);
    input.down.add("fire");
    step(2);
    input.down.delete("fire");
    step(1);
    const last = sent.at(-1)!;
    expect(last.action.type).toBe(PlayerActionType.throwItem);
    expect(last.tick).toBe(tick);
    step(40);
    return last.tick;
  };
  return { equipment, net, step, serverItems, throwOne, sent, advance: (ms: number) => (now += ms) };
}

describe("networked grenade counts (EquipmentSystem in server-throwables mode + NetEquipmentView)", () => {
  it("a throw is sent, not spawned; the count drops at once and stale server counts don't restore it", () => {
    const { equipment, net, serverItems, throwOne, sent } = setup();
    expect(equipment.serverAuthority).toBe(true);
    serverItems([2, 1, 0, 0], 0);
    expect(net.view.throwableCounts.frag).toBe(2);

    const shown = net.view.inventory;
    const thrownAt = throwOne();
    expect(sent.filter((s) => s.action.type === PlayerActionType.throwItem)).toHaveLength(1);
    expect(sent[0]!.action.arg).toBe(encodeThrowArg("frag", "overhand", 4.5));
    // Nothing flies locally until the server's spawn arrives.
    expect(equipment.throwables).toHaveLength(0);
    // The HUD (EquipmentHud re-syncs on a new inventory object) and the bag show one frag.
    expect(net.view.inventory).not.toBe(shown);
    expect(net.view.throwableCounts.frag).toBe(1);
    expect(countItem(net.view.inventory, "frag")).toBe(1);

    // Snapshots built before the server processed the throw still say 2.
    serverItems([2, 1, 0, 0], thrownAt - 1);
    expect(countItem(net.view.inventory, "frag")).toBe(1);
    // The server took it.
    serverItems([1, 1, 0, 0], thrownAt);
    expect(countItem(net.view.inventory, "frag")).toBe(1);

    // The last frag: the slot moves on to the smoke.
    const lastAt = throwOne();
    expect(countItem(net.view.inventory, "frag")).toBe(0);
    expect(net.view.inventory.selectedThrowable).toBe("smoke");
    serverItems([1, 1, 0, 0], lastAt - 1);
    expect(countItem(net.view.inventory, "frag")).toBe(0);
    serverItems([0, 1, 0, 0], lastAt);
    expect(countItem(net.view.inventory, "frag")).toBe(0);
    expect(net.view.throwableCounts.smoke).toBe(1);
    expect(net.view.inventory.selectedThrowable).toBe("smoke");
    equipment.dispose();
  }, 60_000);

  it("a throw the server never processed gives the grenade back after the pending window", () => {
    const { equipment, net, serverItems, throwOne, advance } = setup();
    serverItems([0, 1, 0, 0], 0);
    const thrownAt = throwOne();
    expect(countItem(net.view.inventory, "smoke")).toBe(0);
    serverItems([0, 1, 0, 0], thrownAt - 1);
    expect(countItem(net.view.inventory, "smoke")).toBe(0);
    advance(THROW_PENDING_MS);
    serverItems([0, 1, 0, 0], thrownAt - 1);
    expect(countItem(net.view.inventory, "smoke")).toBe(1);
    equipment.dispose();
  }, 60_000);
});
