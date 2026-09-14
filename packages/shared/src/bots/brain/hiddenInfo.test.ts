import { describe, expect, it } from "vitest";
import { box, createTestRaycast } from "../../equipment/testWorld";
import { dequantizeYaw } from "../../aim";
import { Btn } from "../../input";
import { BOT_PROFILES } from "../profiles/profiles";
import type { ActorSnapshot } from "../types";
import { createBotBrain } from "./brain";
import { TestWorld } from "./testWorld";
import { wrapAngle } from "./util";

// Bots must never read hidden information (design.md §4, §12.1): enemy health or inventory, or positions they have not
// perceived. Three layers: a source scan (only perception reads `view.actors`), a runtime trap on the view and on
// actor snapshots, and a behavioral wallhack check.

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

const sources = import.meta.glob("/src/bots/**/*.ts", { query: "?raw", import: "default", eager: true });
const OWNED = /^\/src\/bots\/(brain|perception|aim|memory|motor|goals|profiles)\//;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("bots never read hidden information", () => {
  const files = Object.keys(sources).filter((f) => OWNED.test(f) && !f.endsWith(".test.ts") && !f.endsWith("testWorld.ts"));

  it("covers the brain sources", () => {
    expect(files).toContain("/src/bots/brain/brain.ts");
    expect(files).toContain("/src/bots/perception/perception.ts");
  });

  it.each(files)("%s: only perception reads view.actors; no Math.random or engine imports", (file: string) => {
    const code = stripComments(sources[file]!);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/from\s+["']@babylonjs/);
    if (!file.startsWith("/src/bots/perception/")) {
      expect(code, `${file} reads .actors of a world view`).not.toMatch(/\bview\.actors\b/);
      expect(code, `${file} reads a world view's actors`).not.toMatch(/\bactors\s*[,}]\s*=\s*view\b/);
    }
  });

  it("the view's actor list is read only from perception, and hostile health/inventory never", () => {
    const wall = createTestRaycast([box([-6, 0, 12], [6, 5, 13])]);
    const world = new TestWorld({ raycast: wall });
    world.addActor(5, 3, 0, 40, { velocity: { x: 1, y: 0, z: 0 } });
    world.addActor(6, 3, 30, 20);
    world.addTeammate(3, -4, -2);

    // Snapshots carry the full sim state (as a careless host might pass): hidden fields throw on access.
    const hidden = new Set(["health", "downedHealth", "boost", "vitals", "inventory", "armor", "helmetLevel", "vestLevel", "kills", "healCount"]);
    const trapped = world.actors.map((actor) =>
      actor.team === world.self.team
        ? actor
        : new Proxy({ ...actor, health: 37, vitals: { health: 37 }, inventory: {} }, {
            get(target, key, receiver) {
              if (typeof key === "string" && hidden.has(key)) throw new Error(`bot read hidden field "${key}" of slot ${actor.slot}`);
              // Keep poses live: read through to the fixture actor.
              return Reflect.get(key in actor ? actor : target, key, receiver);
            },
          }),
    );
    const readers = new Set<string>();
    Object.defineProperty(world.view, "actors", {
      get() {
        const stack = new Error().stack ?? "";
        const caller = stack.split("\n").slice(2, 4).join("\n");
        readers.add(/perception\.ts/.test(caller) ? "perception" : caller);
        return trapped as readonly ActorSnapshot[];
      },
    });

    const brain = createBotBrain({ slot: world.self.slot, team: world.self.team, seed: 9, profile: BOT_PROFILES.hard });
    expect(() => world.run(brain, 900, { move: false })).not.toThrow();
    expect([...readers]).toEqual(["perception"]);
  });

  it("an enemy behind a wall is never targeted, remembered or aimed at", () => {
    const wall = createTestRaycast([box([-6, 0, 12], [6, 5, 13])]);
    const world = new TestWorld({ raycast: wall, yaw: 0 });
    // Right in front behind the wall; noisy only in the sense of existing.
    world.addActor(5, 3, 0, 30, { velocity: { x: 0.5, y: 0, z: 0 } });
    // An unseen enemy far to the side (outside the field of view, beyond proximity).
    const flank = world.addActor(7, 4, 25, -20);
    const brain = createBotBrain({ slot: world.self.slot, team: world.self.team, seed: 3, profile: BOT_PROFILES.hard });
    let fired = 0;
    let aimedAtFlank = 0;
    world.run(brain, 1200, {
      move: false,
      onTick: () => {
        if ((world.out.input.buttons & Btn.fire) !== 0) fired++;
        const yaw = dequantizeYaw(world.out.input.yawQ);
        const toFlank = Math.atan2(flank.feet.x - world.self.feet.x, flank.feet.z - world.self.feet.z);
        if (Math.abs(wrapAngle(yaw - toFlank)) < 0.1) aimedAtFlank++;
        expect(brain.perception.threatSlot).toBe(-1);
        expect(brain.debug().targetSlot).toBe(-1);
      },
    });
    expect(fired).toBe(0);
    expect(brain.memory.count).toBe(0);
    for (const slot of [5, 7]) {
      const t = brain.perception.actors.find((a) => a.slot === slot);
      expect(t === undefined || (!t.visible && t.awareness === 0)).toBe(true);
    }
    // The idle scan sweeps ±60°: the flank at ~129° is never faced on purpose.
    expect(aimedAtFlank).toBe(0);
  });
});
