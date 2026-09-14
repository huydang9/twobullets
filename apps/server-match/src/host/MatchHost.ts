import type { JoinClaims, MatchConfig, MatchPhase } from "@twobullets/contracts";
import type { Session } from "@twobullets/netcode";
import type { DisconnectReason } from "@twobullets/protocol";

// Match process model (ADR 0004): single-match by default, packed workers behind the same interface.

export interface MatchHost {
  createMatch(config: MatchConfig): Match;
  /** One scheduler over all matches (ADR 0304). */
  start(): void;
  drain(): Promise<void>;
}

export interface Match {
  readonly id: string;
  readonly phase: MatchPhase;
  /** Claims are already verified (signature, aud, exp, mid, hid, pv/ch, jti) by the SessionManager. */
  attach(session: Session, claims: JoinClaims): AttachResult;
  /** Never awaits. */
  tick(tick: number): void;
}

export type AttachResult =
  | { readonly ok: true; readonly slot: number; readonly teamId: number; readonly resumed: boolean }
  | { readonly ok: false; readonly reason: DisconnectReason };
