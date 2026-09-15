import type { Jwk } from "@twobullets/contracts/agent";
import type { MatchConfig, MatchMetrics, MatchPhase, MatchResult } from "@twobullets/contracts/match";

// Fleet allocation (ADR 0102, thin allocator). MVP providers: `LocalProcessAllocator` (one server-match child process
// per match on this host, speaking the agent IPC contract) and `FakeAllocator` (tests). Later: a remote host agent or
// Edgegap behind the same interface.

export type AllocationFailure = "noCapacity" | "timeout" | "crashed";

export class AllocationError extends Error {
  readonly reason: AllocationFailure;
  constructor(reason: AllocationFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface AllocatedMatch {
  readonly matchId: string;
  readonly hostId: string;
  /** Public WebSocket URL for this match. */
  readonly wsUrl: string;
}

export interface AllocatorListener {
  onPhase(matchId: string, phase: MatchPhase, freeSlots: number): void;
  onPlayer(matchId: string, accountId: string, event: "joined" | "left"): void;
  onMetrics(matchId: string, metrics: MatchMetrics): void;
  onResult(matchId: string, result: MatchResult): void;
  /** The process is gone (after a result, a drain, a crash or the hard cap). */
  onExit(matchId: string, code: number, reason: string): void;
}

export interface Allocator {
  setListener(listener: AllocatorListener): void;
  capacity(): { readonly used: number; readonly max: number };
  /** Resolves when the match process has acknowledged the config; rejects with AllocationError. */
  allocate(config: MatchConfig): Promise<AllocatedMatch>;
  /** Asks a running match to stop (drain); force-kills after a grace period. */
  release(matchId: string): void;
  /** JWKS rotation: every running match gets the new key set. */
  pushJwks(keys: readonly Jwk[]): void;
  shutdown(): Promise<void>;
}

/** In-memory allocator for tests and `TB_ALLOCATOR=fake` (UI work without Havok). */
export class FakeAllocator implements Allocator {
  readonly allocated: MatchConfig[] = [];
  readonly jwksPushes: (readonly Jwk[])[] = [];
  readonly released: string[] = [];
  failNext: AllocationFailure | null = null;
  max: number;
  private listener: AllocatorListener | null = null;
  private readonly running = new Set<string>();
  private readonly urlTemplate: string;

  constructor(options: { max?: number; urlTemplate?: string } = {}) {
    this.max = options.max ?? 4;
    this.urlTemplate = options.urlTemplate ?? "ws://fake.local/m/{matchId}";
  }

  setListener(listener: AllocatorListener): void {
    this.listener = listener;
  }

  capacity(): { used: number; max: number } {
    return { used: this.running.size, max: this.max };
  }

  async allocate(config: MatchConfig): Promise<AllocatedMatch> {
    if (this.failNext !== null) {
      const reason = this.failNext;
      this.failNext = null;
      throw new AllocationError(reason, `fake ${reason}`);
    }
    if (this.running.size >= this.max) throw new AllocationError("noCapacity", "fake allocator full");
    this.allocated.push(config);
    this.running.add(config.matchId);
    return { matchId: config.matchId, hostId: config.hostId, wsUrl: this.urlTemplate.replace("{matchId}", config.matchId).replace("{port}", "0") };
  }

  release(matchId: string): void {
    this.released.push(matchId);
    this.exit(matchId, 0, "released");
  }

  pushJwks(keys: readonly Jwk[]): void {
    this.jwksPushes.push(keys);
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.running]) this.exit(id, 0, "shutdown");
  }

  // Test drivers: what a match process would report.
  phase(matchId: string, phase: MatchPhase, freeSlots = 0): void {
    this.listener?.onPhase(matchId, phase, freeSlots);
  }
  player(matchId: string, accountId: string, event: "joined" | "left"): void {
    this.listener?.onPlayer(matchId, accountId, event);
  }
  result(result: MatchResult): void {
    this.listener?.onResult(result.matchId, result);
  }
  exit(matchId: string, code: number, reason = "exit"): void {
    if (!this.running.delete(matchId)) return;
    this.listener?.onExit(matchId, code, reason);
  }
}
