import type { FireMode } from "../../weapons/types";
import type { BotAimProfile, BotFireProfile } from "../types";
import { ticksFor, type BotRandom } from "../brain/util";

// Trigger discipline (design.md §6 step 7): the gate opens when the aim error is inside the tolerance, the first-shot
// delay has passed since first on target and no teammate is on the line. Automatic weapons hold for a burst length by
// range band, then pause; semi and bolt weapons tap (press one tick, release the next) at most at their fire rate.

/** During an automatic burst, keep firing while the error is within this multiple of the tolerance. */
const BURST_TOLERANCE_SCALE = 2;

export class FireControl {
  private onTargetSince = -1;
  private burstLeft = 0;
  private holding = false;
  private pauseUntil = -1;
  private pressedLastTick = false;
  private lastTick = -1;

  reset(): void {
    this.onTargetSince = -1;
    this.burstLeft = 0;
    this.holding = false;
    this.pauseUntil = -1;
    this.pressedLastTick = false;
    this.lastTick = -1;
  }

  /** Cancels the current burst (target lost, switching, teammate on the line). */
  interrupt(): void {
    this.burstLeft = 0;
    this.holding = false;
    this.onTargetSince = -1;
  }

  get inBurst(): boolean {
    return this.holding;
  }

  /** In the pause after a burst (the bot may move). */
  pausing(tick: number): boolean {
    return tick < this.pauseUntil;
  }

  /** A shot left the barrel this tick. */
  onShot(tick: number, dt: number, fire: BotFireProfile, rng: BotRandom): void {
    if (this.burstLeft > 0) this.burstLeft--;
    if (this.burstLeft === 0 && this.holding) {
      this.holding = false;
      this.pauseUntil = tick + ticksFor(rng.span(fire.burstPauseSeconds), dt);
    }
  }

  /**
   * Whether to hold the fire button this tick. `errorDeg`/`toleranceDeg` come from the aim model; `ready` means the
   * weapon can shoot now (ready phase, cooldown elapsed, rounds loaded); `blocked` is a teammate on the line.
   */
  decide(
    tick: number,
    dt: number,
    mode: FireMode,
    distance: number,
    errorDeg: number,
    toleranceDeg: number,
    ready: boolean,
    blocked: boolean,
    aim: BotAimProfile,
    fire: BotFireProfile,
    rng: BotRandom,
  ): boolean {
    if (this.lastTick !== tick - 1) this.pressedLastTick = false;
    this.lastTick = tick;
    const onTarget = errorDeg === errorDeg && errorDeg <= toleranceDeg;
    if (onTarget) {
      if (this.onTargetSince < 0) this.onTargetSince = tick;
    } else if (!this.holding) {
      this.onTargetSince = -1;
    }

    let press = false;
    if (blocked) {
      this.interrupt();
    } else if (mode === "auto") {
      if (this.holding) {
        if (!(errorDeg <= toleranceDeg * BURST_TOLERANCE_SCALE) || !ready) {
          this.holding = false;
          this.burstLeft = 0;
          this.pauseUntil = tick + ticksFor(rng.span(fire.burstPauseSeconds), dt) * (ready ? 1 : 0);
        } else press = true;
      } else if (ready && onTarget && tick >= this.pauseUntil && tick - this.onTargetSince >= ticksFor(aim.firstShotDelaySeconds, dt)) {
        const band = distance < fire.closeMeters ? fire.burstClose : distance < fire.midMeters ? fire.burstMid : fire.burstLong;
        this.burstLeft = Math.max(1, rng.int(band));
        this.holding = true;
        press = true;
      }
    } else if (!this.pressedLastTick && ready && onTarget && tick >= this.pauseUntil && tick - this.onTargetSince >= ticksFor(aim.firstShotDelaySeconds, dt)) {
      if (!this.holding) {
        const band = distance < fire.closeMeters ? fire.burstClose : distance < fire.midMeters ? fire.burstMid : fire.burstLong;
        // Taps per burst for semi weapons; a bolt action takes one aimed shot at a time.
        this.burstLeft = mode === "bolt" ? 1 : Math.max(1, Math.min(6, rng.int(band)));
        this.holding = true;
      }
      press = true;
    }
    this.pressedLastTick = press;
    return press;
  }
}
