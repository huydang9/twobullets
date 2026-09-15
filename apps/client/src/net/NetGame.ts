import type { EventState, Scene } from "@babylonjs/core";
import { LifeCode } from "@twobullets/protocol/codes";
import { MAX_MATCH_PLAYERS } from "@twobullets/shared/match/teams";
import type { AssetLibrary } from "../assets";
import type { CombatSystem } from "../combat/CombatSystem";
import type { ShotEvent } from "../combat/types";
import { HitboxOverlay } from "../debug/HitboxOverlay";
import type { EquipmentView } from "../equipment/types";
import type { WeaponPresentation } from "../fx/WeaponPresentation";
import type { InputManager } from "../input/InputManager";
import type { PlayerController, PlayerTick } from "../player/PlayerController";
import type { Hud } from "../ui/Hud";
import { t } from "../i18n";
import { NetDebugHud } from "../ui/NetDebugHud";
import type { Environment } from "../world/environment";
import { devPlayerId, fetchDevToken, parseNetParam, type NetEndpoint } from "./handshake";
import { LocalPlayerNet } from "./LocalPlayerNet";
import { NetClient } from "./NetClient";
import { NetClock, WS_BUFFER_TICKS } from "./NetClock";
import { NetCombat } from "./NetCombat";
import { createNetWeaponState, netInputButtons, netInputSelect, REVIVE_BUTTON } from "./netCombatRules";
import { NetCombatPresenter } from "./NetCombatPresenter";
import { NET_MOVEMENT, NetMovement } from "./netMovement";
import { NetPlayerBody } from "./NetPlayerBody";
import { CosmeticHitPredictor, RemoteHitboxes } from "./RemoteHitboxes";
import { RemotePlayers } from "./RemotePlayers";
import { RemoteRoster } from "./RemoteRoster";
import { openTransport } from "./transportPolicy";

export { NET_MOVEMENT };

export interface NetGameConfig {
  readonly endpoint: NetEndpoint;
  /** Dev account id (`?netId=`, else one per tab). */
  readonly sub: string;
  /** `?team=0..19` (default 0); the server puts you on the first team with room when it is full or out of range. */
  readonly team: number;
  readonly avatar: "soldier" | "capsule";
  /** DEV `?debug=hitboxes`: shared rig vs bone-driven hitboxes on remote players. */
  readonly debugHitboxes: boolean;
}

/** `?net=ws://localhost:7350/m/local[&team=1][&netId=alice][&netAvatar=capsule][&debug=hitboxes]`, or null offline. */
export function readNetConfig(params: URLSearchParams): NetGameConfig | null {
  const net = params.get("net");
  if (!net) return null;
  const team = Number(params.get("team") ?? 0);
  return {
    endpoint: parseNetParam(net),
    sub: devPlayerId(params.get("netId")),
    team: Number.isInteger(team) && team >= 0 && team < MAX_MATCH_PLAYERS ? team : 0,
    avatar: params.get("netAvatar") === "capsule" ? "capsule" : "soldier",
    debugHitboxes: (params.get("debug") ?? "").split(",").includes("hitboxes"),
  };
}

export interface NetAttachDeps {
  readonly scene: Scene;
  readonly player: PlayerController;
  readonly input: InputManager;
  readonly hudRoot: HTMLElement;
  readonly hud: Hud;
  /** Runs without equipment in networked play (its tick is then exactly the shared weapon half). */
  readonly combat: CombatSystem;
  readonly presentation: WeaponPresentation;
  /** The offline equipment view; the HUD reads it with the server's vitals and armor swapped in. */
  readonly equipment: EquipmentView;
  readonly soldiers: { readonly assets: AssetLibrary; readonly environment: Environment } | null;
}

/**
 * Networked play wiring for Game. M3: server-authoritative movement. M4: predicted weapons (reconciled against the owner
 * weapon group), remote shots, server hit confirms, damage, knocks, kills, revive and respawn. Create before the
 * PlayerController (its clock and `movement`), `attach` after combat/presentation/HUD exist, then `connect`. Per frame:
 * `update` before `player.update`, `lateUpdate` after.
 */
export class NetGame {
  readonly config: NetGameConfig;
  readonly clock: NetClock;
  readonly roster = new RemoteRoster();
  /** `PlayerController({ movement })`: predicted weapon state and life gates at tick time. */
  readonly movement = new NetMovement();
  readonly hitboxes = new RemoteHitboxes();
  private local: LocalPlayerNet | null = null;
  private avatars: RemotePlayers | null = null;
  private hud: NetDebugHud | null = null;
  private player: PlayerController | null = null;
  private combatEvents: NetCombat | null = null;
  private presenter: NetCombatPresenter | null = null;
  private predictor: CosmeticHitPredictor | null = null;
  private overlay: HitboxOverlay | null = null;
  private clientValue: NetClient | null = null;
  private connecting = false;

  constructor(config: NetGameConfig) {
    this.config = config;
    this.clock = new NetClock({ bufferTicks: WS_BUFFER_TICKS });
  }

  get client(): NetClient | null {
    return this.clientValue;
  }

  get localNet(): LocalPlayerNet | null {
    return this.local;
  }

  get combat(): NetCombat | null {
    return this.combatEvents;
  }

