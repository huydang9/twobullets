import { Vector3, type Scene } from "@babylonjs/core";
import { remoteLifeCode } from "@twobullets/netcode/replication";
import { LifeCode } from "@twobullets/protocol/codes";
import { MAX_ENTITY_SLOTS } from "@twobullets/protocol/messages/snapshot";
import { RemoteFlags, StanceCode } from "@twobullets/protocol/quantize";
import type { LifeState } from "@twobullets/shared/equipment/vitals";
import type { MatchEvent } from "@twobullets/shared/match/types";
import type { FiredShot, HitZone, WeaponId } from "@twobullets/shared/weapons/types";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import { WorldRaycaster } from "@twobullets/sim";
import type { CombatSystem } from "../combat/CombatSystem";
import type { EquipmentView } from "../equipment/types";
import type { WeaponPresentation } from "../fx/WeaponPresentation";
import { t } from "../i18n";
import type { InputManager } from "../input/InputManager";
import type { PlayerController } from "../player/PlayerController";
import { killCauseLabel } from "../ui/equipment/labels";
import { MatchFeed } from "../ui/match/MatchFeed";
import type { CombatFeedback, NetDamageTaken, NetHitConfirm, NetKill, NetOwnerVitals } from "./NetCombat";
import { NET_RESPAWN_SECONDS, REVIVE_RANGE_M, REVIVE_SECONDS, REVIVE_VERTICAL_RANGE_M } from "./netCombatRules";
import { NetEquipmentView } from "./NetEquipmentView";
import { DamageDirectionIndicator, NetLifeBanner } from "./netHudWidgets";
import type { PredictedHitSink } from "./RemoteHitboxes";
import { RemotePlayers, SLOT_NAMES } from "./RemotePlayers";
import type { RemoteRoster } from "./RemoteRoster";

/** Display name of a slot ("Người chơi Bravo"), matching the HUD's formatting of `RemotePlayers.bodyId`. */
export function netPlayerName(slot: number): string {
  return t("net.playerName", { name: SLOT_NAMES[slot] ?? slot });
}

/** Remote shots whose world impacts are queued (dust, holes, ricochet sounds) at bullet flight time. */
const PENDING_IMPACTS = 64;
const IMPACT_RAY_M = 400;
/** Over-the-shoulder spectator offsets from the followed eye, m. */
const SPECTATE_BACK = 2.8;
const SPECTATE_RIGHT = 0.55;
const SPECTATE_UP = 0.3;
const SPECTATE_WALL_MARGIN = 0.25;

interface PendingImpact {
  active: boolean;
  at: number;
  weaponId: WeaponId;
  readonly point: Vector3;
  readonly normal: Vector3;
  readonly direction: Vector3;
}

/** Battle royale hooks (NetMatch): names from the roster, the match kill feed, death without respawn. */
export interface NetMatchHooks {
  /** Display name of a slot (roster nickname or "Bot 3"). */
  nameOf(slot: number): string;
  /** Kill feed lines go to the match HUD instead of the presenter's own feed. */
  killFeed(event: MatchEvent): void;
  /** False in combat: death shows no respawn countdown (the match shows its death screen). */
  respawns(): boolean;
  /** The local player died (not knocked). */
  ownDeath(kill: NetKill | null): void;
  /** Our confirmed damage on someone else. */
  confirmedDamage(victim: number, amount: number): void;
  /** Server revive progress (0..1) of the teammate we are reviving (teammate vitals, protocol v6), or −1 when none. */
  reviveProgress?(): number;
}

export interface NetCombatPresenterDeps {
  readonly scene: Scene;
  readonly player: PlayerController;
  readonly combat: CombatSystem;
  readonly presentation: WeaponPresentation;
  readonly remotes: RemotePlayers;
  readonly roster: RemoteRoster;
  readonly input: InputManager;
  /** Match layer (`hud.mountMatchLayer()`): kill feed and banners. */
  readonly layer: HTMLElement;
  /** The offline equipment view the HUD would otherwise read. */
  readonly equipment: EquipmentView;
}

/**
 * The browser side of networked combat: remote shots through WeaponPresentation (tracer, third-person flash, spatial
 * gunshot, near-miss cracks) plus world impacts, blood on remote bodies from `PlayerHit`, confirmed hits through the
 * existing `CombatSystem.onDamage` path (hitmarker, damage number, confirm and armor sounds, kill notice), the match kill
 * feed, the damage direction indicator, server vitals into the equipment HUD, the death banner and a spectator camera
 * while dead, and the cosmetic predicted-hit thud.
 */
