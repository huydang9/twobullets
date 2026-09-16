import type { Scene } from "@babylonjs/core";
import type { MatchCommandResult } from "@twobullets/protocol/messages/control";
import { MatchEndReason } from "@twobullets/protocol/messages/match";
import { SIMULATION } from "@twobullets/shared/constants";
import type { WeaponPresentation } from "../fx/WeaponPresentation";
import type { NetGameConfig, NetMatchExit } from "../game/launch";
import { onLanguageChange, t } from "../i18n";
import type { InputManager } from "../input/InputManager";
import type { PlayerController } from "../player/PlayerController";
import type { Hud } from "../ui/Hud";
import { matchMapSource } from "../ui/map";
import { MatchHud, type MatchHudFrame } from "../ui/match/MatchHud";
import { PauseMenu, toPauseAction, type PauseMenuAction } from "../ui/match/PauseMenu";
import { commandRefusalKey, pauseOptions } from "../ui/match/pauseOptions";
import { DeathScreen, ResultScreen, type ScreenAction } from "../ui/match/MatchScreens";
import { deathCauseText, MATCH_STRINGS } from "../ui/match/strings";
import type { MapRuntime } from "../world/mapRuntime";
import { ZoneWall } from "../world/zone/ZoneWall";
import type { NetClient } from "./NetClient";
import type { NetCombat } from "./NetCombat";
import { netPlayerName, type NetCombatPresenter } from "./NetCombatPresenter";
import { NetMatchView, type NetOwnState } from "./NetMatchView";
import type { RemoteRoster } from "./RemoteRoster";
import { TeammateLabels } from "./TeammateLabels";

const RAD_TO_DEG = 180 / Math.PI;
/** Death → death screen, ms (the kill feed line and the fall have time to show). */
const DEATH_SCREEN_DELAY_MS = 1200;
/** The in-game result stays up this long before the front door's results take over, ms. */
const RESULT_HANDOFF_MS = 10_000;

export interface NetMatchDeps {
  readonly scene: Scene;
  readonly player: PlayerController;
  readonly hud: Hud;
  /** The match layer NetGame mounted (`hud.mountMatchLayer()`). */
  readonly layer: HTMLElement;
  readonly presentation: WeaponPresentation;
  readonly world: MapRuntime | null;
  readonly roster: RemoteRoster;
  readonly presenter: NetCombatPresenter;
  readonly config: NetGameConfig;
  readonly mapId: string;
  readonly input: InputManager;
  /** Quit actions on the wire (protocol v8); NetGame owns the connection. */
  readonly quit: {
    /** `MatchCommand{leave}`: take this player out, the match runs on. */
    leaveAlone(): void;
    /** `MatchCommand{endForAll}`: host only; the server answers and ends the match for everyone. */
    endForAll(): void;
  };
  /** The player left for the front door: NetGame disconnects, then calls `config.onExit`. */
  readonly exit: (exit: NetMatchExit) => void;
}

type MutableOwn = { -readonly [K in keyof NetOwnState]: NetOwnState[K] };

/**
 * Networked battle royale presentation (plan.md B1/B4/B7): the offline match HUD, zone wall, map source, death and result
 * screens over `NetMatchView`, teammate name labels, spectating with [ ] after death, and the hand-off to the front door
 * at the end. NetGame creates it in `attach` and calls `update` every frame after the presenter moved the camera.
 */
export class NetMatch {
  readonly view: NetMatchView;
  private readonly deps: NetMatchDeps;
  private readonly frame: MatchHudFrame;
  private readonly hudView: MatchHud;
  private readonly zoneWall: ZoneWall;
  private readonly labels: TeammateLabels;
  private readonly deathScreen: DeathScreen;
  private readonly resultScreen: ResultScreen;
  private readonly pauseMenu: PauseMenu;
  private readonly own: MutableOwn = { x: 0, y: 0, z: 0, yaw: 0, life: "alive", health: 100, downedHealth: 0, reviveSeconds: 0 };
  private readonly unsubscribeLanguage: () => void;
  private deathAt = -1;
  private dead = false;
  private resultAt = -1;
  private exited = false;
  /** Why the server refused the last quit command (shown once on the pause menu). */
  private commandNotice = "";
  private hostSlotShown = -2;

