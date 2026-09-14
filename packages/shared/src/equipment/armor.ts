import type { HitZone } from "../weapons/types";
import { armorDef, armorItemId, type ArmorLevel } from "./items";
import { round1 } from "./math";

export type ArmorSlot = "helmet" | "vest";

/** A worn helmet or vest. Durability counts down in absorbed damage points. */
export interface ArmorPiece {
  readonly level: ArmorLevel;
  readonly durability: number;
}

export interface ArmorLoadout {
  readonly helmet: ArmorPiece | null;
  readonly vest: ArmorPiece | null;
}

export type DamageKind = "bullet" | "explosion" | "fire" | "fall" | "zone" | "bleed";

export interface ArmorResult {
  readonly armor: ArmorLoadout;
  /** Damage left after armor. */
  readonly amount: number;
  readonly absorbed: number;
  /** Slot that absorbed the hit, if any. */
  readonly slot: ArmorSlot | null;
  readonly durabilityBefore: number;
  readonly durabilityAfter: number;
  readonly destroyed: boolean;
}

export const NO_ARMOR: ArmorLoadout = { helmet: null, vest: null };

export function createArmorPiece(slot: ArmorSlot, level: ArmorLevel): ArmorPiece {
  return { level, durability: armorDef(armorItemId(slot, level)).durability };
}

/**
 * Which armor slot protects a hit. Bullets: helmet for the head, vest for the body; limbs are unprotected.
 * Explosions: vest only. Fire, falls, the zone and bleeding ignore armor.
 */
export function armorSlotFor(kind: DamageKind, zone: HitZone | null): ArmorSlot | null {
  if (kind === "bullet") return zone === "head" ? "helmet" : zone === "body" ? "vest" : null;
  if (kind === "explosion") return "vest";
  return null;
}

/**
 * Armor reduction: the slot absorbs `reduction` of the damage, capped by its remaining durability, and loses the
 * absorbed amount. The piece is destroyed (slot emptied) when durability reaches zero.
 */
export function applyArmor(armor: ArmorLoadout, amount: number, kind: DamageKind, zone: HitZone | null): ArmorResult {
  const slot = armorSlotFor(kind, zone);
  const piece = slot ? armor[slot] : null;
  if (!slot || !piece || amount <= 0) {
    return { armor, amount: Math.max(0, amount), absorbed: 0, slot: null, durabilityBefore: 0, durabilityAfter: 0, destroyed: false };
  }
  const def = armorDef(armorItemId(slot, piece.level));
  const absorbed = round1(Math.min(amount * def.reduction, piece.durability));
  const durabilityAfter = round1(Math.max(0, piece.durability - absorbed));
  const destroyed = durabilityAfter <= 0;
  const next: ArmorPiece | null = destroyed ? null : { level: piece.level, durability: durabilityAfter };
  return {
    armor: slot === "helmet" ? { helmet: next, vest: armor.vest } : { helmet: armor.helmet, vest: next },
    amount: round1(amount - absorbed),
    absorbed,
    slot,
    durabilityBefore: piece.durability,
    durabilityAfter,
    destroyed,
  };
}

/** 0..1 remaining durability, for the HUD. */
export function armorCondition(slot: ArmorSlot, piece: ArmorPiece | null): number {
  if (!piece) return 0;
  return piece.durability / armorDef(armorItemId(slot, piece.level)).durability;
}
