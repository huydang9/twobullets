import type { JoinMatchResponse } from "@twobullets/contracts/rest";

/** Same shape as `net/handshake.ts` `DevToken`, which the handshake's token provider returns. */
export interface IssuedJoinToken {
  readonly token: string;
  readonly matchId: string;
  readonly url: string;
  readonly expiresAt: number;
}

/** Don't reuse a token with less than this left (the Hello round trip must fit). */
const REUSE_MARGIN_MS = 10_000;

/**
 * Join tokens from server-api for one match: the token the connecting screen already fetched serves the first
 * connect, every later connect (a rejoin) asks `POST /v1/matches/{id}/join` for a fresh single-use one.
 */
export function createApiJoinTokenProvider(
  api: { joinMatch(matchId: string): Promise<JoinMatchResponse> },
  first: JoinMatchResponse,
  now: () => number = Date.now,
): () => Promise<IssuedJoinToken> {
  let unused: JoinMatchResponse | null = first;
  return async () => {
    const reuse = unused !== null && unused.expiresAt - now() > REUSE_MARGIN_MS ? unused : null;
    unused = null;
    const join = reuse ?? (await api.joinMatch(first.matchId));
    return { token: join.joinToken, matchId: join.matchId, url: join.wsUrl, expiresAt: join.expiresAt };
  };
}