  constructor(deps: NetMatchDeps) {
    this.deps = deps;
    const view = (this.view = new NetMatchView({ mapId: deps.mapId, timeScale: deps.config.zoneTimeScale ?? 1 }));
    this.frame = { focusSlot: -1, localSlot: null, viewerX: 0, viewerZ: 0, headingDegrees: 0 };
    this.hudView = new MatchHud(deps.layer, view, this.frame);
    this.labels = new TeammateLabels(deps.layer, deps.scene, deps.roster);
    this.zoneWall = new ZoneWall(deps.scene);
    this.deathScreen = new DeathScreen(deps.layer);
    this.resultScreen = new ResultScreen(deps.layer);
    this.pauseMenu = new PauseMenu(deps.layer, {
      // The menu closes when the lock actually arrives (`onLockChange`), not here.
      onResume: () => {
        this.commandNotice = "";
        this.deps.input.requestLock();
      },
      subtitle: () => this.pauseSubtitle(),
      actions: () => this.pauseActions(),
    });
    // Esc is the browser's key for leaving pointer lock and never reaches the page, so the pause menu opens on the
    // unlock itself — unless the bag, the map or a death/result screen took the mouse.
    deps.input.onLockChange((locked) => {
      if (locked) this.closePause();
      else this.openPause();
    });
    if (deps.world) deps.hud.setMapSource(matchMapSource(view, this.frame));
    deps.presenter.setMatchHooks({
      nameOf: (slot) => view.nameOf(slot),
      killFeed: (event) => view.onKillFeed(event),
      // Warmup (and the M4 sandbox, which never leaves it) respawns; combat and the end don't.
      respawns: () => view.state.phase !== "combat" && view.state.phase !== "ended",
      ownDeath: () => this.onOwnDeath(),
      confirmedDamage: (victim, amount) => {
        if (view.teamOf(victim) !== view.ownTeam) view.addOwnDamage(amount);
      },
      reviveProgress: () => (view.reviveTargetSlot >= 0 ? view.reviveProgress : -1),
    });
    this.unsubscribeLanguage = onLanguageChange(() => this.labels.invalidate());
    window.addEventListener("keydown", this.handleKey);
  }

