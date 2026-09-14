import type { Session } from "../transport/Session";
import type { Clock } from "./clock";
import type { LinkParams, NetworkProfile } from "./profiles";
import { createSeededRng, type Rng } from "./rng";

// In-process network impairment (netcode.md §11.3). Wraps one end of a connection and implements `Session`: sends go
// through the `up` link, receives through the `down` link. Latency + normal/Pareto jitter (FIFO unless a reorder
// event), Gilbert–Elliott burst loss, duplication, bandwidth bucket, MTU drop, scripted or periodic outages, and a
// TCP-like reliable mode for the WSS profile. Nothing moves until `pump()` runs at the clock's time.

export interface LinkStats {
  sent: number;
  delivered: number;
  lost: number;
  outageDrops: number;
  mtuDrops: number;
  bandwidthDrops: number;
  duplicated: number;
  reordered: number;
  retransmits: number;
}

function createStats(): LinkStats {
  return { sent: 0, delivered: 0, lost: 0, outageDrops: 0, mtuDrops: 0, bandwidthDrops: 0, duplicated: 0, reordered: 0, retransmits: 0 };
}

interface Pending {
  time: number;
  seq: number;
  up: boolean;
  stream: boolean;
  bytes: Uint8Array;
}

class Link {
  readonly stats = createStats();
  inFlightBytes = 0;
  private bad = false;
  private lastDatagramTime = 0;
  private lastStreamTime = 0;
  private tokens: number;
  private lastRefill = 0;
  private readonly pBadGivenGood: number;
  private readonly pGoodGivenBad: number;
  readonly params: LinkParams;
  private readonly rng: Rng;

  constructor(params: LinkParams, rng: Rng) {
    this.params = params;
    this.rng = rng;
    this.tokens = params.bandwidthBurstBytes ?? params.bandwidthBytesPerSec ?? 0;
    const burst = Math.max(1, params.burstLength ?? 1);
    const loss = Math.min(0.99, Math.max(0, params.lossRate));
    this.pGoodGivenBad = 1 / burst;
    this.pBadGivenGood = loss >= 1 ? 1 : (loss * this.pGoodGivenBad) / (1 - loss);
  }

  outageEnd(now: number): number {
    const p = this.params;
    if (p.outages) {
      for (const o of p.outages) if (now >= o.startMs && now < o.startMs + o.durationMs) return o.startMs + o.durationMs;
    }
    if (p.outagePeriodMs && p.outageDurationMs) {
      const phase = now % p.outagePeriodMs;
      const start = p.outagePeriodMs / 2;
      if (phase >= start && phase < start + p.outageDurationMs) return now - phase + start + p.outageDurationMs;
    }
    return -1;
  }

  /** Advances the Gilbert–Elliott chain; true = this packet is lost. */
  lossEvent(): boolean {
    if (this.params.lossRate <= 0) return false;
    this.bad = this.bad ? this.rng.next() >= this.pGoodGivenBad : this.rng.next() < this.pBadGivenGood;
    return this.bad;
  }

  takeBandwidth(now: number, bytes: number): boolean {
    const rate = this.params.bandwidthBytesPerSec;
    if (!rate) return true;
    const burst = this.params.bandwidthBurstBytes ?? rate;
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefill) / 1000) * rate);
    this.lastRefill = now;
    if (this.tokens < bytes) return false;
    this.tokens -= bytes;
    return true;
  }

  private jitter(): number {
    const sigma = this.params.jitterMs;
    if (sigma <= 0) return 0;
    if (this.params.jitterDistribution === "pareto") {
      // Pareto(α = 2.5) has σ ≈ 1.49·xm; shifted to start at 0.
      const xm = sigma / 1.49;
      let u = this.rng.next();
      if (u === 0) u = 1e-9;
      return xm * (Math.pow(u, -1 / 2.5) - 1);
    }
    return this.rng.normal() * sigma;
  }

  delay(now: number, stream: boolean): number {
    const p = this.params;
    let t = now + Math.max(0, p.latencyMs + this.jitter());
    if (stream) {
      t = Math.max(t, this.lastStreamTime);
      this.lastStreamTime = t;
      return t;
    }
    if (!p.reliable && p.reorderRate && this.rng.next() < p.reorderRate) {
      this.stats.reordered++;
      return t + 5 + (1 + 2 * this.rng.next()) * p.jitterMs;
    }
    t = Math.max(t, this.lastDatagramTime);
    this.lastDatagramTime = t;
    return t;
  }

  /** Reliable mode: a lost message is retransmitted later and holds back everything queued behind it. */
  retransmitDelay(): number {
    this.stats.retransmits++;
    return this.params.retransmitDelayMs ?? 2 * this.params.latencyMs + 20;
  }

  holdDatagramsUntil(t: number): void {
    if (t > this.lastDatagramTime) this.lastDatagramTime = t;
  }
}