export class NetCombatPresenter implements CombatFeedback, PredictedHitSink {
  readonly equipmentView: NetEquipmentView;
  ownSlot = -1;
  ownTeam = -1;
  private readonly deps: NetCombatPresenterDeps;
  private readonly feed: MatchFeed;
  private readonly indicator: DamageDirectionIndicator;
  private readonly banner: NetLifeBanner;
  private readonly raycaster: WorldRaycaster;
  private readonly impacts: PendingImpact[] = [];
  private readonly muzzle = { x: 0, y: 0, z: 0 };
  private readonly forward = { x: 0, y: 0, z: 1 };
  private readonly hitPoint = { x: 0, y: 0, z: 0 };
  private readonly hitNormal = { x: 0, y: 0, z: 0 };
  private readonly hitDirection = { x: 0, y: 0, z: 1 };
  private readonly rayEnd = { x: 0, y: 0, z: 0 };
  private readonly eye = new Vector3();
  private readonly target = new Vector3();
  private readonly spectateFrom = { x: 0, y: 0, z: 0 };
  private readonly spectateTo = { x: 0, y: 0, z: 0 };
  private readonly teams = new Int8Array(MAX_ENTITY_SLOTS).fill(-1);
  private life: LifeState = "alive";
  private spectateSlot = -1;
  private matchHooks: NetMatchHooks | null = null;
  private time = 0;
  private reviveHeld = 0;

  constructor(deps: NetCombatPresenterDeps) {
    this.deps = deps;
    this.equipmentView = new NetEquipmentView(deps.equipment, undefined, () => deps.combat.weaponState);
    this.feed = new MatchFeed(deps.layer);
    this.indicator = new DamageDirectionIndicator(deps.layer);
    this.banner = new NetLifeBanner(deps.layer);
    this.raycaster = new WorldRaycaster(deps.scene);
    this.raycaster.ignoreBody = deps.player.physicsBody;
    for (let i = 0; i < PENDING_IMPACTS; i++) {
      this.impacts.push({ active: false, at: 0, weaponId: "rifle", point: new Vector3(), normal: new Vector3(), direction: new Vector3() });
    }
  }

  /** Battle royale mode (null: M4 sandbox behaviour with respawns and slot names). */
  setMatchHooks(hooks: NetMatchHooks | null): void {
    this.matchHooks = hooks;
  }

  /** Display name of a slot: the roster's, else "Người chơi Bravo". */
  nameOf(slot: number): string {
    return this.matchHooks?.nameOf(slot) || netPlayerName(slot);
  }

  /** Slot the dead player's camera follows, or −1. */
  get spectating(): number {
    return this.life === "dead" ? this.spectateSlot : -1;
  }

  /** Follows `slot` while dead (it must be visible and not dead). Returns false otherwise. */
  follow(slot: number): boolean {
    if (!this.spectatable(slot)) return false;
    this.spectateSlot = slot;
    return true;
  }

  /** Next (+1) or previous (−1) player still in play, own team first. Returns the new slot or −1. */
  cycleSpectate(direction: 1 | -1): number {
    const start = this.spectateSlot < 0 ? (direction > 0 ? -1 : MAX_ENTITY_SLOTS) : this.spectateSlot;
    for (const teamOnly of [true, false]) {
      for (let step = 1; step <= MAX_ENTITY_SLOTS; step++) {
        const slot = (((start + direction * step) % MAX_ENTITY_SLOTS) + MAX_ENTITY_SLOTS) % MAX_ENTITY_SLOTS;
        if (!this.spectatable(slot) || (teamOnly && this.teams[slot] !== this.ownTeam)) continue;
        this.spectateSlot = slot;
        return slot;
      }
    }
    return -1;
  }

  /** Team of a slot (from Welcome's team size), −1 when unknown. */
  teamOf(slot: number): number {
    return slot === this.ownSlot ? this.ownTeam : (this.teams[slot] ?? -1);
  }

  private spectatable(slot: number): boolean {
    const { roster } = this.deps;
    return slot >= 0 && slot < MAX_ENTITY_SLOTS && slot !== this.ownSlot && roster.visible[slot] === 1 && remoteLifeCode(roster.poses[slot]!.flags) !== LifeCode.dead;
  }

  /** Blood bodies and footsteps for a newly created remote avatar (RemotePlayers `onAvatarCreated`). */
  registerAvatar(slot: number, body: Parameters<WeaponPresentation["registerBody"]>[1] | null): void {
    if (body) this.deps.presentation.registerBody(RemotePlayers.bodyId(slot), body);
  }

  // --- CombatFeedback ---------------------------------------------------------------------------------------------

