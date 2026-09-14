import { NO_ARMOR, applyArmor, createArmorPiece, type ArmorLevel, type ArmorLoadout, type ArmorResult, type DamageKind, type HitZone } from "@twobullets/shared";

/**
 * Helmets and vests worn by non-player targets (practice soldiers now, bots later), keyed by target id. Hits run through
 * the shared armor rules before the target's own health; worn pieces lose durability and break like the player's.
 */
export class TargetArmor {
  private readonly worn = new Map<string, ArmorLoadout>();
  /** What each target spawns with, restored when it respawns. */
  private readonly issued = new Map<string, ArmorLoadout>();

  get(targetId: string): ArmorLoadout {
    return this.worn.get(targetId) ?? NO_ARMOR;
  }

  /** Gives a target armor, also restored by {@link restore} (e.g. when the target respawns). */
  issue(targetId: string, armor: ArmorLoadout): void {
    this.issued.set(targetId, armor);
    this.worn.set(targetId, armor);
  }

  restore(targetId: string): void {
    const armor = this.issued.get(targetId);
    if (armor) this.worn.set(targetId, armor);
  }

  /** Applies armor to a hit and keeps the damaged loadout. */
  absorb(targetId: string, amount: number, kind: DamageKind, zone: HitZone | null): ArmorResult {
    const result = applyArmor(this.get(targetId), amount, kind, zone);
    if (result.slot) this.worn.set(targetId, result.armor);
    return result;
  }
}

/**
 * DEV (`?targetArmor=1`): a deterministic mix for testing absorption: every third soldier wears a level 2 helmet and
 * vest, the next a level 1 vest, the rest nothing.
 */
export function testTargetArmor(index: number): ArmorLoadout {
  const piece = (slot: "helmet" | "vest", level: ArmorLevel) => createArmorPiece(slot, level);
  switch (index % 3) {
    case 0:
      return { helmet: piece("helmet", 2), vest: piece("vest", 2) };
    case 1:
      return { helmet: null, vest: piece("vest", 1) };
    default:
      return NO_ARMOR;
  }
}
