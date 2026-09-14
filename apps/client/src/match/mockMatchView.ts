import {
  SIMULATION,
  VITALS,
  createBrMatchConfig,
  createZoneState,
  scheduleZonePhases,
  secondsToTicks,
  zoneAtInto,
  type ActorState,
  type BrMatchConfig,
  type MatchEvent,
  type MatchFxEvent,
  type MatchState,
  type MatchView,
  type TeamState,
  type ZonePhase,
} from "@twobullets/shared";
import type { Hud } from "../ui/Hud";
import { MatchHud, type MatchHudFrame } from "../ui/match/MatchHud";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * DEV stand-in for MatchSim's read side: a 10-actor match whose clock, zone schedule and scripted knocks/kills advance
 * with `advance(ticks)`. Lets the match HUD be built and previewed without bots, nav or physics.
 */
export class MockMatchView implements MatchView {
  readonly config: BrMatchConfig;
  readonly state: MatchState;
  private readonly mutable: Mutable<MatchState>;
  private readonly actors: Mutable<ActorState>[] = [];
  private readonly teams: Mutable<TeamState>[] = [];
  private readonly schedule: ZonePhase[];
  private readonly announced: ZonePhase[] = [];
  private readonly zone;
  private readonly eventListeners: ((event: MatchEvent) => void)[] = [];
  private step = 0;

  constructor(seed = 7, timeScale = 0.1) {
    this.config = createBrMatchConfig({ seed, humanSlot: 0, timeScale });
    const combatStart = secondsToTicks(this.config.timings.countdownSeconds, timeScale);
    this.schedule = scheduleZonePhases(this.config.zone, seed, combatStart, timeScale);
    this.zone = createZoneState(this.config.zone);
    for (const a of this.config.actors) {
      const angle = a.slot * 0.7;
      this.actors[a.slot] = {
        slot: a.slot, team: a.team, kind: a.kind, name: a.name, life: "alive", health: VITALS.maxHealth, downedHealth: 0, boost: 0,
        feet: { x: Math.sin(angle) * 120, y: 0, z: Math.cos(angle) * 120 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, stance: "stand",
        grounded: true, sprinting: false, adsBlend: 0, weaponId: "rifle", helmetLevel: 0, vestLevel: 0, usingItem: false, reviveProgress: 0,
        reviverSlot: -1, kills: 0, knocks: 0, damageDealt: 0, deathTick: -1,
      };
    }
    for (let team = 0; team < this.config.teamCount; team++) {
      this.teams.push({ team, slots: [team * 2, team * 2 + 1], standing: 2, inPlay: 2, eliminated: false, eliminatedTick: -1, placement: null, kills: 0 });
    }
    this.mutable = {
      tick: 0, phase: "warmup", phaseStartTick: 0, phaseEndTick: combatStart, combatStartTick: -1, zone: this.zone, zonePhases: this.announced,
      teams: this.teams, actors: this.actors, teamsInPlay: this.teams.length, actorsInPlay: this.actors.length, winnerTeam: null, endReason: null,
    };
    this.state = this.mutable;
  }

  onEvent(listener: (event: MatchEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => this.eventListeners.splice(this.eventListeners.indexOf(listener), 1);
  }

  onFx(_listener: (event: MatchFxEvent) => void): () => void {
    return () => undefined;
  }

  advance(ticks: number): void {
    const s = this.mutable;
    for (let i = 0; i < ticks; i++) {
      const tick = ++s.tick;
      if (s.phase === "warmup" && tick >= s.phaseEndTick) {
        s.phase = "combat";
        s.combatStartTick = tick;
        s.phaseEndTick = -1;
      }
      for (const phase of this.schedule) {
        if (!this.announced.includes(phase) && tick >= phase.waitStartTick) {
          this.announced.push(phase);
          this.emit({ type: "zoneAnnounced", tick, phase });
        }
      }
      zoneAtInto(this.config.zone, this.announced, tick, this.zone);
      // Scripted feed: every 2 s a knock or a kill somewhere; the teammate gets knocked once.
      if (s.phase === "combat" && tick % (2 * SIMULATION.tickRate) === 0) this.scriptEvent(tick);
      const mate = this.actors[1]!;
      if (mate.life === "downed") mate.downedHealth = Math.max(0, mate.downedHealth - 4 / SIMULATION.tickRate);
    }
  }

  private scriptEvent(tick: number): void {
    const step = this.step++;
    const victim = this.actors[2 + (step % 8)]!;
    const killer = (victim.slot + 3) % 10;
    if (step === 3) {
      const mate = this.actors[1]!;
      mate.life = "downed";
      mate.health = 0;
      mate.downedHealth = VITALS.downedHealth;
      this.emit({ type: "knock", tick, attacker: 4, victim: 1, cause: "rifle", headshot: false });
      return;
    }
    if (victim.life === "dead") return;
    victim.life = "dead";
    victim.deathTick = tick;
    this.actors[killer]!.kills++;
    this.mutable.actorsInPlay--;
    this.emit({ type: "kill", tick, killer, victim: victim.slot, cause: step % 3 === 0 ? "zone" : "rifle", headshot: step % 4 === 1, knockedBy: -1, teamKill: false });
  }

  private emit(event: MatchEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

/**
 * DEV console: mounts the match HUD on the mock and runs it (any page, no `?bots=1`):
 * `import("/src/match/mockMatchView.ts").then((m) => m.previewMatchHud(__twobullets.hud))`. Returns a stop function.
 */
export function previewMatchHud(hud: Hud, timeScale = 0.1): () => void {
  const view = new MockMatchView(7, timeScale);
  const frame: MatchHudFrame = { focusSlot: 0, localSlot: 0, viewerX: 0, viewerZ: 0, headingDegrees: 0 };
  const matchHud = new MatchHud(hud.mountMatchLayer(), view, frame);
  hud.debugForceVisible(true);
  let last = performance.now();
  let raf = 0;
  const loop = (now: number): void => {
    const ticks = Math.floor(((now - last) / 1000) * SIMULATION.tickRate);
    if (ticks > 0) {
      last += (ticks / SIMULATION.tickRate) * 1000;
      view.advance(ticks);
    }
    frame.headingDegrees = (now / 60) % 360;
    matchHud.update();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    matchHud.dispose();
  };
}