  welcome(slot: number, team: number, teamSize?: number): void {
    this.ownSlot = slot;
    this.ownTeam = team;
    // Slot → team is fixed for the match (slot = team · teamSize + member), so the feed can colour every player.
    if (teamSize !== undefined && teamSize > 0) for (let i = 0; i < MAX_ENTITY_SLOTS; i++) this.teams[i] = Math.floor(i / teamSize);
  }

  remoteShot(shooter: number, shot: FiredShot): void {
    const { remotes, presentation } = this.deps;
    const first = shot.directions[0];
    const yaw = first ? Math.atan2(first.x, first.z) : 0;
    const pitch = first ? -Math.asin(Math.max(-1, Math.min(1, first.y))) : 0;
    const muzzle = this.muzzle;
    if (!remotes.muzzleToRef(shooter, yaw, pitch, shot.origin, muzzle, this.forward)) {
      muzzle.x = shot.origin.x;
      muzzle.y = shot.origin.y;
      muzzle.z = shot.origin.z;
    }
    presentation.playRemoteShot(shot, muzzle, this.forward);
    remotes.soldierOf(shooter)?.fire();
    this.queueWorldImpacts(shot);
  }

  remoteHit(victim: number, zone: HitZone, armor: boolean, dirX: number, dirZ: number): void {
    const { roster, remotes, presentation } = this.deps;
    if (roster.visible[victim] !== 1) return;
    const pose = roster.poses[victim]!;
    const p = this.hitPoint;
    const height = zoneHeight(zone, pose.flags);
    p.x = pose.x - dirX * 0.15;
    p.y = pose.y + height;
    p.z = pose.z - dirZ * 0.15;
    this.hitNormal.x = -dirX;
    this.hitNormal.y = 0;
    this.hitNormal.z = -dirZ;
    this.hitDirection.x = dirX;
    this.hitDirection.y = 0;
    this.hitDirection.z = dirZ;
    // Cancel the matching remote tracer's world impact: the bullet stopped in the body.
    for (const impact of this.impacts) {
      if (!impact.active) continue;
      const dx = impact.point.x - p.x;
      const dz = impact.point.z - p.z;
      if (impact.direction.x * dirX + impact.direction.z * dirZ > 0.9 && dx * dirX + dz * dirZ > 0) impact.active = false;
    }
    presentation.playRemoteImpact("rifle", p, this.hitNormal, this.hitDirection, { targetId: RemotePlayers.bodyId(victim), zone });
    if (armor) presentation.audio.audio.playArmorHit({ absorbed: 10, destroyed: false, position: p });
    remotes.noteHit(victim, dirX, dirZ);
    if (remoteLifeCode(pose.flags) === LifeCode.alive) remotes.soldierOf(victim)?.hit();
  }

  hitConfirm(hit: NetHitConfirm): void {
    const { combat, roster, player } = this.deps;
    const pose = roster.poses[hit.victim]!;
    const visible = roster.visible[hit.victim] === 1;
    const point = new Vector3(pose.x, pose.y + zoneHeight(hit.zone, pose.flags), pose.z);
    const eye = player.camera.position;
    const distance = visible ? Vector3.Distance(point, eye) : 0;
    combat.onDamage.notifyObservers({
      weapon: combat.activeWeapon,
      targetId: RemotePlayers.bodyId(hit.victim),
      targetName: this.nameOf(hit.victim),
      zone: hit.zone,
      amount: hit.damage,
      remainingHealth: 0,
      killed: hit.killed,
      point,
      distance,
      armorAbsorbed: hit.armorHit ? 1 : 0,
      armorSlot: hit.armorHit ? (hit.zone === "head" ? "helmet" : "vest") : null,
      armorDestroyed: hit.armorBroken,
    });
    this.matchHooks?.confirmedDamage(hit.victim, hit.damage);
  }

  damageTaken(hit: NetDamageTaken): void {
    if (hit.directionYaw !== null) this.indicator.show(hit.directionYaw, hit.amount, performance.now());
  }

  kill(kill: NetKill): void {
    if (kill.friendlyFire && kill.killer >= 0) {
      // Same team: remember it for the feed's colouring.
      this.teams[kill.victim] = this.teams[kill.killer]!;
    }
    if (kill.victim === this.ownSlot) {
      if (kill.knock) return;
      this.spectateSlot = kill.killer >= 0 && kill.killer !== this.ownSlot ? kill.killer : -1;
      const hooks = this.matchHooks;
      if (hooks && !hooks.respawns()) {
        // Battle royale: a standing teammate first, else the killer.
        const killer = this.spectateSlot;
        this.spectateSlot = -1;
        if (this.cycleSpectate(1) < 0 || this.teams[this.spectateSlot] !== this.ownTeam) this.spectateSlot = killer;
        hooks.ownDeath(kill);
        return;
      }
      this.banner.showDeath(this.deathCause(kill), NET_RESPAWN_SECONDS, performance.now());
      return;
    }
    if (!kill.knock) this.deps.presentation.playRemoteKill(RemotePlayers.bodyId(kill.victim));
  }