  attach(deps: NetAttachDeps): void {
    const { scene, player, input, combat, presentation } = deps;
    this.player = player;
    combat.attachEquipment(null);
    combat.weaponState = createNetWeaponState();
    this.movement.weaponSource = () => combat.weaponState;
    const local = (this.local = new LocalPlayerNet(new NetPlayerBody(player, combat)));

    // Tick input: combat bits cleared while downed or dead (the server steps them cleared), interact held for revives.
    const movement = this.movement;
    player.setCombatLink({
      get weaponState() {
        return combat.weaponState;
      },
      takeCombatInput(out) {
        combat.takeCombatInput(out);
        if (input.isLocked && input.isActionDown("interact")) out.buttons |= REVIVE_BUTTON;
        out.buttons = netInputButtons(out.buttons, movement.life);
        out.select = netInputSelect(out.select, movement.life);
      },
    });
    // Recoil, flash, tracer and sound only for shot ids never shown (R11): a correction that rewinds the shot counter
    // makes the next live ticks fire ids that were already presented.
    combat.onShot.add(
      (event: ShotEvent, state: EventState) => {
        if (local.shots.accept(event.shot)) return;
        state.skipNextObservers = true;
        player.kickAim(-event.shot.recoilUp, -event.shot.recoilRight);
      },
      undefined,
      true,
    );

    const layer = deps.hud.mountMatchLayer();
    let presenter: NetCombatPresenter | null = null;
    const remotes = (this.avatars = new RemotePlayers(scene, this.roster, {
      soldiers: this.config.avatar === "soldier" ? deps.soldiers : null,
      onAvatarCreated: (slot, soldier) => presenter?.registerAvatar(slot, soldier),
    }));
    presentation.audio.footsteps.sources.push(remotes);
    presenter = this.presenter = new NetCombatPresenter({
      scene,
      player,
      combat,
      presentation,
      remotes,
      roster: this.roster,
      input,
      layer,
      equipment: deps.equipment,
    });
    deps.hud.attachEquipment(presenter.equipmentView.view);
    this.combatEvents = new NetCombat(presenter);
    this.predictor = new CosmeticHitPredictor(this.hitboxes, presenter);
    player.onTick.add((tick: PlayerTick) => {
      if (movement.life === LifeCode.alive) this.predictor?.tick(combat.projectiles, tick.dt);
      this.clientValue?.onPredictedTick(tick.playerInput);
    });
    if (this.config.debugHitboxes) this.overlay = new HitboxOverlay(scene, this.hitboxes, remotes);
    this.hud = new NetDebugHud(deps.hudRoot, input);
    window.addEventListener("beforeunload", () => this.clientValue?.disconnect());
  }

  /** Fetches a fresh single-use dev token, opens the transport and starts the handshake. Safe to call again to rejoin. */
  async connect(): Promise<void> {
    const player = this.player;
    const local = this.local;
    if (!player || !local || this.connecting) return;
    this.connecting = true;
    this.clientValue?.disconnect();
    this.clientValue = null;
    this.clock.stop();
    this.roster.clear();
    this.combatEvents?.clear();
    this.hud?.showError(t("net.connecting"));
    try {
      const { endpoint, sub, team } = this.config;
      const token = await fetchDevToken(endpoint, sub, team);
      const transport = await openTransport(endpoint.wsUrl);
      const client = new NetClient(transport.session, {
        clock: performance,
        netClock: this.clock,
        local,
        inputs: player.inputHistory,
        roster: this.roster,
        joinToken: token.token,
        fallbackReason: transport.fallbackReason,
        events: this.combatEvents,
        movement: this.movement,
        onStateChange: (state, c) => console.info(`[net] ${state}${state === "disconnected" ? `: ${c.stats.disconnectReason}` : ""}`),
      });
      transport.onClose((code) => client.handleTransportClosed(code));
      this.clientValue = client;
      client.start();
      console.info(`[net] ${transport.kind} ${endpoint.wsUrl} as ${sub} (team ${team})`);
    } catch (error) {
      console.error("[net] connect failed", error);
      this.hud?.showError(t("net.cannotReach", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.connecting = false;
    }
  }

  disconnect(): void {
    this.clientValue?.disconnect();
  }

  /** DEV console: visible remote players as seen from this tab (slot, interpolated feet, life code 0/1/2). */
  remotes(): { slot: number; x: number; y: number; z: number; life: number }[] {
    const list: { slot: number; x: number; y: number; z: number; life: number }[] = [];
    this.roster.visible.forEach((visible, slot) => {
      if (visible !== 1) return;
      const p = this.roster.poses[slot]!;
      list.push({ slot, x: p.x, y: p.y, z: p.z, life: (p.flags >> 11) & 3 });
    });
    return list;
  }

  /** DEV console: turns the local aim at a remote player's body (`height` m above its feet). Returns the slot or −1. */
  aimAt(slot = this.remotes()[0]?.slot ?? -1, height = 1.25): number {
    const player = this.player;
    if (!player || slot < 0 || this.roster.visible[slot] !== 1) return -1;
    const p = this.roster.poses[slot]!;
    const feet = player.tickFeet;
    const eyeY = feet.y + 1.62;
    const dx = p.x - feet.x;
    const dz = p.z - feet.z;
    const aim = player.getAim();
    player.kickAim(aim.pitch + Math.atan2(p.y + height - eyeY, Math.sqrt(dx * dx + dz * dz)), Math.atan2(dx, dz) - aim.yaw);
    return slot;
  }

  update(dt: number): void {
    this.clientValue?.update(dt);
    // Rigs posed at this frame's render tick, before this frame's local ticks fly bullets through them.
    this.hitboxes.update(this.roster);
  }

  lateUpdate(dt: number): void {
    this.avatars?.update(dt);
    const client = this.clientValue;
    if (client) this.combatEvents?.update(client.renderTick);
    this.presenter?.update(dt);
    this.overlay?.update();
    if (client) this.hud?.update(client.stats, performance.now(), this.combatEvents?.stats ?? null, this.predictor?.predictedHits ?? 0);
  }

  dispose(): void {
    this.disconnect();
    this.avatars?.dispose();
    this.presenter?.dispose();
    this.overlay?.dispose();
    this.hud?.dispose();
  }
}
