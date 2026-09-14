import type { WeaponId } from "@twobullets/shared";
import type { ClipPlan } from "../viewmodel/clipPlans";
import type { GameAudio } from "./GameAudio";

const RELOAD_TAG = "reload";
const CYCLE_TAG = "cycle";

/**
 * The local player's weapon sounds, driven by viewmodel clip plans so mag, bolt, pump and slide recordings land on the
 * animation frames that make them (viewmodel/timelines.ts).
 */
export class WeaponAudio {
  constructor(private readonly audio: GameAudio) {}

  shot(weaponId: WeaponId, muzzle: { x: number; y: number; z: number }): void {
    this.audio.playGunshot({ weaponId, position: muzzle, shooterIsLocal: true });
  }

  dryFire(weaponId: WeaponId): void {
    this.audio.playMechanical({ kind: "dryFire", weaponId, position: null });
  }

  equip(weaponId: WeaponId): void {
    this.audio.engine.stopTag(RELOAD_TAG);
    this.audio.playMechanical({ kind: "equip", weaponId, position: null });
  }

  reloadStarted(weaponId: WeaponId, plan: ClipPlan): void {
    this.schedule(weaponId, plan, RELOAD_TAG);
  }

  reloadCancelled(): void {
    this.audio.engine.stopTag(RELOAD_TAG);
  }

  /** Bolt or pump after a shot; a new shot cuts off the previous cycle. */
  actionCycle(weaponId: WeaponId, plan: ClipPlan): void {
    this.schedule(weaponId, plan, CYCLE_TAG);
  }

  private schedule(weaponId: WeaponId, plan: ClipPlan, tag: string): void {
    this.audio.engine.stopTag(tag);
    for (const cue of plan.cues) {
      this.audio.playMechanical({ kind: cue.kind, weaponId, position: null, delay: cue.at, span: cue.span, tag });
    }
  }
}
