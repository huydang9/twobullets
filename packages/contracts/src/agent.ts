import type { MatchConfig, MatchMetrics, MatchPhase, MatchResult } from "./match";

// Host agent ↔ match process IPC (platform.md A8, architecture.md §2.3).

/** Ed25519 public key in JWKS form. */
export interface Jwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly kid: string;
  readonly alg?: "EdDSA";
  readonly use?: "sig";
}

export type AgentToMatch =
  | { t: "allocate"; config: MatchConfig }
  | { t: "drain" }
  | { t: "jwks"; keys: Jwk[] }
  | { t: "cert"; pem: string };

export type MatchToAgent =
  | { t: "ready"; udpPort: number; wsPort: number; certHash?: string }
  | { t: "phase"; phase: MatchPhase; freeSlots: number }
  | { t: "player"; accountId: string; event: "joined" | "left" }
  | { t: "metrics"; m: MatchMetrics }
  | { t: "result"; summary: MatchResult; files: string[] }
  | { t: "exit"; code: number };
