/** Injectable time source (ms). Real code passes `{ now: () => performance.now() }`. */
export interface Clock {
  now(): number;
}

/** Virtual clock for tests and the in-process harness: time only moves when told to. */
export class ManualClock implements Clock {
  private t: number;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
