import { Observable } from "@babylonjs/core";
import { createBitReader } from "@twobullets/protocol/bits";
import type { OwnerItemsBlock } from "@twobullets/protocol/messages/snapshot";
import { encodeThrowArg, ThrowableUpdateWriter } from "@twobullets/protocol/messages/throwables";
import { FLASH } from "@twobullets/shared/equipment/flash";
import { THROWABLE_KINDS } from "@twobullets/shared/equipment/items";
import { createVitals } from "@twobullets/shared/equipment/vitals";
import { PlayerActionType } from "@twobullets/shared/input";
import type { RaycastFn, WeaponState } from "@twobullets/shared/weapons/types";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { describe, expect, it } from "vitest";
import type { EquipmentView, UseEvent } from "../../src/equipment/types";
import { createNetLocalInventory, NetEquipmentView } from "../../src/net/NetEquipmentView";
import { NetThrowables, type NetThrowableTarget } from "../../src/net/NetThrowables";

// Networked throwables on the client (protocol v9): the `ThrowableUpdate` mirror drives the local equipment (which owns
// the presentation), and a release in the hands leaves as one `throwItem` action.

/** Records what the mirror asked the local equipment to do. */
function fakeTarget() {
  const calls: { call: string; args: unknown[] }[] = [];
  const record =
    (call: string) =>
    (...args: unknown[]) => {
      calls.push({ call, args });
    };
  const target: NetThrowableTarget = {
    netSpawnThrowable: record("spawn"),
    netMoveThrowable: record("move"),
    netRemoveThrowable: record("remove"),
    netDetonate: record("detonate"),
    netSmokeStart: record("smokeStart"),
    netSmokeEnd: record("smokeEnd"),
    netFireStart: record("fireStart"),
    netFireEnd: record("fireEnd"),
    netFlash: record("flash"),
    netClear: record("clear"),
    setThrowableCounts: record("counts"),
    setNetLife: record("life"),
  };
  return { target, calls, names: () => calls.map((c) => c.call) };
}

function send(net: NetThrowables, build: (w: ThrowableUpdateWriter) => void): boolean {
  const w = new ThrowableUpdateWriter();
  build(w);
  const bytes = w.finish()!;
  return net.apply(createBitReader(bytes), bytes.length);
}

describe("NetThrowables (protocol v9)", () => {
  it("drives the local equipment from the server's ops, in order", () => {
    const { target, calls, names } = fakeTarget();
    const net = new NetThrowables(target);
    const ok = send(net, (w) => {
      w.clear();
      w.spawn({ id: 42, owner: 3, kind: "frag", position: { x: 1, y: 2, z: 3 }, velocity: { x: 4, y: 5, z: 6 }, fuse: 4.5 });
      w.move(42, 1.5, 2.5, 3.5, 0, -1, 0);
      w.detonate(42, 3, "frag", 1.5, 0.1, 3.5, 0, 1, 0);
      w.smokeStart(7, 10, 0, 10, 0xc0ffee);
      w.fireStart(8, 3, -5, 0, -5, 0, 1, 0, 0xbeef);
      w.smokeEnd(7);
      w.fireEnd(8);
      w.remove(99);
      w.flash(42, 1, 0.5);
    });
    expect(ok).toBe(true);
    expect(names()).toEqual(["clear", "spawn", "move", "detonate", "smokeStart", "fireStart", "smokeEnd", "fireEnd", "remove", "flash"]);

    const spawn = calls[1]!.args;
    expect(spawn[0]).toBe(42);
    expect(spawn[1]).toBe(3);
    expect(spawn[2]).toBe("frag");
    expect(spawn[3]).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(spawn[4]).toMatchObject({ x: 4, y: 5, z: 6 });
    expect(spawn[5]).toBeCloseTo(4.5, 3);
    expect(calls[3]!.args[2]).toBe("frag");
    expect(calls[4]!.args[2]).toBe(0xc0ffee);
    expect(calls[5]!.args[4]).toBe(0xbeef);
    // The flash strengths come back as the shared FLASH seconds.
    const exposure = calls[9]!.args[0] as { blind: number; blindSeconds: number; deaf: number; deafSeconds: number };
    expect(exposure.blind).toBe(1);
    expect(exposure.blindSeconds).toBeCloseTo(FLASH.maxBlindSeconds, 5);
    expect(exposure.deafSeconds).toBeCloseTo(0.5 * FLASH.maxDeafSeconds, 1);

    expect(net.stats.spawns).toBe(1);
    expect(net.stats.detonations).toBe(1);
    expect(net.stats.smokes).toBe(1);
    expect(net.stats.fires).toBe(1);
    expect(net.stats.flashes).toBe(1);
    expect(net.stats.malformed).toBe(0);
  });

  it("a malformed message changes nothing", () => {
    const { target, names } = fakeTarget();
    const net = new NetThrowables(target);
    // Just the message id: no `end` op.
    expect(net.apply(createBitReader(Uint8Array.from([0x52])), 1)).toBe(false);
    expect(net.stats.malformed).toBe(1);
    expect(names()).toEqual([]);
    // A different message id is refused too.
    expect(net.apply(createBitReader(Uint8Array.from([0x4e, 0x00])), 2)).toBe(false);
    expect(names()).toEqual([]);
  });

  it("`clear` on disconnect drops every grenade and area effect", () => {
    const { target, names } = fakeTarget();
    const net = new NetThrowables(target);
    net.clear();
    expect(names()).toEqual(["clear"]);
  });
});

describe("throw action (protocol v9)", () => {
  function setup() {
    let now = 1000;
    const weapons: WeaponState = createWeaponState(["rifle", null, "pistol"]);
    const base = { onUse: new Observable<UseEvent>(), inventory: createNetLocalInventory(), vitals: createVitals(), autoPickup: true };
    const net = new NetEquipmentView(base as unknown as EquipmentView, () => now, () => weapons);
    net.setItems({ useItem: 0, useTicks: 0, counts: [0, 0, 0, 0, 0], backpack: 1, ammo: [60, 0, 24, 0], throwables: [2, 1, 0, 0] } satisfies OwnerItemsBlock);
    const raycast: RaycastFn = () => null;
    return {
      net,
      advance: (ms: number) => (now += ms),
      tick: () => net.tickLoot({ eye: { x: 0, y: 1.6, z: 0 }, viewDir: { x: 0, y: 0, z: 1 }, feet: { x: 0, y: 0, z: 0 }, alive: true, interactPressed: false, reviveCandidate: false, raycast }),
    };
  }

  it("a queued throw is the next tick's action and jumps the loot queue", () => {
    const { net } = setup();
    net.swapPrimaries();
    net.queueThrow(encodeThrowArg("frag", "overhand", 4.5));
    const first = net.takeAction()!;
    expect(first.type).toBe(PlayerActionType.throwItem);
    expect(first.arg).toBe(encodeThrowArg("frag", "overhand", 4.5));
    // Only once; the queued swap follows.
    expect(net.takeAction()!.type).toBe(PlayerActionType.equipAttach);
    expect(net.takeAction()).toBeNull();
  });

  it("a cooked frag carries the fuse left; the kinds and styles survive the wire", () => {
    const { net } = setup();
    for (const kind of THROWABLE_KINDS) {
      net.queueThrow(encodeThrowArg(kind, "underhand", 1.5));
      expect(net.takeAction()!.arg).toBe(encodeThrowArg(kind, "underhand", 1.5));
    }
  });
});