export class LinkConditioner implements Session {
  readonly kind: Session["kind"];
  readonly maxDatagramSize: number;
  readonly up: Link;
  readonly down: Link;
  private readonly inner: Session;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly heap: Pending[] = [];
  private seq = 0;
  private closed = false;
  private readonly datagramCbs: ((bytes: Uint8Array, recvTimeMs: number) => void)[] = [];
  private readonly streamCbs: ((bytes: Uint8Array) => void)[] = [];

  constructor(inner: Session, profile: Pick<NetworkProfile, "up" | "down"> & { kind?: Session["kind"] }, clock: Clock, seed = 1) {
    this.inner = inner;
    this.clock = clock;
    this.rng = createSeededRng(seed);
    this.kind = profile.kind ?? inner.kind;
    this.maxDatagramSize = inner.maxDatagramSize;
    this.up = new Link(profile.up, this.rng);
    this.down = new Link(profile.down, this.rng);
    inner.onDatagram((bytes) => this.enqueue(this.down, false, false, bytes));
    inner.onStream((bytes) => this.enqueue(this.down, false, true, bytes));
  }

  get upStats(): LinkStats {
    return this.up.stats;
  }
  get downStats(): LinkStats {
    return this.down.stats;
  }

  sendDatagram(bytes: Uint8Array): boolean {
    if (this.closed) return false;
    const mtu = this.up.params.mtuBytes;
    if ((mtu !== undefined && bytes.length > mtu) || (this.maxDatagramSize > 0 && bytes.length > this.maxDatagramSize)) {
      this.up.stats.mtuDrops++;
      return false;
    }
    if (!this.up.takeBandwidth(this.clock.now(), bytes.length)) {
      this.up.stats.bandwidthDrops++;
      return false;
    }
    this.enqueue(this.up, true, false, bytes);
    return true;
  }

  sendStream(bytes: Uint8Array): void {
    if (!this.closed) this.enqueue(this.up, true, true, bytes);
  }

  onDatagram(cb: (bytes: Uint8Array, recvTimeMs: number) => void): void {
    this.datagramCbs.push(cb);
  }

  onStream(cb: (bytes: Uint8Array) => void): void {
    this.streamCbs.push(cb);
  }

  queuedBytes(): number {
    return this.up.inFlightBytes + this.inner.queuedBytes();
  }

  close(code: number): void {
    this.closed = true;
    this.inner.close(code);
  }

  /** Delivers everything due at the clock's current time, in time order. Returns the number delivered. */
  pump(): number {
    const now = this.clock.now();
    let n = 0;
    while (this.heap.length > 0 && this.heap[0]!.time <= now) {
      const e = this.pop();
      const link = e.up ? this.up : this.down;
      link.inFlightBytes -= e.bytes.length;
      link.stats.delivered++;
      n++;
      if (e.up) {
        if (e.stream) this.inner.sendStream(e.bytes);
        else this.inner.sendDatagram(e.bytes);
      } else if (!this.closed) {
        if (e.stream) for (const cb of this.streamCbs) cb(e.bytes);
        else for (const cb of this.datagramCbs) cb(e.bytes, now);
      }
    }
    return n;
  }

  /** Time of the next pending delivery, or Infinity. */
  nextDeliveryMs(): number {
    return this.heap.length > 0 ? this.heap[0]!.time : Infinity;
  }

  private enqueue(link: Link, up: boolean, stream: boolean, bytes: Uint8Array): void {
    const now = this.clock.now();
    link.stats.sent++;
    const outageEnd = link.outageEnd(now);
    const reliable = stream || link.params.reliable === true;
    if (outageEnd >= 0 && !reliable) {
      link.stats.outageDrops++;
      return;
    }
    const start = outageEnd >= 0 ? outageEnd : now;
    if (!reliable && link.lossEvent()) {
      link.stats.lost++;
      return;
    }
    let time = link.delay(start, stream);
    if (reliable && !stream && link.lossEvent()) {
      time += link.retransmitDelay();
      link.holdDatagramsUntil(time);
    }
    const copy = bytes.slice();
    this.push({ time, seq: this.seq++, up, stream, bytes: copy });
    link.inFlightBytes += copy.length;
    if (!reliable && link.params.duplicateRate && this.rng.next() < link.params.duplicateRate) {
      link.stats.duplicated++;
      link.inFlightBytes += copy.length;
      this.push({ time: time + this.rng.next() * 5, seq: this.seq++, up, stream, bytes: copy });
    }
  }

  private push(e: Pending): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  private pop(): Pending {
    const h = this.heap;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}

function less(a: Pending, b: Pending): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

/** Pumps several conditioners (e.g. every bot's link) at the shared clock time. */
export function pumpAll(links: readonly LinkConditioner[]): number {
  let n = 0;
  for (const l of links) n += l.pump();
  return n;
}
