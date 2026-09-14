# ADR 0106: Short-lived Ed25519 join tokens, verified offline, with reconnect by token re-issue

- Status: Proposed
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §3.3, §6.7](../platform.md#33-reconnects-leaving-and-afk), ADR 0105

## Context

Match servers must admit only players the matchmaker assigned, to the right team, on the right build, without calling the database on every connection. Players reload tabs and lose Wi-Fi mid-match, so they must be able to reconnect within a grace period. Tokens can leak through logs, screenshots or malicious extensions.

## Decision

- `server-api` signs a **join JWT** with **EdDSA (Ed25519)**:

  ```jsonc
  {
    "iss": "https://api.twobullets.gg",
    "aud": "match",
    "sub": "<accountId>",
    "mid": "<matchId>",
    "hid": "<hostId or allocationId>",
    "team": 3,
    "pv": 7,                 // protocol version
    "epoch": 1,              // increments on each re-issue for this (sub, mid)
    "rc": false,             // true when issued for a reconnect
    "jti": "<random 128-bit>",
    "iat": 1789000000,
    "exp": 1789000120        // 120 s TTL
  }
  ```

  The header carries `kid`.
- **Match servers verify offline.**
  - Signature against JWKS, fetched at boot and cached for 1 h, with refresh on unknown `kid`.
  - `aud`, `exp` (±5 s skew), `mid` equals its own match, `hid` equals its own host, and `pv` is supported.
  - `jti` is unseen; the server keeps a per-match set.
  - `epoch` is greater than the last accepted epoch for `sub`. A newer epoch closes the older connection.
- The token is sent **only in the first transport message** (`hello`), never in a URL, so it doesn't end up in proxy logs.
- **Reconnect:** the client calls `GET /v1/me/active-match`. The API checks Redis `active:{accountId}` and the match phase, then issues a new token with `rc=true` and `epoch+1`. The grace period is 15 s in warmup and 60 s from landing onward.
- **Key management:** the private key exists only in API runtime secrets. Rotate every 90 days, publishing the new `kid` 24 h before signing with it. On compromise, publish a JWKS without the old `kid`; match servers refresh within 1 h, or immediately on the fleet's `refreshJwks` broadcast.

## Consequences

- There is no database or Redis dependency on the join hot path, so match servers keep admitting players during a control-plane blip, provided tokens were already issued.
- A stolen token is useful for at most 120 s, only for one match on one host. Its `jti` is single-use, and a later epoch evicts it.
- Clock skew between API and hosts must be under 5 s (NTP on all hosts, which is standard).
- A reconnect needs the API to be reachable. If the API is down, transport-level resume (Netcode) is the only path; that is an open question.

## Alternatives considered

- **Opaque ticket checked against Redis by the match server.** Couples every join to Redis availability and exposes a control-plane dependency on game hosts.
- **HMAC (HS256) shared secret.** Every game host, including third-party burst hosts, would hold a secret that can mint tokens. Rejected.
- **Long-lived session tokens.** A larger replay window. Rejected.
