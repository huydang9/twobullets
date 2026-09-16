import { describe, expect, it } from "vitest";
import { NO_ARMOR } from "../equipment/armor";
import { createVitals } from "../equipment/vitals";
import { Btn } from "../input";
import type {
  ActorConfig,
  BrMatchConfig,
  ExternalActorPose,
  MatchEvent,
  MatchExternalActor,
  MatchState,
  MatchView,
  ZoneState,
} from "../match/types";
import {
  BOT_SCHEDULE,
  DEFAULT_BOT_DIFFICULTY,
  NavFlag,
  type BotBrain,
  type BotBrainFactory,
  type BotMemory,
  type BotPerception,
  type BotProfile,
  type BotTickOutput,
  type BotWorldView,
  type NavGrid,
  type NavPath,
  type NavQuery,
  type PathStatus,
} from "./types";

// Compile-time check of the bot and match contracts (docs/bots/design.md): trivial stubs must satisfy every interface.
// `pnpm typecheck` is the real test; the runtime assertions only keep vitest honest.

const ZERO = { x: 0, y: 0, z: 0 };

const grid: NavGrid = {
  info: {
    version: 1,
    cellSize: 0.5,
    buildingCellSize: 0.25,
    coarseCellSize: 4,
    originX: -250,
    originZ: -250,
    width: 2000,
    depth: 2000,
    terrainNodes: 1_000_000,
    buildingNodes: 0,
    components: 1,
    byteLength: 0,
    checksum: "stub",
  },
};

class StubNav implements NavQuery {
  readonly grid = grid;
  private status: PathStatus = "pending";
  nearest(p: { x: number; y: number; z: number }, _maxDistance: number, out: { x: number; y: number; z: number }): number {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    return 0;
  }
  flagsAt(): number {
    return NavFlag.walkable;
  }
  reachable(): boolean {
    return true;
  }
  lineWalkable(): boolean {
    return true;
  }
  requestPath(): number {
    this.status = "found";
    return 1;
  }
  readPath(_handle: number, out: NavPath): PathStatus {
    out.count = 0;
    out.length = 0;
    return this.status;
  }
  releasePath(): void {
    this.status = "released";
  }
  update(maxExpansions: number): number {
    return Math.min(maxExpansions, 0);
  }
  sampleRing(): number {
    return 0;
  }
}

const perception: BotPerception = { tick: 0, actors: [], threatSlot: -1, lastDamageTick: -1, lastDamageFrom: ZERO, blind: false, deaf: false };
const memory: BotMemory = { entries: [], count: 0, danger: [], skippedLoot: new Map() };

const createStubBrain: BotBrainFactory = (options) => {
  const brain: BotBrain = {
    slot: options.slot,
    profile: options.profile,
    perception,
    memory,
    tick(view: BotWorldView, out: BotTickOutput) {
      out.input.tick = view.tick;
      out.input.forward = 1;
      out.input.buttons = Btn.sprint;
      out.intents.reviveSlot = -1;
    },
    kickAim() {},
    reset() {},
    debug: () => ({ goal: "idle", goalScore: 0, subState: "", targetSlot: -1, aimErrorDeg: Number.NaN, path: null, moveTarget: null, lootTargetId: -1 }),
  };
  return brain;
};

const zone: ZoneState = { phaseIndex: 0, stage: "idle", current: { cx: 0, cz: 0, r: 355 }, next: null, dps: 0, ticksToChange: 0, phase: null };

const actors: ActorConfig[] = Array.from({ length: 10 }, (_, slot) => ({
  slot,
  team: Math.floor(slot / 2),
  kind: slot === 0 ? "human" : "bot",
  name: slot === 0 ? "You" : `Bot ${slot}`,
  difficulty: slot === 0 ? null : DEFAULT_BOT_DIFFICULTY,
}));

const config: BrMatchConfig = {
  seed: 1,
  mapId: "v1",
  teamCount: 5,
  teamSize: 2,
  actors,
  rules: { friendlyFire: true, reviveSeconds: 5, bodyBlocking: true },
  zone: { initial: zone.current, phases: [{ waitSeconds: 120, shrinkSeconds: 70, radius: 400, dps: 1 }], firstAnnounceSeconds: 30, damageIntervalTicks: 6, edgeMargin: 40 },
  timings: { countdownSeconds: 5, landingSeconds: 0, glideSeconds: 0, timeCapSeconds: 750, endLingerSeconds: 8 },
  timeScale: 1,
};

const state: MatchState = {
  tick: 0,
  phase: "warmup",
  phaseStartTick: 0,
  phaseEndTick: 300,
  combatStartTick: -1,
  zone,
  zonePhases: [],
  teams: [],
  actors: [],
  teamsInPlay: 5,
  actorsInPlay: 10,
  winnerTeam: null,
  endReason: null,
};

const view: MatchView = { config, state, onEvent: () => () => {}, onFx: () => () => {} };

const human: MatchExternalActor = {
  slot: 0,
  vitals: createVitals(),
  armor: NO_ARMOR,
  readPose(out: ExternalActorPose) {
    out.feet = ZERO;
    out.stance = "stand";
  },
  applyDamage: () => null,
  setCanBeKnocked() {},
  setReviver() {},
  eliminate() {},
};

function killFeedLine(event: MatchEvent): string | null {
  switch (event.type) {
    case "kill":
      return `${event.killer} killed ${event.victim} (${event.cause})`;
    case "knock":
      return `${event.attacker} knocked ${event.victim}`;
    default:
      return null;
  }
}

describe("bot and match contracts", () => {
  it("stub brain writes a tick of input", () => {
    const profile = {} as BotProfile;
    const brain = createStubBrain({ slot: 3, team: 1, seed: 7, profile });
    const out: BotTickOutput = {
      input: { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null },
      intents: { cycleThrowable: false, holster: false, replaceSlot: -1, reviveSlot: -1 },
    };
    const worldView = { tick: 42, nav: new StubNav() } as unknown as BotWorldView;
    brain.tick(worldView, out);
    expect(out.input.tick).toBe(42);
    expect(out.input.buttons & Btn.sprint).toBe(Btn.sprint);
    expect(brain.debug().goal).toBe("idle");
  });

  it("schedule, config and events are consistent", () => {
    expect(60 / BOT_SCHEDULE.perceptionTicks).toBe(10);
    expect(view.config.actors.filter((a) => a.team === 0)).toHaveLength(2);
    expect(human.applyDamage({ amount: 10, kind: "bullet", zone: "body", sourceId: 1 }, { canBeKnocked: true }, ZERO)).toBeNull();
    expect(killFeedLine({ type: "kill", tick: 1, killer: 1, victim: 2, cause: "rifle", headshot: false, knockedBy: -1, teamKill: false })).toBe("1 killed 2 (rifle)");
    expect(new StubNav().update(100)).toBe(0);
  });
});