  killFeed(event: MatchEvent): void {
    if (this.matchHooks) {
      this.matchHooks.killFeed(event);
      return;
    }
    this.feed.push(event, (slot) => (slot === this.ownSlot ? t("common.you") : netPlayerName(slot)), (slot) => (slot === this.ownSlot ? this.ownTeam : this.teams[slot]!), this.ownTeam, performance.now());
  }

  vitals(vitals: Readonly<NetOwnerVitals>, previousLife: LifeState): void {
    this.equipmentView.setVitals(vitals);
    this.life = vitals.life;
    const { presentation } = this.deps;
    if (vitals.life === "dead") {
      presentation.weaponLowered = true;
      const hooks = this.matchHooks;
      if (hooks && !hooks.respawns()) {
        if (previousLife !== "dead") hooks.ownDeath(null);
      } else if (!this.banner.dead) {
        this.banner.showDeath(t("death.cause.died"), NET_RESPAWN_SECONDS, performance.now());
      }
    } else {
      if (previousLife === "dead") {
        this.banner.hide();
        this.spectateSlot = -1;
        this.deps.player.setCameraPunch(0, 0, 0);
      }
      presentation.weaponLowered = vitals.life === "downed";
    }
  }

  // --- PredictedHitSink -------------------------------------------------------------------------------------------

  predictedHit(_slot: number, _zone: HitZone, x: number, y: number, z: number): void {
    const p = this.hitPoint;
    p.x = x;
    p.y = y;
    p.z = z;
    this.deps.presentation.audio.predictedBodyHit(p);
  }

  // --- Frame ------------------------------------------------------------------------------------------------------

  /** Per frame after the player and remote avatars updated. */
  update(dt: number): void {
    this.time += dt;
    const now = performance.now();
    this.indicator.update(now, this.deps.player.getAim().yaw);
    this.banner.update(now);
    this.flushImpacts();
    if (this.life === "dead") this.spectate();
    this.updateReviving(dt);
  }

  dispose(): void {
    this.indicator.dispose();
    this.banner.dispose();
  }

  private deathCause(kill: NetKill): string {
    switch (kill.cause) {
      case "bleedOut":
        return t("death.cause.bleedOut");
      case "teamWipe":
        return t("death.cause.teamWiped");
      case "fall":
        return t("death.cause.fall");
      case "outOfBounds":
        return t("death.cause.outOfBounds");
      default: {
        if (kill.killer < 0) return t("death.cause.died");
        if (kill.killer === this.ownSlot) return t("death.cause.suicide", { weapon: killCauseLabel(kill.cause) });
        const cause = t("death.cause.killedBy", {
          killer: this.nameOf(kill.killer),
          weapon: killCauseLabel(kill.cause),
          headshot: kill.headshot ? t("feed.headshot") : "",
          teamKill: kill.friendlyFire ? t("feed.teamKill") : "",
        });
        return t("death.cause.distance", { cause, m: kill.distanceM });
      }
    }
  }

  /** Straight-line world rays for a remote shot's pellets; the impact plays when the bullet would get there. */
  private queueWorldImpacts(shot: FiredShot): void {
    const def = WEAPONS[shot.weaponId];
    const o = shot.origin;
    const end = this.rayEnd;
    const range = Math.min(IMPACT_RAY_M, def.maxRangeMeters);
    // Shotgun pellets share one surface: a couple of rays are enough for dust and sound.
    const rays = Math.min(shot.directions.length, 2);
    for (let i = 0; i < rays; i++) {
      const d = shot.directions[i]!;
      end.x = o.x + d.x * range;
      end.y = o.y + d.y * range;
      end.z = o.z + d.z * range;
      const hit = this.raycaster.cast(o, end);
      if (!hit) continue;
      let slot: PendingImpact | null = null;
      for (const impact of this.impacts) {
        if (!impact.active) {
          slot = impact;
          break;
        }
      }
      if (slot === null) break;
      slot.active = true;
      slot.at = this.time + (hit.fraction * range) / def.muzzleVelocity;
      slot.weaponId = shot.weaponId;
      slot.point.set(hit.point.x, hit.point.y, hit.point.z);
      slot.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      slot.direction.set(d.x, d.y, d.z);
    }
  }

