import type { Scene, TargetCamera } from "@babylonjs/core";
import {
  TICK_SECONDS,
  buildNavGrid,
  createActorConfigs,
  createInventory,
  createNavQuery,
  isValidZoneCenter,
  killCauseName,
  navStats,
  planTeamSpawns,
  resolveMatchSize,
  type BotBrain,
  type BotDifficulty,
  type MatchEvent,
  type MoveGates,
  type NavGrid,
  type NavQuery,
  type TeamMode,
  type TeamSpawnPlan,
  type ThrowableView,
  type ThrowableSnapshot,
} from "@twobullets/shared";
import { CharacterBody, DEATH_PILE_ID_BASE, WorldRaycaster, type MatchSim, type MatchSimEquipment } from "@twobullets/sim";
import type { AssetLibrary } from "../assets";
import type { CombatSystem } from "../combat/CombatSystem";
import type { EquipmentSystem } from "../equipment/EquipmentSystem";
import type { WeaponPresentation } from "../fx/WeaponPresentation";
import type { InputManager } from "../input/InputManager";
import type { PlayerController, PlayerTick } from "../player/PlayerController";
import type { PlayerLife } from "../player/PlayerLife";
import { SoldierResources } from "../targets/SoldierResources";
import type { Hud } from "../ui/Hud";
import { matchMapSource } from "../ui/map";
import { MatchHud, type MatchHudFrame } from "../ui/match/MatchHud";
import { DeathScreen, ResultScreen, type ScreenAction } from "../ui/match/MatchScreens";
import { MATCH_STRINGS } from "../ui/match/strings";
import type { Environment } from "../world/environment";
import type { MapRuntime } from "../world/mapRuntime";
import { ZoneWall } from "../world/zone/ZoneWall";
import { BotBodies } from "./BotBodies";
import { BotDebugOverlay } from "./BotDebugOverlay";
import { createOfflineMatchSim, OFFLINE_HUMAN_SLOT as HUMAN_SLOT } from "./createOfflineMatchSim";
import { HumanActor } from "./HumanActor";
import { MatchPresentation } from "./MatchPresentation";
import { BOT_DIFFICULTIES, MATCH_SIZE_PRESETS, readOfflineMatchOptions, reloadNewMatch, TEAM_MODES, writeMatchSize, type OfflineMatchOptions } from "./options";
import { Spectator } from "./Spectator";
import { MatchTrace } from "./trace";

/** What the offline match needs from Game.ts (all already built there). */
export interface OfflineMatchDeps {
  readonly scene: Scene;
  readonly input: InputManager;
  readonly player: PlayerController;
  readonly combat: CombatSystem;
  readonly equipment: EquipmentSystem;
  readonly life: PlayerLife;
  readonly presentation: WeaponPresentation;
  readonly hud: Hud;
  readonly world: MapRuntime;
  readonly assets: AssetLibrary;
  readonly environment: Environment;
}

const RAD_TO_DEG = 180 / Math.PI;
const FROZEN_GATES: MoveGates = { speedScale: 0, allowSprint: false, allowJump: false, crawl: false };
const NO_WEAPONS = { allowWeapons: false } as const;
const REASON_TEXT = { lastTeam: "Last team standing", allDead: "Everyone is down", timeCap: "Time limit reached" } as const;

/**
 * Offline battle royale on Map v1 (docs/bots/design.md §9): hosts the headless MatchSim in the client's fixed 60 Hz tick
 * with the human as an external actor, renders bots as pooled soldiers, bridges shots/impacts to FX and audio, draws the
 * zone wall and the match HUD, and runs death, spectate and result screens.
 *
 * Lifecycle: `create` (loading: nav grid, soldiers, spawn placement) → the first pointer lock ("Start match") builds the
 * MatchSim with the chosen difficulty and starts the countdown → Game calls `update(dt)` every frame right after
 * `player.update(dt)`. "New match" reloads the page with a fresh seed.
 */
