import { describe, expect, it } from "vitest";
import { applyArmor, createArmorPiece, NO_ARMOR, type ArmorLoadout } from "./armor";
import { ITEM_IDS, ITEMS, itemCode } from "./items";
import {
  applyConsumable,
  applyDamage,
  boostHealPerPulse,
  boostSpeedScale,
  boostTier,
  canBeKnocked,
  consumableBlock,
  createVitals,
  eliminate,
  findTeamWipes,
  stepRevive,
  stepVitals,
  VITALS,
  type TeamMember,
  type Vitals,
  type VitalsHit,
} from "./vitals";

const DT = 1 / 60;
const bullet = (amount: number, zone: VitalsHit["zone"] = "body", sourceId = 7): VitalsHit => ({ amount, kind: "bullet", zone, sourceId });
const KNOCKABLE = { canBeKnocked: true };
const SOLO = { canBeKnocked: false };

function runVitals(vitals: Vitals, seconds: number): { vitals: Vitals; events: string[] } {
  const events: string[] = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    const step = stepVitals(vitals, DT);
    vitals = step.vitals;
    events.push(...step.events.map((e) => e.type));
  }
  return { vitals, events };
}

describe("item catalog", () => {
  it("keys every definition by its own id and gives each a unique wire code", () => {
    for (const [key, def] of Object.entries(ITEMS)) expect(def.id).toBe(key);
    expect(new Set(ITEM_IDS).size).toBe(ITEM_IDS.length);
    expect(ITEM_IDS.length).toBe(Object.keys(ITEMS).length);
    expect(ITEM_IDS.every((id) => itemCode(id) < 256)).toBe(true);
  });

  it("matches the PUBG-like consumable numbers", () => {
    expect([ITEMS.bandage.healAmount, ITEMS.bandage.healCap, ITEMS.bandage.useSeconds]).toEqual([10, 75, 4]);
    expect([ITEMS.first_aid.healCap, ITEMS.first_aid.useSeconds]).toEqual([75, 6]);
    expect([ITEMS.medkit.healCap, ITEMS.medkit.useSeconds]).toEqual([100, 8]);
    expect([ITEMS.energy_drink.boostAmount, ITEMS.energy_drink.useSeconds]).toEqual([40, 4]);
    expect([ITEMS.painkiller.boostAmount, ITEMS.painkiller.useSeconds]).toEqual([60, 6]);
  });
});

describe("armor", () => {
  const armor: ArmorLoadout = { helmet: createArmorPiece("helmet", 2), vest: createArmorPiece("vest", 3) };

  it("reduces head damage with the helmet and body damage with the vest, never limbs", () => {
    const head = applyArmor(armor, 50, "bullet", "head");
    expect(head.slot).toBe("helmet");
    expect(head.absorbed).toBe(20);
    expect(head.amount).toBe(30);
    expect(head.armor.helmet?.durability).toBe(ITEMS.helmet_2.durability - 20);

    const body = applyArmor(armor, 20, "bullet", "body");
    expect(body.slot).toBe("vest");
    expect(body.amount).toBe(9);
    expect(body.armor.vest?.durability).toBe(ITEMS.vest_3.durability - 11);

    const limb = applyArmor(armor, 20, "bullet", "limb");
    expect(limb.slot).toBeNull();
    expect(limb.amount).toBe(20);
    expect(limb.armor).toBe(armor);
  });

  it("uses the vest for explosions and nothing for fire", () => {
    expect(applyArmor(armor, 100, "explosion", "body").amount).toBe(45);
    expect(applyArmor(armor, 100, "explosion", "head").slot).toBe("vest");
    expect(applyArmor(armor, 10, "fire", null).amount).toBe(10);
  });

  it("caps absorption by durability and destroys the piece at zero", () => {
    const worn: ArmorLoadout = { helmet: { level: 1, durability: 5 }, vest: null };
    const result = applyArmor(worn, 44, "bullet", "head");
    expect(result.absorbed).toBe(5);
    expect(result.amount).toBe(39);
    expect(result.destroyed).toBe(true);
    expect(result.armor.helmet).toBeNull();
  });

  it("wears down over repeated hits until broken", () => {
    let loadout: ArmorLoadout = { helmet: null, vest: createArmorPiece("vest", 2) };
    let hits = 0;
    let absorbed = 0;
    while (loadout.vest && hits < 100) {
      const r = applyArmor(loadout, 22, "bullet", "body");
      absorbed += r.absorbed;
      loadout = r.armor;
      hits++;
    }
    // 22 × 0.4 = 8.8 absorbed per rifle hit → 100 durability lasts 12 hits.
    expect(hits).toBe(12);
    expect(absorbed).toBeCloseTo(ITEMS.vest_2.durability, 5);
  });
});

