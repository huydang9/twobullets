import { Vector3 } from "@babylonjs/core";
import {
  armorLoadout,
  type ArmorLoadout,
  type DamageContext,
  type DamageOutcome,
  type ExternalActorPose,
  type InventoryState,
  type MatchExternalActor,
  type Vec3,
  type Vitals,
  type VitalsHit,
} from "@twobullets/shared";
import type { CombatSystem } from "../combat/CombatSystem";
import type { EquipmentSystem } from "../equipment/EquipmentSystem";
import { LOCAL_PLAYER_ID } from "../equipment/types";
import type { PlayerController, PlayerTick } from "../player/PlayerController";

/**
 * The offline human as a match actor (docs/bots/design.md §9.3): pose from PlayerController and CombatSystem, bot damage
 * through EquipmentSystem's vitals and armor (HUD, hurt direction, knock), team knock rule and bot revives through
 * EquipmentSystem, and the death drop on elimination. Slot 0 = LOCAL_PLAYER_ID.
 */
export class HumanActor implements MatchExternalActor {
  readonly slot = LOCAL_PLAYER_ID;
  private readonly eye = new Vector3();
  private yaw = 0;
  private pitch = 0;
  private armorInventory: InventoryState | null = null;
  private armorCache: ArmorLoadout = { helmet: null, vest: null };
  private eliminated = false;

  constructor(
    private readonly player: PlayerController,
    private readonly combat: CombatSystem,
    private readonly equipment: EquipmentSystem,
    /** Called once when the match eliminates the human (after the death pile dropped). */
    private readonly onEliminated: () => void,
    private readonly deathPileId: number,
  ) {
    const aim = player.getAim();
    this.yaw = aim.yaw;
    this.pitch = aim.pitch;
  }

  get vitals(): Vitals {
    return this.equipment.vitals;
  }

  /** Cached per inventory object (the match reads it every tick). */
  get armor(): ArmorLoadout {
    const inventory = this.equipment.inventory;
    if (inventory !== this.armorInventory) {
      this.armorInventory = inventory;
      this.armorCache = armorLoadout(inventory);
    }
    return this.armorCache;
  }

  get isEliminated(): boolean {
    return this.eliminated;
  }

  /** The tick's simulated (dequantized) aim; call from the host's onTick before `MatchSim.tick`. */
  captureTick(tick: PlayerTick): void {
    this.yaw = tick.input.yaw;
    this.pitch = tick.input.pitch;
  }

  readPose(out: ExternalActorPose): void {
    const player = this.player;
    const move = player.moveState;
    const feet = player.tickFeet;
    copy(out.feet, feet);
    copy(out.eye, player.getEyeToRef(this.eye));
    copy(out.velocity, move.velocity);
    out.yaw = this.yaw;
    out.pitch = this.pitch;
    out.stance = move.stance;
    out.grounded = move.grounded;
    out.sprinting = move.sprinting;
    out.adsBlend = this.combat.weaponState.adsBlend;
    const combat = this.combat;
    out.weaponId = combat.armed && this.equipment.throwState.phase === "idle" && this.equipment.use === null ? combat.activeWeapon.id : null;
  }

  applyDamage(hit: VitalsHit, ctx: DamageContext, position: Vec3): DamageOutcome | null {
    if (this.equipment.vitals.life === "dead") return null;
    this.equipment.canBeKnocked = ctx.canBeKnocked;
    return this.equipment.applyPlayerDamage({ amount: hit.amount, kind: hit.kind, zone: hit.zone, sourceId: hit.sourceId, position });
  }

  setCanBeKnocked(value: boolean): void {
    this.equipment.canBeKnocked = value;
  }

  setReviver(slot: number | null): void {
    this.equipment.setReviver(slot);
  }

  eliminate(): void {
    if (this.eliminated) return;
    this.eliminated = true;
    this.equipment.dropInventoryAt(this.player.tickFeet, this.deathPileId);
    this.onEliminated();
  }
}

function copy(out: Vec3, from: Vec3): void {
  (out as { x: number }).x = from.x;
  (out as { y: number }).y = from.y;
  (out as { z: number }).z = from.z;
}
