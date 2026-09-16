import { Vector3, type EventState, type Scene } from "@babylonjs/core";
import { LifeCode } from "@twobullets/protocol/codes";
import { WorldRaycaster } from "@twobullets/sim";
import type { AssetLibrary } from "../assets";
import type { CombatSystem } from "../combat/CombatSystem";
import type { ShotEvent } from "../combat/types";
import { HitboxOverlay } from "../debug/HitboxOverlay";
import type { EquipmentView } from "../equipment/types";
import type { WeaponPresentation } from "../fx/WeaponPresentation";
import type { NetGameConfig, NetMatchExit } from "../game/launch";
import type { InputManager } from "../input/InputManager";
import type { PlayerController, PlayerTick } from "../player/PlayerController";
import type { Mutable } from "@twobullets/protocol/messages/snapshot";
import type { PlayerInput } from "@twobullets/shared/input";
import { encodeThrowArg, type ThrowStyle } from "@twobullets/protocol/messages/throwables";
import type { ThrowableKind } from "@twobullets/shared/equipment/items";
import type { Hud } from "../ui/Hud";
import { t } from "../i18n";
import { NetDebugHud } from "../ui/NetDebugHud";
import type { Environment } from "../world/environment";
import type { MapRuntime } from "../world/mapRuntime";
import { fetchDevToken } from "./handshake";
import { LocalPlayerNet } from "./LocalPlayerNet";
import { NetClient } from "./NetClient";
import { NetClock, WS_BUFFER_TICKS } from "./NetClock";
import { NetCombat } from "./NetCombat";
import { createNetWeaponState, netCombatLink, netHandsBusy } from "./netCombatRules";
import { NetCombatPresenter } from "./NetCombatPresenter";
import { NetMatch } from "./NetMatch";
import { NetThrowables, type NetThrowableTarget } from "./NetThrowables";
import { NET_MOVEMENT, NetMovement } from "./netMovement";
import { NetPlayerBody } from "./NetPlayerBody";
import { CosmeticHitPredictor, RemoteHitboxes } from "./RemoteHitboxes";
import { RemotePlayers } from "./RemotePlayers";
import { RemoteRoster } from "./RemoteRoster";
import { openTransport } from "./transportPolicy";

export { NET_MOVEMENT };
export { readNetConfig, type NetGameConfig } from "../game/launch";

export interface NetAttachDeps {
  readonly scene: Scene;
  readonly player: PlayerController;
  readonly input: InputManager;
  readonly hudRoot: HTMLElement;
  readonly hud: Hud;
  /** Runs without equipment in networked play (its tick is then exactly the shared weapon half). */
  readonly combat: CombatSystem;
  readonly presentation: WeaponPresentation;
  /**
   * The local equipment: the HUD reads it with the server's vitals and armor swapped in, and in `serverThrowables`
   * mode it is also where the server's grenades, clouds, fire areas and flashes are rendered (protocol v9).
   */
  readonly equipment: EquipmentView & NetThrowableTarget;
  readonly soldiers: { readonly assets: AssetLibrary; readonly environment: Environment } | null;
  /** The loaded map (minimap and map screen from match state), or null on the arena. */
  readonly world: MapRuntime | null;
  /** The match's map id (zone radii: `arena` vs full maps). */
  readonly mapId: string;
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
  private matchValue: NetMatch | null = null;
  private throwablesValue: NetThrowables | null = null;
  private throwTarget: NetThrowableTarget | null = null;
  private throwLife: number = LifeCode.alive;
  private clientValue: NetClient | null = null;
  private itemsTick = -1;
  private connecting = false;
  /** F pressed during a frame, consumed by the next predicted tick's loot interaction. */
  private interactPressed = false;
  private input: InputManager | null = null;

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