export class OfflineMatch {
  sim: MatchSim | null = null;
  readonly seed: number;
  difficulty: BotDifficulty;
  readonly nav: NavQuery;
  bodies: BotBodies;
  /** Players and team mode; the play overlay can change them until the match starts. */
  maxPlayers: number;
  teamMode: TeamMode;
  private spawns: TeamSpawnPlan[] = [];
  private readonly resources: SoldierResources;
  private readonly humanSlot: number | null;
  private readonly zoneWall: ZoneWall;
  private readonly layer: HTMLDivElement;
  private readonly frame: MatchHudFrame;
  private readonly raycastWorld: WorldRaycaster;
  private readonly equipmentPort: MatchSimEquipment;
  private readonly throwableViews: ThrowableView[] = [];
  private readonly throwablePool: { -readonly [K in keyof ThrowableView]: ThrowableView[K] }[] = [];
  private throwableSource: readonly ThrowableSnapshot[] | null = null;
  private human: HumanActor | null = null;
  private hudView: MatchHud | null = null;
  private presentationBridge: MatchPresentation | null = null;
  private spectator: Spectator | null = null;
  private debugOverlay: BotDebugOverlay | null = null;
  private readonly deathScreen: DeathScreen;
  private readonly resultScreen: ResultScreen;
  private lastHumanKill: Extract<MatchEvent, { type: "kill" }> | null = null;
  private pendingDeath = false;
  private pendingResult = false;
  private humanDead = false;
  private accumulator = 0;
  private ticksThisFrame = 0;
  private ticking = false;
  private readonly trace: MatchTrace;

  private constructor(
    private readonly deps: OfflineMatchDeps,
    readonly options: OfflineMatchOptions,
    readonly grid: NavGrid,
  ) {
    const { scene, world, player, equipment, life, hud, input } = deps;
    this.trace = new MatchTrace(options.trace);
    this.trace.mark("constructor");
    this.nav = createNavQuery(grid);
    this.seed = options.seed ?? (Math.random() * 0x100000000) >>> 0;
    this.difficulty = options.difficulty;
    this.humanSlot = options.spectate ? null : HUMAN_SLOT;
    console.info(`[match] seed ${this.seed} (reload with &seed=${this.seed} to replay the same spawns and zone)`);

    this.maxPlayers = options.maxPlayers;
    this.teamMode = options.teamMode;
    if (this.humanSlot !== null) {
      // Everyone starts empty-handed and loots (bots too).
      equipment.resetLoadout(createInventory());
      life.respawnEnabled = false;
    }
    this.resources = new SoldierResources(deps.assets);
    this.bodies = this.buildRoster();
    this.zoneWall = new ZoneWall(scene);
    this.raycastWorld = new WorldRaycaster(scene);
    this.equipmentPort = {
      get smokes() {
        return equipment.smokes;
      },
      throwables: this.throwableViews,
      spawnRelease: (release, slot) => equipment.spawnExternalRelease(release, slot),
    };

    this.layer = hud.mountMatchLayer();
    this.deathScreen = new DeathScreen(this.layer);
    this.resultScreen = new ResultScreen(this.layer);
    this.frame = { focusSlot: this.humanSlot ?? 1, localSlot: this.humanSlot, viewerX: 0, viewerZ: 0, headingDegrees: 0 };
    this.showSetup();

    // Frozen through the countdown, after the end and once eliminated.
    player.setMoveGates(() => (this.humanFrozen() ? FROZEN_GATES : equipment.modifiers));
    deps.combat.gate = () => (this.humanFrozen() ? NO_WEAPONS : equipment.modifiers);

    input.onLockChange((locked) => {
      if (locked && !this.sim) this.start();
    });
    window.addEventListener("keydown", this.handleKey);
  }

