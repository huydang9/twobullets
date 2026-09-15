import type { JwksResponse } from "@twobullets/contracts/rest";
import { DisconnectReason } from "@twobullets/protocol";
import { afterEach, describe, expect, it } from "vitest";
// The real verifier server-match runs at Hello (not a copy): the tokens this API issues must pass it.
import { ed25519KeyFromJwk, JoinTokenVerifier } from "../../server-match/src/auth/joinToken";
import { KeyRing } from "../src/auth/keyRing";
import { startTestApi, type TestApi } from "./helpers";

let api: TestApi;
afterEach(async () => api?.close());

function matchVerifier(jwks: JwksResponse, nowMs: () => number): JoinTokenVerifier {
  return new JoinTokenVerifier({ keys: jwks.keys.map((k) => ed25519KeyFromJwk(k)), nowSec: () => nowMs() / 1000 });
}

describe("join tokens accepted by server-match's verifier", () => {
  it("verifies an API-issued join token against the served JWKS, once, with the right claims", async () => {
    api = await startTestApi();
    const host = await api.guest("Host");
    const lobby = (await api.call("POST", "/v1/lobbies", { token: host.accessToken, body: { mode: "duo", maxPlayers: 4 } })).body.lobby;
    const matchId = (await api.call("POST", `/v1/lobbies/${lobby.code}/start`, { token: host.accessToken })).body.lobby.matchId;
    const join = (await api.call("POST", `/v1/matches/${matchId}/join`, { token: host.accessToken })).body;

    const jwks = (await api.call<JwksResponse>("GET", "/.well-known/jwks.json")).body;
    const verifier = matchVerifier(jwks, () => api.clock.now);
    const result = verifier.verify(join.joinToken);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toMatchObject({ aud: "match", sub: host.account.id, mid: matchId, hid: "sg-test", team: 0, epoch: 0, rc: false, iss: "https://play.test" });
    expect(verifier.verify(join.joinToken)).toMatchObject({ ok: false, detail: "jti reused" });
    // The same JWKS pushed over agent IPC works identically.
    expect(api.allocator.allocated[0]!.hostId).toBe("sg-test");
  });

  it("rejects access tokens, expired join tokens and tokens from a pruned key", async () => {
    api = await startTestApi();
    const auth = await api.guest("Player");
    const verifier = matchVerifier(api.keys.jwks(), () => api.clock.now);
    expect(verifier.verify(auth.accessToken)).toMatchObject({ ok: false, reason: DisconnectReason.badToken, detail: "claims" });

    const t = api.app.tokens.issueJoin({ accountId: auth.account.id, matchId: "m1", hostId: "sg-test", teamId: 1, epoch: 0, reconnect: false });
    const late = matchVerifier(api.keys.jwks(), () => api.clock.now + 130_000);
    expect(late.verify(t.token)).toMatchObject({ ok: false, detail: "expired" });

    // Rotation: a token signed before rotate still verifies with the rotated JWKS; after prune it doesn't.
    const ring = new KeyRing(api.keys.toFile());
    ring.rotate(api.clock.now);
    api.app.reloadKeys(ring.toFile());
    const oldToken = t.token;
    const newToken = api.app.tokens.issueJoin({ accountId: auth.account.id, matchId: "m1", hostId: "sg-test", teamId: 1, epoch: 1, reconnect: true }).token;
    const pushed = api.allocator.jwksPushes.at(-1)!;
    const rotated = new JoinTokenVerifier({ keys: pushed.map((k) => ed25519KeyFromJwk(k)), nowSec: () => api.clock.now / 1000 });
    expect(rotated.verify(oldToken).ok).toBe(true);
    expect(rotated.verify(newToken).ok).toBe(true);

    ring.prune(0, api.clock.now + 1);
    api.app.reloadKeys(ring.toFile());
    const pruned = new JoinTokenVerifier({ keys: api.allocator.jwksPushes.at(-1)!.map((k) => ed25519KeyFromJwk(k)), nowSec: () => api.clock.now / 1000 });
    const again = api.app.tokens.issueJoin({ accountId: auth.account.id, matchId: "m1", hostId: "sg-test", teamId: 1, epoch: 0, reconnect: false });
    expect(pruned.verify(oldToken)).toMatchObject({ ok: false, detail: "unknown kid" });
    expect(pruned.verify(again.token).ok).toBe(true);
  });
});
