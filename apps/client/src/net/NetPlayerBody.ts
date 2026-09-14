import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import type { PlayerInput } from "@twobullets/shared/input";
import type { MoveState, Vec3 } from "@twobullets/shared/movement/types";
import { combatInputInto, createCombatInput, createWeaponContext, stepPlayerWeapon, weaponContextInto } from "@twobullets/shared/weapons/playerWeapon";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import type { CombatSystem } from "../combat/CombatSystem";
import type { PlayerController } from "../player/PlayerController";
import type { PredictedBody } from "./LocalPlayerNet";

/**
 * The browser's predicted player: PlayerController's movement tick followed by CombatSystem's weapon tick is the
 * `stepPlayer(..., { weapons: true })` composition (movement modifiers from the start-of-tick weapon state through
 * `NetMovement`, then `stepPlayerWeapon` at the moved eye with the input's dequantized aim). Replays run the same two
 * halves with `replay: true`, so nothing is observed: no recoil, shots, FX or audio.
 *
 * In networked play CombatSystem runs without equipment (no inventory sync, no gate), so its tick is exactly the
 * shared weapon half.
 */
export class NetPlayerBody implements PredictedBody {
  private readonly player: PlayerController;
  private readonly combat: CombatSystem;
  private readonly combatInput = createCombatInput();
  private readonly context = createWeaponContext();

  constructor(player: PlayerController, combat: CombatSystem) {
    this.player = player;
    this.combat = combat;
  }

  get tickFeet(): Readonly<Vec3> {
    return this.player.tickFeet;
  }

  get moveState(): MoveState {
    return this.player.moveState;
  }

  get weaponState(): WeaponState {
    return this.combat.weaponState;
  }

  restoreMove(feet: Vec3, state: MoveState): void {
    this.player.restoreMove(feet, state);
  }

  restoreWeapon(state: WeaponState): void {
    this.combat.weaponState = state;
  }

  replayTick(input: PlayerInput): MoveState {
    // Movement reads `NetMovement.weapon` → combat.weaponState: still the start-of-tick state here.
    const move = this.player.replayTick(input);
    const ctx = weaponContextInto(this.context, this.player.tickFeet, move, input);
    this.combat.weaponState = stepPlayerWeapon(this.combat.weaponState, combatInputInto(this.combatInput, input), ctx, TICK_SECONDS, true).state;
    return move;
  }

  setRenderOffset(x: number, y: number, z: number): void {
    this.player.setRenderOffset(x, y, z);
  }
}