  /**
   * `equipment` for UI created before `attach` (the inventory screen): reads and calls go to the net equipment view
   * (server consumable counts, `useItem` as a server use) once it exists, to `equipment` until then.
   */
  equipmentFor<T extends object>(equipment: T): T {
    const current = (): object => this.presenter?.equipmentView.view ?? equipment;
    return new Proxy(equipment, {
      get: (_target, property) => {
        const value: unknown = Reflect.get(current(), property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(equipment) : value;
      },
      set: (_target, property, value) => Reflect.set(equipment, property, value),
    });
  }

  /** Battle royale presentation (phase, zone, roster names, death and results). */
  get match(): NetMatch | null {
    return this.matchValue;
  }

  /** The server's throwables as this client hears them (protocol v9), or null before `attach`. */
  get throwables(): NetThrowables | null {
    return this.throwablesValue;
  }

  /**
   * A throwable left the local hands: send the intent (kind, style, the fuse left) and let the server spawn it. Wired
   * from `EquipmentSystem`'s `onThrowRelease`, so nothing is simulated locally.
   */
  onThrowRelease(release: { readonly kind: ThrowableKind; readonly style: ThrowStyle; readonly fuse: number }): void {
    this.presenter?.equipmentView.queueThrow(encodeThrowArg(release.kind, release.style, release.fuse));
  }

  attach(deps: NetAttachDeps): void {
    const { scene, player, input, combat, presentation } = deps;
    this.player = player;
    this.throwTarget = deps.equipment;
    this.throwablesValue = new NetThrowables(deps.equipment);
    combat.attachEquipment(null);
    combat.weaponState = createNetWeaponState();
    this.movement.weaponSource = () => combat.weaponState;
    const local = (this.local = new LocalPlayerNet(new NetPlayerBody(player, combat)));

    // Tick input: combat bits cleared while downed or dead (the server steps them cleared), and while the hands are busy
    // (local throwable out, or a heal/boost in use on the server), so the click that throws never also fires; interact
    // held for revives. Fire/reload pressed or a throwable taken out during an item use cancel it on the server.
    const movement = this.movement;
    const equipment = deps.equipment;
    let presenter: NetCombatPresenter | null = null;
    player.setCombatLink(
      netCombatLink(combat, {
        handsBusy: () => {
          const items = presenter?.equipmentView;
          const throwPhase = equipment.throwState.phase;
          if (throwPhase !== "idle" && items?.usingItem) items.interrupt();
          return netHandsBusy(throwPhase, items?.usingItem ?? false);
        },
        handsInterrupted: () => presenter?.equipmentView.interrupt(),
        interactHeld: () => input.isLocked && input.isActionDown("interact"),
        life: () => movement.life,
        cancelAim: () => combat.cancelAim(),
      }),
    );
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
    // Hands (use animation, gun put away) and use sounds follow the server's item use rather than the local equipment's
    // attempt; throwables still pass through to the local equipment (throw sounds, frag-out callout).
    presentation.attachEquipment(presenter.equipmentView.view);
    presentation.audio.attachEquipment(presenter.equipmentView.view);
    this.combatEvents = new NetCombat(presenter);
    this.matchValue = new NetMatch({
      scene,
      player,
      hud: deps.hud,
      layer,
      presentation,
      world: deps.world,
      roster: this.roster,
      presenter,
      config: this.config,
      mapId: deps.mapId,
      input,
      quit: {
        leaveAlone: () => this.clientValue?.requestLeaveMatch(),
        endForAll: () => this.clientValue?.requestEndForAll(),
      },
      exit: (exit) => this.exitMatch(exit),
    });
    this.predictor = new CosmeticHitPredictor(this.hitboxes, presenter);
    const items = presenter.equipmentView;
    this.input = input;
    const lootRays = new WorldRaycaster(scene);
    lootRays.ignoreBody = player.physicsBody;
    const eye = new Vector3();
    const viewDir = { x: 0, y: 0, z: 1 };
    const feet = { x: 0, y: 0, z: 0 };
    const lootTick = { eye: { x: 0, y: 0, z: 0 }, viewDir, feet, alive: true, interactPressed: false, reviveCandidate: false, raycast: lootRays.cast };
    player.onTick.add((tick: PlayerTick) => {
      if (movement.life === LifeCode.alive) this.predictor?.tick(combat.projectiles, tick.dt);
      // Loot (B5): nearby server items, the F prompt, F and auto pickup, from the predicted eye.
      player.getEyeToRef(eye);
      const aim = player.getAim();
      const cosPitch = Math.cos(aim.pitch);
      viewDir.x = Math.sin(aim.yaw) * cosPitch;
      viewDir.y = -Math.sin(aim.pitch);
      viewDir.z = Math.cos(aim.yaw) * cosPitch;
      const tickFeet = player.tickFeet;
      feet.x = tickFeet.x;
      feet.y = tickFeet.y;
      feet.z = tickFeet.z;
      lootTick.eye.x = eye.x;
      lootTick.eye.y = eye.y;
      lootTick.eye.z = eye.z;
      lootTick.alive = movement.life === LifeCode.alive;
      lootTick.interactPressed = this.interactPressed;
      lootTick.reviveCandidate = presenter !== null && presenter.downedInReach(true) >= 0;
      this.interactPressed = false;
      lootRays.ignoreBody = player.physicsBody;
      items.tickLoot(lootTick);
      // Item use/cancel rides this tick's input (the ring's entry, so redundant resends carry it).
      const action = items.takeAction();
      if (action !== null) (tick.playerInput as Mutable<PlayerInput>).action = action;
      this.clientValue?.onPredictedTick(tick.playerInput);
    });
    if (this.config.debugHitboxes) this.overlay = new HitboxOverlay(scene, this.hitboxes, remotes);
    // Hidden by default (F6 toggles); DEV `?netDebug=1` opens it at start.
    this.hud = new NetDebugHud(deps.hudRoot, input, { visible: import.meta.env.DEV && new URLSearchParams(window.location.search).get("netDebug") === "1" });
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
    this.itemsTick = -1;
    this.presenter?.equipmentView.loot.clear();
    this.throwablesValue?.clear();
    this.clock.stop();
    this.roster.clear();
    this.combatEvents?.clear();
    this.hud?.showError(t("net.connecting"));
    try {
      const { endpoint, sub, team, tokens } = this.config;
      const token = tokens ? await tokens() : await fetchDevToken(endpoint, sub, team);
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
        loot: this.presenter?.equipmentView.loot ?? null,
        throwables: this.throwablesValue,
        onCommandResult: (result) => this.matchValue?.onCommandResult(result),
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

  /** The player is done with this match (result screen or "leave"): drop the connection and hand over to the front door. */
  private exitMatch(exit: NetMatchExit): void {
    this.disconnect();
    this.config.onExit?.(exit);
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
    const input = this.input;
    if (input !== null && input.isLocked && input.wasActionPressed("interact")) this.interactPressed = true;
    this.clientValue?.update(dt);
    // Rigs posed at this frame's render tick, before this frame's local ticks fly bullets through them.
    this.hitboxes.update(this.roster);
  }

  lateUpdate(dt: number): void {
    this.avatars?.update(dt);
    const client = this.clientValue;
    // The hands follow the server's life: knocked or dead puts a throwable away and refuses a new one.
    const life = this.movement.life;
    if (life !== this.throwLife) {
      this.throwLife = life;
      this.throwTarget?.setNetLife(life === LifeCode.downed ? "downed" : life === LifeCode.dead ? "dead" : "alive");
    }
    if (client) this.combatEvents?.update(client.renderTick);
    if (client && client.ownerItems !== null && client.ownerItemsTick !== this.itemsTick) {
      this.itemsTick = client.ownerItemsTick;
      this.presenter?.equipmentView.setItems(client.ownerItems);
      // The server owns the bag: the local hands may only throw what it says is carried.
      this.throwTarget?.setThrowableCounts(client.ownerItems.throwables ?? []);
    }
    this.presenter?.update(dt);
    this.matchValue?.update(dt, client, this.combatEvents);
    this.overlay?.update();
    if (client) this.hud?.update(client.stats, performance.now(), this.combatEvents?.stats ?? null, this.predictor?.predictedHits ?? 0);
  }

  dispose(): void {
    this.disconnect();
    this.avatars?.dispose();
    this.matchValue?.dispose();
    this.presenter?.dispose();
    this.overlay?.dispose();
    this.hud?.dispose();
  }
}