describe("applyDamage", () => {
  it("removes health after armor", () => {
    const armor: ArmorLoadout = { helmet: null, vest: createArmorPiece("vest", 1) };
    const out = applyDamage(createVitals(), armor, bullet(40), KNOCKABLE);
    expect(out.dealt).toBe(28);
    expect(out.vitals.health).toBe(72);
    expect(out.armor.vest?.durability).toBe(ITEMS.vest_1.durability - 12);
    expect(out.knocked || out.killed).toBe(false);
  });

  it("knocks instead of killing when a teammate stands, dropping overflow and boost", () => {
    const vitals = { ...createVitals(), health: 30, boost: 50 };
    const out = applyDamage(vitals, NO_ARMOR, bullet(80, "body", 3), KNOCKABLE);
    expect(out.knocked).toBe(true);
    expect(out.killed).toBe(false);
    expect(out.dealt).toBe(30);
    expect(out.vitals).toMatchObject({ life: "downed", health: 0, boost: 0, downedHealth: VITALS.downedHealth, knockCount: 1, knockedById: 3 });
  });

  it("kills solo players (or the last one standing) outright", () => {
    const out = applyDamage({ ...createVitals(), health: 10 }, NO_ARMOR, bullet(50, "head", 4), SOLO);
    expect(out.killed).toBe(true);
    expect(out.killerId).toBe(4);
    expect(out.vitals.life).toBe("dead");
  });

  it("drains the downed pool and credits the finisher", () => {
    let vitals = applyDamage(createVitals(), NO_ARMOR, bullet(200, "body", 1), KNOCKABLE).vitals;
    const hurt = applyDamage(vitals, NO_ARMOR, bullet(60, "body", 2), KNOCKABLE);
    expect(hurt.vitals.downedHealth).toBe(40);
    vitals = hurt.vitals;
    const finish = applyDamage(vitals, NO_ARMOR, bullet(60, "limb", 5), KNOCKABLE);
    expect(finish.killed).toBe(true);
    expect(finish.killerId).toBe(5);
    expect(finish.dealt).toBe(40);
    expect(applyDamage(finish.vitals, NO_ARMOR, bullet(10), KNOCKABLE).dealt).toBe(0);
  });

  it("takes friendly fire and self damage like any other source", () => {
    expect(applyDamage(createVitals(), NO_ARMOR, { amount: 25, kind: "explosion", zone: "body", sourceId: 0 }, KNOCKABLE).vitals.health).toBe(75);
  });
});

