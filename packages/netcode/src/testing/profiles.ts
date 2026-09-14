// Network profiles (netcode.md §11.3, architecture.md §6.4). RTT is split evenly into up and down latency; jitter σ
// and loss apply per direction. "Bursty" loss uses a Gilbert–Elliott chain with a mean burst of 3 packets.

export interface Outage {
  readonly startMs: number;
  readonly durationMs: number;
}

export interface LinkParams {
  /** One-way base latency, ms. */
  readonly latencyMs: number;
  /** One-way jitter σ, ms. */
  readonly jitterMs: number;
  readonly jitterDistribution?: "normal" | "pareto";
  /** Long-run loss probability per datagram. */
  readonly lossRate: number;
  /** Mean loss burst length in packets (1 = independent losses). */
  readonly burstLength?: number;
  readonly duplicateRate?: number;
  /** Probability a datagram skips FIFO order and is held back an extra 1–3 jitter σ (+ 5 ms). */
  readonly reorderRate?: number;
  /** Token bucket; datagrams over budget are refused (sendDatagram → false). */
  readonly bandwidthBytesPerSec?: number;
  readonly bandwidthBurstBytes?: number;
  /** Datagrams larger than this are dropped. */
  readonly mtuBytes?: number;
  /** Scripted outages, ms on the conditioner's clock. */
  readonly outages?: readonly Outage[];
  /** Repeating outage: `outageDurationMs` of silence every `outagePeriodMs`, halfway through each period. */
  readonly outagePeriodMs?: number;
  readonly outageDurationMs?: number;
  /** TCP-like datagrams (WSS fallback): nothing is lost, a loss event delays that message and all later ones. */
  readonly reliable?: boolean;
  /** Extra delay of a retransmitted message, ms (default 2 × latency + 20 ms, ≈ one RTT plus reordering window). */
  readonly retransmitDelayMs?: number;
}

export interface NetworkProfile {
  readonly name: string;
  readonly kind: "webtransport" | "websocket";
  readonly up: LinkParams;
  readonly down: LinkParams;
}

function symmetric(name: string, kind: NetworkProfile["kind"], link: LinkParams): NetworkProfile {
  return { name, kind, up: link, down: link };
}

export const NETWORK_PROFILES = {
  lan: symmetric("lan", "webtransport", { latencyMs: 0.5, jitterMs: 0, lossRate: 0 }),
  good: symmetric("good", "webtransport", { latencyMs: 15, jitterMs: 2, lossRate: 0.001 }),
  typical: symmetric("typical", "webtransport", { latencyMs: 30, jitterMs: 8, lossRate: 0.01, burstLength: 3 }),
  bad: symmetric("bad", "webtransport", { latencyMs: 60, jitterMs: 25, lossRate: 0.03, burstLength: 3, reorderRate: 0.005 }),
  awful: symmetric("awful", "webtransport", {
    latencyMs: 125,
    jitterMs: 50,
    lossRate: 0.08,
    burstLength: 3,
    outagePeriodMs: 300_000,
    outageDurationMs: 2000,
  }),
  "tcp-fallback": symmetric("tcp-fallback", "websocket", { latencyMs: 30, jitterMs: 8, lossRate: 0.01, reliable: true }),
} as const satisfies Record<string, NetworkProfile>;

export type NetworkProfileName = keyof typeof NETWORK_PROFILES;
