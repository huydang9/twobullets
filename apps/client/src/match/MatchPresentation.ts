import type { HitZone, MatchEvent, MatchFxEvent, MatchView } from "@twobullets/shared";
import type { WeaponPresentation } from "../fx/WeaponPresentation";
import type { BotBodies } from "./BotBodies";

/**
 * Bridges match events to what the player sees and hears (docs/bots/design.md §9.4): bot shots → spatial gunshot,
 * third-person muzzle flash, tracers and near misses; impacts → dust, holes and blood; weapon events and damage →
 * soldier clips. Human shots and grenades already present themselves through CombatSystem and EquipmentSystem.
 */
export class MatchPresentation {
  private readonly unsubscribe: (() => void)[];
  private readonly muzzle = { x: 0, y: 0, z: 0 };
  private readonly forward = { x: 0, y: 0, z: 1 };
  private readonly zoneHit: { targetId: string | null; zone: HitZone } = { targetId: null, zone: "body" };

  constructor(
    match: MatchView,
    private readonly bodies: BotBodies,
    private readonly presentation: WeaponPresentation,
  ) {
    for (const body of bodies.list) presentation.registerBody(body.id, body.soldier);
    presentation.audio.footsteps.sources.push(bodies);
    this.unsubscribe = [match.onFx((event) => this.handleFx(event)), match.onEvent((event) => this.handleEvent(event))];
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    for (const body of this.bodies.list) this.presentation.unregisterBody(body.id);
    const sources = this.presentation.audio.footsteps.sources;
    const index = sources.indexOf(this.bodies);
    if (index >= 0) sources.splice(index, 1);
  }

  private handleFx(event: MatchFxEvent): void {
    const body = this.bodies.bySlot[event.slot];
    switch (event.type) {
      case "shot": {
        if (!body?.actor) break;
        const shot = event.shot;
        const first = shot.directions[0];
        const yaw = first ? Math.atan2(first.x, first.z) : body.actor.yaw;
        const pitch = first ? -Math.asin(Math.max(-1, Math.min(1, first.y))) : body.actor.pitch;
        body.muzzleToRef(yaw, pitch, this.muzzle, this.forward);
        this.presentation.playRemoteShot(shot, this.muzzle, this.forward);
        body.soldier.fire();
        break;
      }
      case "weapon":
        if (body && event.event.type === "reloadStarted") body.soldier.reload(event.event.seconds);
        break;
      case "impact": {
        const victim = event.victim;
        if (victim < 0) {
          this.presentation.playRemoteImpact(event.weaponId, event.point, event.normal, event.direction, null);
          break;
        }
        const hit = this.zoneHit;
        hit.targetId = this.bodies.bySlot[victim]?.id ?? null;
        hit.zone = event.zone ?? "body";
        const victimBody = this.bodies.bySlot[victim];
        victimBody?.lastHitDirection.set(event.direction.x, event.direction.y, event.direction.z);
        this.presentation.playRemoteImpact(event.weaponId, event.point, event.normal, event.direction, hit);
        break;
      }
      case "throwRelease":
      case "itemUse":
        // Grenades render from EquipmentSystem's world; no third-person throw or heal clips yet (asset request).
        break;
    }
  }

  private handleEvent(event: MatchEvent): void {
    switch (event.type) {
      case "damage": {
        const body = this.bodies.bySlot[event.victim];
        if (body?.actor && body.actor.life !== "dead" && event.kind !== "zone" && event.kind !== "bleed") body.soldier.hit();
        break;
      }
      case "kill": {
        const body = this.bodies.bySlot[event.victim];
        if (body) this.presentation.playRemoteKill(body.id);
        break;
      }
      default:
        break;
    }
  }
}