  /** Loading step: builds the nav grid (≈0.5 s on Map v1), soldiers and the spawn plan. */
  static async create(deps: OfflineMatchDeps, options: OfflineMatchOptions = readOfflineMatchOptions(window.location.search)): Promise<OfflineMatch> {
    // Let the loading overlay paint first; hidden tabs pause rAF, so yield through a message task there.
    await new Promise<void>((resolve) => {
      if (document.visibilityState === "visible") return void requestAnimationFrame(() => resolve());
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
    const started = performance.now();
    const grid = buildNavGrid({ map: deps.world.map, terrain: deps.world.terrain, layout: deps.world.layout });
    const stats = navStats(grid);
    console.info(`[match] nav grid ${Math.round(performance.now() - started)} ms, ${stats.megabytes} MB, ${grid.info.components} components`);
    return new OfflineMatch(deps, options, grid);
  }

  /** Per render frame, right after `player.update(dt)` (before presentation and scene.render). */
  update(dt: number): void {
    const sim = this.sim;
    if (!sim) return;
    const trace = this.trace;
    const skip = this.options.skip;
    // Interpolation factor between the last two ticks, mirroring the player's accumulator clock.
    this.accumulator += dt - this.ticksThisFrame * TICK_SECONDS;
    this.ticksThisFrame = 0;
    // NaN/Infinity guard: a non-finite alpha would put soldiers (and their Havok hitboxes) at NaN.
    this.accumulator = !(this.accumulator > 0) ? 0 : this.accumulator >= TICK_SECONDS ? TICK_SECONDS - 1e-6 : this.accumulator;
    const alpha = this.accumulator / TICK_SECONDS;

    const traced = trace.enabled;
    if (traced) trace.mark("frame");
    if (!skip.has("bodies")) {
      if (traced) trace.time("frame bodies", () => this.bodies.update(dt, alpha));
      else this.bodies.update(dt, alpha);
    }
    this.spectator?.update(alpha);
    const camera = this.deps.player.camera as TargetCamera;
    if (!skip.has("wall")) this.zoneWall.update(dt, sim.state.zone.current, camera.position.x, camera.position.z);
    this.debugOverlay?.update();
    this.deps.presentation.weaponLowered = this.humanDead;

    if (this.pendingResult) {
      this.pendingResult = false;
      this.pendingDeath = false;
      this.showResult();
    } else if (this.pendingDeath) {
      this.pendingDeath = false;
      this.showDeath();
    }

    const frame = this.frame;
    const spectating = this.spectator?.active === true;
    frame.focusSlot = spectating ? this.spectator!.slot : (this.humanSlot ?? frame.focusSlot);
    frame.viewerX = camera.position.x;
    frame.viewerZ = camera.position.z;
    frame.headingDegrees = camera.rotation.y * RAD_TO_DEG;
    this.hudView?.setSpectating(spectating ? this.spectator!.name : null);
    if (traced && this.hudView) trace.time("frame hud", () => this.hudView!.update());
    else this.hudView?.update();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.handleKey);
    this.tickObserver?.remove();
    this.presentationBridge?.dispose();
    this.debugOverlay?.dispose();
    this.hudView?.dispose();
    this.zoneWall.dispose();
    this.sim?.dispose();
    this.bodies.dispose();
    this.deps.equipment.setTargetsSource(null);
    this.deps.equipment.setTeammatesSource(null);
    this.deps.hud.setMapSource(null);
    this.layer.remove();
  }

  // ---- Setup and start -----------------------------------------------------------------------------------------------

  private tickObserver: { remove(): void } | null = null;

  /** Spawn plan, the human's start position and pooled bot bodies for the current size and mode. */
  private buildRoster(): BotBodies {
    const { scene, world, player, combat, environment } = this.deps;
    const size = { seed: this.seed, maxPlayers: this.maxPlayers, teamMode: this.teamMode };
    const { teamCount, teamSize } = resolveMatchSize(size);
    const terrain = world.terrain;
    this.spawns = planTeamSpawns(this.seed, teamCount, teamSize, world.map.pois, world.map.spawns, (x, z) => terrain.sampleHeight(x, z));
    const home = this.spawns.find((plan) => plan.team === 0);
    const feet = home?.feet[0];
    if (home && feet) player.respawnAt({ position: [feet.x, feet.y, feet.z], yaw: home.yaw });
    const actors = createActorConfigs({ ...size, humanSlot: this.humanSlot, humanTeammate: this.options.teammate });
    return new BotBodies(scene, this.resources, environment, combat.hitboxRegistry, actors, this.humanSlot === null ? null : 0, () => (combat.armed ? combat.activeWeapon.id : null));
  }

  private showSetup(): void {
    const text = MATCH_STRINGS.setup;
    const sizes = MATCH_SIZE_PRESETS.includes(this.maxPlayers) ? MATCH_SIZE_PRESETS : [...MATCH_SIZE_PRESETS, this.maxPlayers].sort((a, b) => a - b);
    const { teamCount } = resolveMatchSize({ maxPlayers: this.maxPlayers, teamMode: this.teamMode });
    this.deps.hud.setMatchSetup({
      difficulties: BOT_DIFFICULTIES,
      difficulty: this.difficulty,
      difficultyLabel: text.difficulty,
      onDifficulty: (difficulty) => this.setDifficulty(difficulty as BotDifficulty),
      choices: [
        { label: text.players, options: sizes.map(String), value: String(this.maxPlayers), onChange: (value) => this.setMatchSize(Number(value), this.teamMode) },
        { label: text.teamMode, options: TEAM_MODES, labels: TEAM_MODES.map((mode) => text.modes[mode]), value: this.teamMode, onChange: (value) => this.setMatchSize(this.maxPlayers, value as TeamMode) },
      ],
      playLabel: text.start,
      details: text.details({ players: this.maxPlayers, teams: teamCount, mode: this.teamMode, teammate: this.options.teammate, zoneScale: this.options.zoneScale, seed: this.seed }),
    });
  }

  /** Play overlay: rebuilds spawns and bot bodies before the start and keeps the choice in the URL. */
  private setMatchSize(maxPlayers: number, teamMode: TeamMode): void {
    if (this.sim || (maxPlayers === this.maxPlayers && teamMode === this.teamMode)) return;
    this.maxPlayers = maxPlayers;
    this.teamMode = teamMode;
    this.bodies.dispose();
    this.bodies = this.buildRoster();
    const url = new URL(window.location.href);
    writeMatchSize(url, maxPlayers, teamMode);
    window.history.replaceState(null, "", url);
    this.showSetup();
  }

  private setDifficulty(difficulty: BotDifficulty): void {
    if (this.sim) return;
    this.difficulty = difficulty;
    const url = new URL(window.location.href);
    url.searchParams.set("difficulty", difficulty);
    window.history.replaceState(null, "", url);
  }

  private start(): void {
    const { scene, player, equipment, presentation, hud, world, combat } = this.deps;
    const options = this.options;
    const trace = this.trace;
    const skip = options.skip;
    trace.mark("start");
    if (this.humanSlot !== null) this.human = new HumanActor(player, combat, equipment, () => this.onHumanEliminated(), DEATH_PILE_ID_BASE + HUMAN_SLOT);
    const sim = trace.time("start MatchSim", () => createOfflineMatchSim({
      seed: this.seed,
      options: { ...options, maxPlayers: this.maxPlayers, teamMode: this.teamMode },
      difficulty: this.difficulty,
      humanSlot: this.humanSlot,
      spawns: this.spawns,
      killY: world.map.bounds.killY,
      raycastWorld: this.raycastWorld.cast,
      nav: this.nav,
      isValidZoneCenter: isValidZoneCenter(this.grid),
      groundLoot: equipment.groundLoot,
      equipment: this.equipmentPort,
      external: this.human ? [this.human] : [],
      createBody: (feet) => new CharacterBody(scene, feet),
      profile: import.meta.env.DEV,
    }));
    const config = sim.config;
    this.sim = sim;
    trace.time("start bodies", () => this.bodies.attach(sim));
    if (!skip.has("equipment")) {
      equipment.setTargetsSource(() => this.bodies.targets);
      equipment.setTeammatesSource(() => this.bodies.teammates);
    }
    if (!skip.has("fx")) this.presentationBridge = trace.time("start fx", () => new MatchPresentation(sim, this.bodies, presentation));
    if (!skip.has("hud")) this.hudView = trace.time("start hud", () => new MatchHud(this.layer, sim, this.frame));
    // Map (M) and minimap: zone, teammates and the viewer from the same frame the match HUD reads.
    hud.setMapSource(matchMapSource(sim, this.frame));
    this.spectator = new Spectator(player.camera, this.bodies, sim, this.raycastWorld.cast);
    if (options.spectate) this.spectator.cycle(1);
    if (options.botDebug) this.debugOverlay = new BotDebugOverlay(scene, sim, this.bodies, this.layer);
    sim.onEvent((event) => this.onMatchEvent(event));
    // After CombatSystem, EquipmentSystem and PlayerLife, which subscribed while Game was built.
    this.tickObserver = player.onTick.add((tick) => this.tick(tick));
    hud.setMatchSetup(null);
    trace.mark("start done");
    console.info(`[match] started: ${config.actors.length} actors in ${config.teamCount} teams (${this.teamMode}), ${this.difficulty}, zone ×${config.timeScale}`);
  }

  private tick(tick: PlayerTick): void {
    const sim = this.sim;
    if (!sim || sim.finished || this.options.skip.has("sim")) return;
    if (this.ticking) {
      console.error("[match] re-entrant match tick ignored (player.onTick fired from inside MatchSim.tick)");
      return;
    }
    this.ticking = true;
    try {
      this.syncThrowables();
      this.human?.captureTick(tick);
      if (this.trace.enabled) this.trace.time(`tick ${sim.state.tick + 1}`, () => sim.tick());
      else sim.tick();
      this.bodies.afterTick();
      this.ticksThisFrame++;
    } finally {
      this.ticking = false;
    }
  }

  private humanFrozen(): boolean {
    const phase = this.sim?.state.phase;
    return this.humanSlot === null || this.humanDead || phase !== "combat";
  }

  /** EquipmentSystem's throwable snapshots as the match's perception view (rebuilt when the snapshot array changes). */
  private syncThrowables(): void {
    const source = this.deps.equipment.throwables;
    if (source === this.throwableSource) return;
    this.throwableSource = source;
    const views = this.throwableViews;
    views.length = 0;
    for (let i = 0; i < source.length; i++) {
      const t = source[i]!;
      const view = (this.throwablePool[i] ??= { id: 0, ownerSlot: 0, kind: "frag", position: t.position, velocity: t.velocity, atRest: false });
      view.id = t.id;
      view.ownerSlot = t.owner;
      view.kind = t.kind;
      view.position = t.position;
      view.velocity = t.velocity;
      view.atRest = t.resting;
      views.push(view);
    }
  }

  // ---- Match events, death, result ------------------------------------------------------------------------------------

  private onMatchEvent(event: MatchEvent): void {
    switch (event.type) {
      case "kill":
        if (event.victim === this.humanSlot) this.lastHumanKill = event;
        break;
      case "matchEnded":
        this.pendingResult = true;
        break;
      default:
        break;
    }
  }

  private onHumanEliminated(): void {
    this.humanDead = true;
    this.pendingDeath = true;
  }

  private showDeath(): void {
    const sim = this.sim;
    if (!sim || this.humanSlot === null) return;
    const state = sim.state;
    const me = state.actors[this.humanSlot];
    const team = state.teams[0];
    const kill = this.lastHumanKill;
    this.releasePointer();
    this.deps.hud.setModal(true);
    const teammate = this.bodies.list.find((body) => body.team === 0 && body.actor !== null && body.actor.life !== "dead");
    const actions: ScreenAction[] = [
      {
        label: teammate ? MATCH_STRINGS.screens.spectateTeammate : MATCH_STRINGS.screens.spectate,
        primary: true,
        disabled: !teammate && !this.bodies.list.some((body) => body.actor?.life !== "dead"),
        run: () => this.spectate(teammate?.slot ?? null),
      },
      { label: MATCH_STRINGS.screens.newMatch, run: () => reloadNewMatch(this.difficulty, this) },
    ];
    this.deathScreen.show(
      {
        cause: kill ? this.deathCause(kill) : "You died",
        placement: team?.placement ?? null,
        teamCount: sim.config.teamCount,
        kills: me?.kills ?? 0,
        damage: me?.damageDealt ?? 0,
        survivedSeconds: survived(state.combatStartTick, me?.deathTick ?? state.tick),
      },
      actions,
    );
  }

  private showResult(): void {
    const sim = this.sim;
    if (!sim) return;
    const state = sim.state;
    const focusTeam = this.humanSlot !== null ? 0 : (state.actors[this.frame.focusSlot]?.team ?? 0);
    const team = state.teams[focusTeam];
    const me = this.humanSlot !== null ? state.actors[this.humanSlot] : null;
    this.deathScreen.hide();
    this.releasePointer();
    this.deps.hud.setModal(true);
    this.resultScreen.show(
      {
        placement: team?.placement ?? 1,
        teamCount: sim.config.teamCount,
        kills: me?.kills ?? 0,
        teamKills: team?.kills ?? 0,
        damage: me?.damageDealt ?? 0,
        survivedSeconds: survived(state.combatStartTick, me && me.deathTick >= 0 ? me.deathTick : state.tick),
        reason: state.endReason ? REASON_TEXT[state.endReason] : "",
      },
      [
        { label: MATCH_STRINGS.screens.newMatch, primary: true, run: () => reloadNewMatch(this.difficulty, this) },
        { label: "Close", run: () => this.closeScreens() },
      ],
    );
  }

  private deathCause(kill: Extract<MatchEvent, { type: "kill" }>): string {
    const name = this.hudView?.nameOf ?? ((slot: number) => String(slot));
    switch (kill.cause) {
      case "zone":
        return "You died to the zone";
      case "fall":
        return "You died from a fall";
      case "outOfBounds":
        return "You left the map";
      case "bleedOut":
        return kill.knockedBy >= 0 ? `You bled out after ${name(kill.knockedBy)} knocked you` : "You bled out";
      case "teamWipe":
        return kill.killer >= 0 ? `${name(kill.killer)} wiped out your team` : "Your team was wiped out";
      default:
        if (kill.killer < 0) return "You died";
        if (kill.killer === kill.victim) return `You killed yourself with ${killCauseName(kill.cause)}`;
        return `${name(kill.killer)} killed you with ${killCauseName(kill.cause)}${kill.headshot ? " (Headshot)" : ""}${kill.teamKill ? " (Team kill)" : ""}`;
    }
  }

  private spectate(slot: number | null): void {
    const spectator = this.spectator;
    if (!spectator) return;
    if (slot === null || !spectator.follow(slot)) spectator.cycle(1, 0);
    this.deathScreen.hide();
  }

  private closeScreens(): void {
    this.deathScreen.hide();
    this.resultScreen.hide();
    this.deps.hud.setModal(this.spectator?.active === true);
  }

  private releasePointer(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.code === "F7" && this.debugOverlay) {
      event.preventDefault();
      this.debugOverlay.toggle();
      return;
    }
    const spectator = this.spectator;
    if (!spectator?.active) return;
    if (event.code === "BracketLeft") spectator.cycle(-1);
    else if (event.code === "BracketRight") spectator.cycle(1);
    else if (event.code === "Enter" && this.humanDead && !this.deathScreen.visible && !this.resultScreen.visible) {
      if (this.sim?.state.phase === "ended") this.showResult();
      else this.showDeath();
    }
  };

