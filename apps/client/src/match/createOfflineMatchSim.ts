import {
  Btn,
  botProfile,
  createBotBrain,
  createBrMatchConfig,
  createStartingInventory,
  type BotBrainFactory,
  type BotDifficulty,
  type BrMatchConfig,
  type GroundLoot,
  type MatchExternalActor,
  type NavQuery,
  type RaycastFn,
  type TeamSpawnPlan,
  type Vec3,
} from "@twobullets/shared";
import { MatchSim, type MatchSimEquipment, type PlayerBody } from "@twobullets/sim";
import type { OfflineMatchOptions } from "./options";

export const OFFLINE_HUMAN_SLOT = 0;

/** Everything `OfflineMatch.start` feeds MatchSim, without a render scene (headless test: test/match). */
export interface OfflineMatchSimInput {
  readonly seed: number;
  readonly options: Pick<OfflineMatchOptions, "maxPlayers" | "teamMode" | "teammate" | "zoneScale" | "botsPassive">;
  readonly difficulty: BotDifficulty;
  /** Null: bots-only (`?spectate=1`). */
  readonly humanSlot: number | null;
  readonly spawns: readonly TeamSpawnPlan[];
  readonly killY: number;
  readonly raycastWorld: RaycastFn;
  readonly nav: NavQuery;
  readonly isValidZoneCenter: (x: number, z: number) => boolean;
  readonly groundLoot: GroundLoot;
  readonly equipment: MatchSimEquipment;
  readonly external: readonly MatchExternalActor[];
  createBody(feet: Vec3): PlayerBody;
  readonly profile?: boolean;
}

export function createOfflineMatchConfig(input: Pick<OfflineMatchSimInput, "seed" | "options" | "difficulty" | "humanSlot">): BrMatchConfig {
  return createBrMatchConfig({
    seed: input.seed,
    maxPlayers: input.options.maxPlayers,
    teamMode: input.options.teamMode,
    humanSlot: input.humanSlot,
    humanTeammate: input.options.teammate,
    difficulty: input.difficulty,
    timeScale: input.options.zoneScale,
  });
}

/** The offline match's MatchSim (design.md §9.1): real brains and nav, the host's equipment world and the human. */
export function createOfflineMatchSim(input: OfflineMatchSimInput): MatchSim {
  const brainFactory: BotBrainFactory = input.options.botsPassive ? passiveBrains(createBotBrain) : createBotBrain;
  return new MatchSim({
    config: createOfflineMatchConfig(input),
    spawns: input.spawns,
    killY: input.killY,
    profile: input.profile ?? false,
    // Bots start with the human's kit (OfflineMatch resets the human's loadout to the same inventory).
    inventoryFor: () => createStartingInventory(),
    ports: {
      raycastWorld: input.raycastWorld,
      nav: input.nav,
      groundLoot: input.groundLoot,
      brainFactory,
      profileFor: botProfile,
      createBody: (feet) => input.createBody(feet),
      equipment: input.equipment,
      external: input.external,
      isValidZoneCenter: input.isValidZoneCenter,
    },
  });
}

/** DEV `?botsPassive=1`: the real brains with the trigger masked out. */
function passiveBrains(factory: BotBrainFactory): BotBrainFactory {
  return (options) => {
    const brain = factory(options);
    const tick = brain.tick.bind(brain);
    brain.tick = (view, out) => {
      tick(view, out);
      out.input.buttons &= ~Btn.fire;
    };
    return brain;
  };
}