  /** Per frame, after the presenter (spectator camera) and remote avatars updated. */
  update(dt: number, client: NetClient | null, combat: NetCombat | null): void {
    const { player, presenter, roster } = this.deps;
    const view = this.view;
    if (client) view.sync(client);
    const now = performance.now();
    const tick = client && client.sync.sampleCount > 0 ? client.sync.serverTickAt(now) : -1;
    const own = this.own;
    const feet = player.tickFeet;
    own.x = feet.x;
    own.y = feet.y;
    own.z = feet.z;
    own.yaw = player.getAim().yaw;
    if (combat) {
      const vitals = combat.vitalsState;
      own.life = vitals.life;
      own.health = vitals.health;
      own.downedHealth = vitals.downedHealth;
      own.reviveSeconds = vitals.reviveSeconds;
    }
    view.update(tick, roster, view.ownSlot >= 0 ? own : null);

    const state = view.state;
    if (this.dead && own.life !== "dead") {
      // Respawned in warmup.
      this.dead = false;
      this.deathAt = -1;
      if (this.deathScreen.visible) this.closeScreens();
    }
    // The host bit can change mid-match (the host left), so the open menu follows it.
    if (this.pauseMenu.visible && this.view.hostSlot !== this.hostSlotShown) {
      this.hostSlotShown = this.view.hostSlot;
      this.pauseMenu.refresh();
    }
    if (view.ended && this.resultAt < 0) this.showResult(now);
    else if (this.deathAt >= 0 && now >= this.deathAt) {
      this.deathAt = -1;
      if (!view.ended) this.showDeath();
    }
    if (this.resultAt >= 0 && !this.exited && this.deps.config.onExit && now - this.resultAt >= RESULT_HANDOFF_MS) this.exit("ended");

    const camera = player.camera;
    const spectated = presenter.spectating;
    const frame = this.frame;
    frame.localSlot = view.ownSlot >= 0 ? view.ownSlot : null;
    frame.focusSlot = spectated >= 0 ? spectated : view.ownSlot;
    frame.viewerX = camera.position.x;
    frame.viewerZ = camera.position.z;
    frame.headingDegrees = camera.rotation.y * RAD_TO_DEG;
    this.hudView.setSpectating(spectated >= 0 && this.dead ? this.nameOf(spectated) : null);
    this.hudView.update();
    const announced = state.phase === "combat" && state.zonePhases.length > 0;
    this.zoneWall.update(dt, announced ? state.zone.current : null, camera.position.x, camera.position.z);
    this.labels.update(view.ownSlot, this.isTeammate, this.labelName);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.handleKey);
    this.unsubscribeLanguage();
    this.deps.presenter.setMatchHooks(null);
    this.deps.hud.setMapSource(null);
    this.hudView.dispose();
    this.labels.dispose();
    this.zoneWall.dispose();
    this.pauseMenu.dispose();
  }

  // ---- Pause menu -----------------------------------------------------------------------------------------------------

  /** True while this player may end the match for everyone (the roster's host bit, protocol v8). */
  get isHost(): boolean {
    return this.view.hostSlot >= 0 && this.view.hostSlot === this.view.ownSlot;
  }

  private openPause(): void {
    if (this.exited || this.view.ended || this.deathScreen.visible || this.resultScreen.visible) return;
    if (this.deps.hud.overlayOpen || this.pauseMenu.visible) return;
    this.deps.hud.setModal(true);
    this.pauseMenu.open();
  }

  private closePause(): void {
    if (!this.pauseMenu.visible) return;
    this.pauseMenu.close();
    this.commandNotice = "";
    this.deps.hud.setModal(this.dead || this.view.ended);
  }

  private pauseSubtitle(): string {
    if (this.commandNotice) return this.commandNotice;
    return this.isHost ? t("pause.hostBadge") : "";
  }

  private pauseActions(): PauseMenuAction[] {
    const options = pauseOptions({ kind: "net", isHost: this.isHost, warmup: this.view.state.phase === "warmup" });
    return options.map((option) =>
      toPauseAction(option, () => {
        if (option.id === "leaveAlone") this.leaveAlone();
        else if (option.id === "endForAll") this.deps.quit.endForAll();
      }),
    );
  }

  private leaveAlone(): void {
    this.deps.quit.leaveAlone();
    this.exit("left");
  }

  /** The server answered a quit command (protocol v8): a refusal reopens the pause menu with the reason. */
  onCommandResult(result: MatchCommandResult): void {
    const key = commandRefusalKey(result);
    if (key === null) return;
    this.commandNotice = t(key);
    this.deps.hud.setModal(true);
    this.pauseMenu.open();
  }

  private readonly isTeammate = (slot: number): boolean => this.view.teamOf(slot) === this.view.ownTeam;
  private readonly labelName = (slot: number): string => this.nameOf(slot);

  private nameOf(slot: number): string {
    return this.view.nameOf(slot) || netPlayerName(slot);
  }

  private onOwnDeath(): void {
    if (this.dead) return;
    this.dead = true;
    this.deathAt = performance.now() + DEATH_SCREEN_DELAY_MS;
  }

  private showDeath(): void {
    const view = this.view;
    const { presenter } = this.deps;
    const state = view.state;
    this.pauseMenu.close();
    const me = state.actors[view.ownSlot];
    const team = state.teams[view.ownTeam];
    const kill = view.lastOwnKill;
    const teammateAlive = team?.slots.some((slot) => slot !== view.ownSlot && state.actors[slot] !== undefined && state.actors[slot]!.life !== "dead") ?? false;
    this.releasePointer();
    this.deps.hud.setModal(true);
    const actions: ScreenAction[] = [
      {
        label: teammateAlive ? MATCH_STRINGS.screens.spectateTeammate : MATCH_STRINGS.screens.spectate,
        primary: true,
        run: () => {
          if (presenter.spectating < 0 || view.teamOf(presenter.spectating) !== view.ownTeam) presenter.cycleSpectate(1);
          this.deathScreen.hide();
        },
      },
    ];
    // Already eliminated, but the server still frees the slot and tells the others (roster, team counts).
    if (this.deps.config.onExit) actions.push({ label: t("screens.leaveMatch"), run: () => this.leaveAlone() });
    this.deathScreen.show(
      {
        cause: kill ? deathCauseText(kill, (slot) => (slot === view.ownSlot ? t("common.you") : this.nameOf(slot))) : MATCH_STRINGS.screens.died,
        placement: team && team.inPlay === 0 ? team.placement : null,
        teamCount: view.config.teamCount,
        kills: me?.kills ?? 0,
        damage: me?.damageDealt ?? 0,
        survivedSeconds: survivedSeconds(state.combatStartTick, me && me.deathTick >= 0 ? me.deathTick : state.tick),
      },
      actions,
    );
  }

  private showResult(now: number): void {
    const view = this.view;
    const end = view.matchEnd!;
    this.resultAt = now;
    this.deathAt = -1;
    this.pauseMenu.close();
    this.deathScreen.hide();
    this.releasePointer();
    this.deps.hud.setModal(true);
    const mine = end.players.find((p) => p.slot === view.ownSlot) ?? null;
    const teamId = mine?.teamId ?? view.ownTeam;
    let teamKills = 0;
    for (const p of end.players) if (p.teamId === teamId) teamKills += p.kills;
    const teamCount = view.config.teamCount;
    const reason = t(END_REASON_KEY[end.reason] ?? "result.reason.aborted");
    const handoff = this.deps.config.onExit ? ` · ${t("screens.resultsIn", { s: Math.round(RESULT_HANDOFF_MS / 1000) })}` : "";
    const actions: ScreenAction[] = this.deps.config.onExit
      ? [{ label: t("screens.seeResults"), primary: true, run: () => this.exit("ended") }]
      : [{ label: MATCH_STRINGS.screens.close, primary: true, run: () => this.closeScreens() }];
    this.resultScreen.show(
      {
        placement: mine && mine.placement > 0 ? mine.placement : (view.state.teams[teamId]?.placement ?? teamCount),
        teamCount,
        kills: mine?.kills ?? 0,
        teamKills,
        damage: mine?.damageDealt ?? 0,
        survivedSeconds: mine?.survivedSec ?? 0,
        reason: reason + handoff,
      },
      actions,
    );
  }

  private exit(reason: NetMatchExit["reason"]): void {
    if (this.exited) return;
    this.exited = true;
    this.deathScreen.hide();
    this.resultScreen.hide();
    this.deps.exit({ matchId: this.deps.config.matchId ?? "", reason });
  }

  private closeScreens(): void {
    this.deathScreen.hide();
    this.resultScreen.hide();
    this.deps.hud.setModal(this.dead);
  }

  private releasePointer(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private readonly handleKey = (event: KeyboardEvent): void => {
    const presenter = this.deps.presenter;
    // Esc closes the pause menu and puts the mouse back in the game (the browser ate the Esc that opened it).
    if (event.code === "Escape" && this.pauseMenu.visible) {
      event.preventDefault();
      if (this.pauseMenu.handleEscape()) return;
    }
    if (!this.dead && !this.view.ended) return;
    if (event.code === "BracketLeft") presenter.cycleSpectate(-1);
    else if (event.code === "BracketRight") presenter.cycleSpectate(1);
    else if (event.code === "Enter" && !this.deathScreen.visible && !this.resultScreen.visible && !this.exited) {
      if (this.view.ended) this.showResult(performance.now());
      else this.showDeath();
    }
  };
}

const END_REASON_KEY = {
  [MatchEndReason.lastTeam]: "result.reason.lastTeam",
  [MatchEndReason.allDead]: "result.reason.allDead",
  [MatchEndReason.timeCap]: "result.reason.timeCap",
  [MatchEndReason.cancelled]: "result.reason.cancelled",
  [MatchEndReason.aborted]: "result.reason.aborted",
  [MatchEndReason.hostEnded]: "result.reason.hostEnded",
} as const satisfies Record<number, Parameters<typeof t>[0]>;

function survivedSeconds(combatStartTick: number, endTick: number): number {
  return combatStartTick < 0 ? 0 : Math.max(0, (endTick - combatStartTick) / SIMULATION.tickRate);
}