  private flushImpacts(): void {
    for (const impact of this.impacts) {
      if (!impact.active || impact.at > this.time) continue;
      impact.active = false;
      this.deps.presentation.playRemoteImpact(impact.weaponId, impact.point, impact.normal, impact.direction, null);
    }
  }

  /** While dead: over-the-shoulder view of the killer, or of anyone still standing. Writes the player camera. */
  private spectate(): void {
    const { roster, player } = this.deps;
    let slot = this.spectateSlot;
    if (!this.spectatable(slot)) {
      this.spectateSlot = -1;
      slot = this.cycleSpectate(1);
    }
    if (slot < 0) return;
    const pose = roster.poses[slot]!;
    const eyeHeight = remoteLifeCode(pose.flags) === LifeCode.downed ? 0.5 : ((pose.flags & RemoteFlags.stanceMask) >> RemoteFlags.stanceShift) === StanceCode.stand ? 1.62 : 1.05;
    const eye = this.eye.set(pose.x, pose.y + eyeHeight, pose.z);
    const yaw = pose.yaw;
    const pitch = pose.pitch * 0.6;
    const cp = Math.cos(pitch);
    const fx = Math.sin(yaw) * cp;
    const fy = -Math.sin(pitch);
    const fz = Math.cos(yaw) * cp;
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const target = this.target.set(eye.x - fx * SPECTATE_BACK + rx * SPECTATE_RIGHT, eye.y - fy * SPECTATE_BACK + SPECTATE_UP, eye.z - fz * SPECTATE_BACK + rz * SPECTATE_RIGHT);
    const from = this.spectateFrom;
    from.x = eye.x;
    from.y = eye.y + SPECTATE_UP;
    from.z = eye.z;
    const to = this.spectateTo;
    to.x = target.x;
    to.y = target.y;
    to.z = target.z;
    const hit = this.raycaster.cast(from, to);
    if (hit) Vector3.LerpToRef(eye.set(from.x, from.y, from.z), target, Math.max(0, hit.fraction - SPECTATE_WALL_MARGIN / SPECTATE_BACK), target);
    player.camera.position.copyFrom(target);
    player.camera.rotation.set(pitch, yaw, 0);
  }

  /**
   * Nearest downed remote player in revive reach (horizontal range and height band), or −1. `teammatesOnly`: skip slots
   * known to be on another team (F loots instead of reviving an enemy).
   */
  downedInReach(teammatesOnly = false): number {
    const { roster, player } = this.deps;
    const feet = player.tickFeet;
    let best = REVIVE_RANGE_M * REVIVE_RANGE_M;
    let target = -1;
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      if (roster.visible[slot] !== 1) continue;
      if (teammatesOnly && this.teams[slot]! >= 0 && this.teams[slot] !== this.ownTeam) continue;
      const pose = roster.poses[slot]!;
      if (remoteLifeCode(pose.flags) !== LifeCode.downed || Math.abs(pose.y - feet.y) > REVIVE_VERTICAL_RANGE_M) continue;
      const dx = pose.x - feet.x;
      const dz = pose.z - feet.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= best) {
        best = d2;
        target = slot;
      }
    }
    return target;
  }

  /** Revive ring: the server's progress once the teammate vitals report us as the reviver, a local estimate until then. */
  private updateReviving(dt: number): void {
    const { input } = this.deps;
    const holding = this.life === "alive" && input.isLocked && input.isActionDown("interact");
    const target = holding ? this.downedInReach() : -1;
    if (target < 0) {
      this.reviveHeld = 0;
      this.banner.hideReviving();
      return;
    }
    this.reviveHeld += dt;
    const server = this.matchHooks?.reviveProgress?.() ?? -1;
    this.banner.showReviving(server >= 0 ? server : this.reviveHeld / REVIVE_SECONDS, this.nameOf(target));
    if (this.reviveHeld >= REVIVE_SECONDS + 0.5) this.reviveHeld = REVIVE_SECONDS + 0.5;
  }
}

/** Hit point height above the feet for a zone, by posture. */
function zoneHeight(zone: HitZone, flags: number): number {
  const life = remoteLifeCode(flags);
  if (life !== LifeCode.alive) return 0.25;
  const crouched = ((flags & RemoteFlags.stanceMask) >> RemoteFlags.stanceShift) !== StanceCode.stand;
  const scale = crouched ? 0.68 : 1;
  return (zone === "head" ? 1.65 : zone === "body" ? 1.25 : 0.75) * scale;
}
