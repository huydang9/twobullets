import { LifeCode } from "@twobullets/protocol/codes";
import { Btn, type PlayerInput } from "@twobullets/shared/input";
import { combatInputInto, createCombatInput, createWeaponContext, stepPlayerWeapon } from "@twobullets/shared/weapons/playerWeapon";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import { describe, expect, it } from "vitest";
import { createNetWeaponState, NetHandsGate, netCombatLink, netHandsBusy } from "../../src/net/netCombatRules";

// Networked play runs equipment locally while the server steps weapons from the wire buttons: a throwable in hand or an
// item in use must clear fire/aim/reload in the sent input, which is also what the local prediction steps.

const TICK = 1 / 60;

function harness(held: number) {
  let weaponState: WeaponState = createNetWeaponState();
  const hands = { busy: false };
  const combat = {
    get weaponState() {
      return weaponState;
    },
    takeCombatInput(out: { buttons: number; select: number }) {
      out.buttons = held;
      out.select = 0;
    },
  };
  const link = netCombatLink(combat, { handsBusy: () => hands.busy, interactHeld: () => false, life: () => LifeCode.alive });
  const ctx = createWeaponContext();
  const combatInput = createCombatInput();
  /** One live tick: the outgoing input and the shots the local prediction fired from it. */
  const tick = (): { buttons: number; shots: number } => {
    const out = { buttons: 0, select: 0 };
    link.takeCombatInput(out);
    const input: PlayerInput = { tick: 0, forward: 0, right: 0, buttons: out.buttons, select: out.select, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null };
    const result = stepPlayerWeapon(weaponState, combatInputInto(combatInput, input), ctx, TICK, false);
    weaponState = result.state;
    return { buttons: out.buttons, shots: result.shots.length };
  };
  return { hands, tick, setHeld: (buttons: number) => (held = buttons) };
}

describe("networked hands gate", () => {
  it("hands busy + fire held: no local shot and no fire bit in the outgoing input", () => {
    const h = harness(Btn.fire | Btn.aim | Btn.reload | Btn.sprint);
    h.hands.busy = true;
    let shots = 0;
    for (let i = 0; i < 30; i++) {
      const { buttons, shots: fired } = h.tick();
      expect(buttons & (Btn.fire | Btn.aim | Btn.reload)).toBe(0);
      expect(buttons & Btn.sprint).toBe(Btn.sprint);
      shots += fired;
    }
    expect(shots).toBe(0);
  });

  it("the throw click stays blocked until fire is released, then shoots", () => {
    const h = harness(Btn.fire);
    h.hands.busy = true;
    h.tick();
    // Throw released, trigger still held.
    h.hands.busy = false;
    for (let i = 0; i < 10; i++) expect(h.tick()).toEqual({ buttons: 0, shots: 0 });
    h.setHeld(0);
    h.tick();
    h.setHeld(Btn.fire);
    const { buttons, shots } = h.tick();
    expect(buttons & Btn.fire).toBe(Btn.fire);
    expect(shots).toBeGreaterThan(0);
  });

  it("hands free: fire passes and shoots", () => {
    const h = harness(Btn.fire);
    const { buttons, shots } = h.tick();
    expect(buttons).toBe(Btn.fire);
    expect(shots).toBeGreaterThan(0);
  });

  it("busy means a throwable out in any phase or an item in use", () => {
    expect(netHandsBusy("idle", false)).toBe(false);
    for (const phase of ["equipping", "ready", "primed", "cooking", "releasing"]) expect(netHandsBusy(phase, false)).toBe(true);
    expect(netHandsBusy("idle", true)).toBe(true);
    const gate = new NetHandsGate();
    expect(gate.apply(Btn.jump | Btn.fire, true)).toBe(Btn.jump);
  });
});
