import { clampViewDelayTicks, MAX_REWIND_TICKS } from "@twobullets/netcode";

// Server expectation of a shooter's view delay D (netcode.md §5.2): D = T − R, the input tick minus the fractional tick
// the client rendered remote players at. Seen from the server that is
//   (input tick − server tick when the input arrived) + RTT / Δ + interpolation delay / Δ,
// where RTT is measured without trusting client clocks: input arrival − send time of the snapshot the packet acks.
// Both terms are smoothed; the client's claim is then clamped to expected ± VIEW_DELAY_SLACK_TICKS and MAX_REWIND.

const LEAD_ALPHA = 0.1;
const RTT_ALPHA = 0.1;
/** netcode.md §5.2: clientReportedInterpDelay is clamped to [25, 150] ms. */
export const INTERP_DELAY_MIN_MS = 25;
export const INTERP_DELAY_MAX_MS = 150;
/** Acks older than this don't produce RTT samples (a stale or replayed ack). */
const MAX_RTT_SAMPLE_MS = 1000;

export interface ViewDelayStats {
  /** Shots whose claimed D differed from the clamped D (backtrack telemetry). */
  clamps: number;
  shots: number;
}

export class ViewDelayEstimator {
  readonly tickMs: number;
  readonly stats: ViewDelayStats = { clamps: 0, shots: 0 };
  /** Smoothed input lead in ticks; NaN before the first packet. */
  leadTicks = NaN;
  /** Smoothed RTT, ms; NaN before the first sample. */
  rttMs = NaN;
  interpDelayMs = 100;
  private lastAckTick = -1;

  constructor(tickRate = 60) {
    this.tickMs = 1000 / tickRate;
  }

  reset(): void {
    this.leadTicks = NaN;
    this.rttMs = NaN;
    this.interpDelayMs = 100;
    this.lastAckTick = -1;
  }

  /**
   * Per input packet. `arrivalTick` is the fractional server tick at receipt; `ackSentMs` the send time of the snapshot
   * the packet acks (NaN when unknown).
   */
  onInputPacket(newestTick: number, arrivalTick: number, interpDelayMs: number, ackTick: number, ackSentMs: number, recvMs: number): void {
    const lead = newestTick - arrivalTick;
    this.leadTicks = this.leadTicks === this.leadTicks ? this.leadTicks + LEAD_ALPHA * (lead - this.leadTicks) : lead;
    this.interpDelayMs = interpDelayMs < INTERP_DELAY_MIN_MS ? INTERP_DELAY_MIN_MS : interpDelayMs > INTERP_DELAY_MAX_MS ? INTERP_DELAY_MAX_MS : interpDelayMs;
    if (ackTick > this.lastAckTick && ackSentMs === ackSentMs) {
      this.lastAckTick = ackTick;
      const sample = recvMs - ackSentMs;
      if (sample >= 0 && sample <= MAX_RTT_SAMPLE_MS) this.rttMs = this.rttMs === this.rttMs ? this.rttMs + RTT_ALPHA * (sample - this.rttMs) : sample;
    }
  }

  /** Expected D in ticks (0 before any measurement). */
  get expectedTicks(): number {
    const lead = this.leadTicks === this.leadTicks ? this.leadTicks : 0;
    const rtt = this.rttMs === this.rttMs ? this.rttMs : 0;
    const d = lead + (rtt + this.interpDelayMs) / this.tickMs;
    return d > 0 ? d : 0;
  }

  /** Validated D for a shot fired with `viewOffset8` (1/8 tick); counts clamps. */
  validate(viewOffset8: number, maxRewindTicks = MAX_REWIND_TICKS): number {
    const claimed = viewOffset8 / 8;
    const d = clampViewDelayTicks(claimed, this.expectedTicks, maxRewindTicks);
    this.stats.shots++;
    if (Math.abs(d - claimed) > 1e-9) this.stats.clamps++;
    return d;
  }
}