describe("bleed-out, revive and team wipes", () => {
  const downed = (knocks = 0): Vitals => {
    const base = { ...createVitals(), knockCount: knocks };
    return applyDamage(base, NO_ARMOR, bullet(500, "body", 9), KNOCKABLE).vitals;
  };

  it("bleeds out in 25 s on the first knock and faster on later ones", () => {
    const first = runVitals(downed(), 24.9);
    expect(first.vitals.life).toBe("downed");
    const out = runVitals(first.vitals, 0.2);
    expect(out.vitals.life).toBe("dead");
    expect(out.events).toEqual(["bledOut"]);
    expect(runVitals(downed(2), 12).vitals.life).toBe("dead");
  });

  it("revives after 5 s of holding, pausing the bleed-out, to 10 HP", () => {
    let target = downed();
    let events: string[] = [];
    for (let i = 0; i < 5 * 60; i++) {
      const bleed = stepVitals(target, DT);
      const revive = stepRevive(bleed.vitals, 2, true, DT);
      target = revive.target;
      if (revive.event) events.push(revive.event.type);
    }
    expect(events).toEqual(["reviveStarted", "revived"]);
    expect(target).toMatchObject({ life: "alive", health: VITALS.reviveHealth, reviverId: -1 });
  });

  it("cancels on release and resets progress; a second reviver is ignored", () => {
    let target = downed();
    for (let i = 0; i < 120; i++) target = stepRevive(target, 2, true, DT).target;
    expect(target.reviveProgress).toBeCloseTo(2, 5);
    expect(stepRevive(target, 3, true, DT).target).toBe(target);
    const released = stepRevive(target, 2, false, DT);
    expect(released.event?.type).toBe("reviveCancelled");
    expect(released.target.reviveProgress).toBe(0);
    // Bleeding resumes once nobody is reviving.
    expect(stepVitals(released.target, 1).vitals.downedHealth).toBeLessThan(target.downedHealth);
  });

  it("knocks only while a teammate stands and eliminates a team that is all down", () => {
    const alive = createVitals();
    const members: TeamMember[] = [
      { id: 1, team: 0, vitals: alive },
      { id: 2, team: 0, vitals: downed() },
      { id: 3, team: 1, vitals: downed() },
      { id: 4, team: 1, vitals: { ...alive, life: "dead", health: 0 } },
      { id: 5, team: 2, vitals: alive },
    ];
    expect(canBeKnocked(1, 0, members)).toBe(false);
    expect(canBeKnocked(2, 0, members)).toBe(true);
    expect(canBeKnocked(5, 2, members)).toBe(false);
    expect(findTeamWipes(members)).toEqual([3]);
    expect(eliminate(members[2]!.vitals).life).toBe("dead");

    // Knocking the last standing member of team 0 wipes it.
    const last = applyDamage(alive, NO_ARMOR, bullet(200), { canBeKnocked: canBeKnocked(1, 0, members) });
    expect(last.killed).toBe(true);
    const after = members.map((m) => (m.id === 1 ? { ...m, vitals: last.vitals } : m));
    expect(findTeamWipes(after)).toEqual([2, 3]);
  });
});

describe("boost", () => {
  it("maps boost to heal tiers and speed bonuses", () => {
    expect([0, 10, 20, 21, 60, 61, 90, 91, 100].map(boostHealPerPulse)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect([0, 20, 40, 80, 95].map(boostTier)).toEqual([0, 1, 2, 3, 4]);
    expect(boostSpeedScale(59)).toBe(1);
    expect(boostSpeedScale(60)).toBe(1.025);
    expect(boostSpeedScale(95)).toBe(1.06);
  });

  it("decays at 0.4/s and heals in 6 s pulses by the tier at pulse time", () => {
    const start: Vitals = { ...createVitals(), health: 50, boost: 100 };
    const { vitals, events } = runVitals(start, 6);
    expect(vitals.boost).toBeCloseTo(100 - 0.4 * 6, 5);
    expect(vitals.health).toBe(54);
    expect(events).toEqual(["boostHeal"]);

    // A full bar heals ≈ 4×4 + 12.5×3 + 16.7×2 + 8.3×1 HP over its 250 s.
    const full = runVitals(start, 260).vitals;
    expect(full.boost).toBe(0);
    expect(full.health).toBe(100);
    const low = runVitals({ ...createVitals(), health: 10, boost: 40 }, 110).vitals;
    expect(low.health).toBeGreaterThan(30);
    expect(low.health).toBeLessThan(40);
  });

  it("doesn't heal or decay while downed", () => {
    const knocked = applyDamage({ ...createVitals(), boost: 80 }, NO_ARMOR, bullet(500), KNOCKABLE).vitals;
    expect(knocked.boost).toBe(0);
  });
});

describe("consumables", () => {
  it("caps heals and blocks useless uses", () => {
    const hurt = { ...createVitals(), health: 70 };
    expect(applyConsumable(hurt, "bandage").health).toBe(75);
    expect(applyConsumable({ ...hurt, health: 20 }, "bandage").health).toBe(30);
    expect(applyConsumable({ ...hurt, health: 20 }, "first_aid").health).toBe(75);
    expect(applyConsumable(hurt, "medkit").health).toBe(100);
    expect(applyConsumable({ ...hurt, boost: 80 }, "painkiller").boost).toBe(100);
    expect(consumableBlock({ ...hurt, health: 75 }, "bandage")).toBe("healthFull");
    expect(consumableBlock({ ...hurt, health: 75 }, "medkit")).toBeNull();
    expect(consumableBlock(createVitals(), "medkit")).toBe("healthFull");
    expect(consumableBlock({ ...hurt, boost: 100 }, "energy_drink")).toBe("boostFull");
    expect(consumableBlock({ ...hurt, life: "downed" }, "bandage")).toBe("notAlive");
  });
});