  // ---- DEV ------------------------------------------------------------------------------------------------------------

  /** DEV console handle: Game puts it at `window.__twobullets.match` (see README-wiring.md). */
  createDevHandle(): Record<string, unknown> {
    const match = this;
    const need = (): MatchSim => {
      if (!match.sim) throw new Error("match not started: click START MATCH first");
      return match.sim;
    };
    const handle = {
      match,
      get sim() {
        return match.sim;
      },
      get state() {
        return match.sim?.state ?? null;
      },
      get bots(): (BotBrain | null)[] {
        return match.bodies.list.map((body) => match.sim?.brainOf(body.slot) ?? null);
      },
      nav: match.nav,
      debug: (slot: number) => need().brainOf(slot)?.debug() ?? null,
      events: (n = 20) => need().recentEvents.slice(-n),
      stats: () => need().stats,
      skipZone: () => need().skipZone(),
      /** Jumps (ticking the match) until zone phase `index` is announced. */
      setZonePhase: (index: number) => {
        const sim = need();
        for (let guard = 0; guard < 64 && sim.state.zonePhases.length < index && sim.state.phase === "combat"; guard++) {
          sim.skipZone();
          sim.tick();
          match.bodies.afterTick();
        }
        return sim.state.zone;
      },
      timeScale: (x: number) => {
        const url = new URL(window.location.href);
        url.searchParams.set("zoneScale", String(x));
        window.location.assign(url.toString());
      },
      follow: (slot: number | null) => {
        if (slot === null) match.spectator?.stop();
        else match.spectator?.follow(slot);
        return match.spectator?.slot ?? -1;
      },
      killActor: (slot: number) => need().killActor(slot),
      /** Kills every actor outside the human's team (or everyone but `keepTeam`). */
      killAll: (keepTeam = 0) => {
        const sim = need();
        for (const actor of sim.state.actors) if (actor && actor.team !== keepTeam) sim.killActor(actor.slot);
      },
      damageActor: (slot: number, amount: number) => {
        const sim = need();
        const actor = sim.state.actors[slot];
        if (!actor) return null;
        return sim.damageActor({ attacker: -1, victim: slot, amount, kind: "bullet", zone: "body", weaponId: null, position: actor.feet, direction: { x: 0, y: -1, z: 0 } });
      },
      placeBot: (slot: number, x: number, z: number) => need().placeActor(slot, { x, y: match.deps.world.terrain.sampleHeight(x, z) + 0.05, z }),
      navStats: () => navStats(match.grid),
      toggleDebug: () => match.debugOverlay?.toggle() ?? "reload with &botDebug=1",
    };
    return handle;
  }
}

function survived(combatStartTick: number, endTick: number): number {
  return combatStartTick < 0 ? 0 : Math.max(0, (endTick - combatStartTick) * TICK_SECONDS);
}
