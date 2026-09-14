import { DilatedTickClock, TimeDilation } from "@twobullets/netcode/timeDilation";
import { SIMULATION } from "@twobullets/shared/constants";
import type { TickClock } from "@twobullets/shared/tickClock";

/** WSS head-of-line stalls need a deeper input buffer than WebTransport (netcode integration test: 3 vs 1). */
export const WS_BUFFER_TICKS = 3;
export const WT_BUFFER_TICKS = 1;

/**
 * Networked `TickClock` (R4): netcode's dilated accumulator, stretched ±5% by `TimeDilation` from the server's input
 * buffer depth. Returns no ticks until `start`; carries the backlog past `maxTicksPerFrame` instead of dropping ticks
 * (NetClient gives back short hitches the frame's dt cap dropped via `catchUp`, and hard-resyncs when the clock drifts
 * more than 10 ticks from the target).
 */
export class NetClock implements TickClock {
  readonly dilation: TimeDilation;
  private readonly core: DilatedTickClock;
  private running = false;
  private backlog = 0;
  /** Frame time already covered by the tick passed to `start`/`resync`, dropped from the next `advance`. */
  private discardMs = 0;

  constructor(options: { readonly bufferTicks?: number; readonly tickRate?: number } = {}) {
    this.dilation = new TimeDilation({ targetTicks: options.bufferTicks ?? WS_BUFFER_TICKS });
    this.core = new DilatedTickClock(options.tickRate ?? SIMULATION.tickRate);
  }

  get started(): boolean {
    return this.running;
  }

  /** The tick the clock stands at once its backlog is simulated. */
  get currentTick(): number {
    return this.core.tick + this.backlog;
  }

  get backlogTicks(): number {
    return this.backlog;
  }

  /**
   * `tick` is where the clock stands now. Called before this frame's `advance` (NetClient.update runs before the
   * player's), pass that frame's `frameSeconds` as `elapsedSeconds`: it already passed, so it mustn't add ticks on top.
   */
  start(tick: number, elapsedSeconds = 0): void {
    this.core.start(tick);
    this.backlog = 0;
    this.discardMs = elapsedSeconds * 1000;
    this.running = true;
  }

  /** Hard resync: re-align the tick number and forget the dilation controller's history. */
  resync(tick: number, elapsedSeconds = 0): void {
    this.start(tick, elapsedSeconds);
    this.dilation.reset();
  }

  stop(): void {
    this.running = false;
    this.backlog = 0;
    this.discardMs = 0;
  }

  advance(frameSeconds: number): number {
    if (!this.running) return 0;
    let ms = frameSeconds * 1000;
    if (this.discardMs > 0) {
      const d = ms < this.discardMs ? ms : this.discardMs;
      ms -= d;
      this.discardMs = 0;
    }
    this.backlog += this.core.advance(ms, this.dilation.tickScale);
    const n = this.backlog < SIMULATION.maxTicksPerFrame ? this.backlog : SIMULATION.maxTicksPerFrame;
    this.backlog -= n;
    return n;
  }

  /** Adds wall time the frame's capped `dt` left out (a short hitch): due ticks join the backlog. */
  catchUp(seconds: number): void {
    if (this.running && seconds > 0) this.backlog += this.core.advance(seconds * 1000, this.dilation.tickScale);
  }

  nextTick(): number {
    const tick = this.core.tick;
    this.core.tick = tick + 1;
    return tick;
  }

  get alpha(): number {
    if (!this.running) return 1;
    if (this.backlog > 0) return 1;
    const a = this.core.alpha(this.dilation.tickScale);
    return a < 1 ? a : 1;
  }
}
