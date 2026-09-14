# ADR 0002: Match endpoints: WSS on TCP 443 from Phase 1, WebTransport on per-process UDP ports until a sidecar owns UDP 443, one build-compat key end to end

- Status: Accepted
- Date: 2026-09-14
- Owner: Principal Architect
- Supersedes: [ADR 0105](0105-game-server-tls-and-endpoints.md). Its TLS decisions are carried forward unchanged in §2 below; its port and fallback plan is replaced.
- Amends: ADR 0106 (adds a `ch` claim), ADR 0203 item 6 (when the transport decision is taken), ADR 0204 item 6 (where the compat key is enforced).
- Related: [platform.md §4.3–4.4, §6.7](../platform.md#44-tls-for-game-servers), [netcode.md §6.8, §7](../netcode.md#7-transport), [runtime-performance.md §3.5, §7](../runtime-performance.md#35-keeping-io-off-the-simulation-thread-and-backpressure)

## Context

- **Platform** planned per-process UDP 40000–40999 (WebTransport) and TCP 41000–41999 (WSS), with a host-level TCP 443 proxy only "if telemetry shows the need" (ADR 0105, platform.md §4.3).
- **Netcode** recommends UDP 443 + TCP 443 per host, because corporate, campus and net-café networks block high ports. That needs a per-host QUIC router (sidecar), since only one process can own UDP 443 and `SO_REUSEPORT` can't route by match (ADR 0203 item 6, netcode.md §13.1 A7).
- **The fallback's purpose:** WSS exists for networks that block UDP. Serving it on a high TCP port defeats that purpose on exactly those networks.
- **Server library:** `@fails-components/webtransport` is the only in-process Node server option and calls itself "duct tape-style" (netcode.md §7.1). Its maturity decides whether a sidecar is needed.
- **Compatibility key:** Netcode requires an exact `(PROTOCOL_VERSION, contentHash)` match per match (netcode.md §6.8). Platform tickets and join tokens carry only `protocolVersion` (platform.md §2.1, ADR 0106).
- **Babylon version pins:** `@babylonjs/core` and `@babylonjs/havok` use caret ranges in `apps/client/package.json` and `packages/shared/package.json`. The character-controller solver is JS inside Babylon, so a minor version bump can change prediction results.

## Decision

### 1. Ports and routing

| Phase | Owned hosts (OVH) | Burst hosts (Edgegap) |
|---|---|---|
| Phase 0 (M3, local/LAN) | WT: per-process UDP 40000–40999. WSS: per-process TLS on TCP 41000–41999. Plain WS on localhost. The M3 staging host already runs the Phase 1 layout below. | — |
| **Phase 1 onward (M4+)** | WT: per-process UDP 40000–40999 (in-process Node binding). **WSS: TCP 443 on the host**, terminated by **HAProxy** (L7, wildcard cert). HAProxy routes `/m/{matchId}` to `127.0.0.1:{port}` through a map the agent updates via the runtime API. Match processes serve plain WS on loopback, so they do no TLS for WSS. | WT on a provider-mapped UDP port with `serverCertificateHashes`. WSS via Edgegap TLS Upgrade. |
| **After the sidecar trigger** (§4) | A per-host QUIC sidecar owns **UDP 443**. It routes WebTransport CONNECT `:path` `/m/{matchId}`, then connection IDs, to match processes over Unix sockets. The sidecar may also take over TCP 443 and retire HAProxy. | Unchanged |

- **Beacons** (`ping-{region}.tbgs.net`, on a separate IP) answer HTTPS on TCP 443 and WebTransport datagram echo on **both** UDP 443 and a UDP high port. The client reports which of these work. The result feeds:
  - WSS pre-selection;
  - allocator placement (step 5);
  - the sidecar trigger (the share of players for whom UDP 443 works but high ports don't).
- The host firewall allows TCP 443, UDP 443 (reserved for the sidecar), UDP 40000–40999 and WireGuard. It does not allow TCP 41000–41999 from Phase 1 on.

### 2. TLS (carried forward from ADR 0105)

- Game infrastructure lives on a separate registrable domain (placeholder `tbgs.net`). Owned hosts use a Let's Encrypt **wildcard `*.tbgs.net`** via DNS-01.
  - The fleet role issues it and renews every 20 days, alerting at < 14 days.
  - Agents pull it and hot-reload HAProxy and match processes.
- Burst hosts use an ephemeral **ECDSA P-256** certificate valid for ≤ 10 days. Its SHA-256 is returned in `match.found` as `certHashes`.
- Let's Encrypt IP certificates stay in reserve. Local dev uses a self-signed certificate + hashes (Chrome) and plain WS.

### 3. Connection policy (client; unchanged from ADR 0203 item 4 except ports)

1. WebTransport CONNECT with a 3 s timeout.
2. Datagram echo check (10 pings in 1 s).
3. Otherwise WSS on `wss://{host}.tbgs.net/m/{matchId}` (port 443).

The fallback reason goes to telemetry. The per-network choice is remembered for 24 h.

### 4. Transport implementation gate (tightens ADR 0203 item 6)

- M3 builds `ws` (WSS) and `@fails-components/webtransport` (WT) behind the `Session` interface (netcode.md §7.2).
- The **M3 exit** includes a **Linux transport soak** on the staging Advance-1: 30 matches × 10 headless bots, 1 h, bots on a second box. It fails if any of these holds:
  - process crash or leak (> 10% RSS growth per hour);
  - datagram loss > 0.5% on a clean link;
  - `sendDatagram` p99 > 1 ms;
  - transport CPU > 1 ms per match-tick p99;
  - any browser interop failure (Chrome, Edge, Firefox, Safari 26.4+).
- **On failure,** a Rust sidecar (`web-transport-quinn` first; Go `webtransport-go` only if quinn fails browser interop) becomes an M4 workstream. M4 exit is then unaffected, because WSS on 443 carries playtests.
- **On pass,** the sidecar is deferred. It is re-triggered by any of:
  - beacon data showing ≥ 2% of players with UDP 443 working and UDP high ports blocked;
  - the packed process model (ADR 0004);
  - library regressions.

### 5. Placement rules

- The allocator prefers **owned hosts** for tickets whose beacon probe reports blocked UDP high ports, and for Firefox and Safari clients (certificate-hash support is uneven, netcode.md §7.1).
- Burst hosts receive these tickets only when owned capacity is exhausted. Their players are expected to fall back to WSS.

### 6. One build-compatibility key

- `compat = (PROTOCOL_VERSION u16, contentHash u32)`.
- `contentHash` covers the gameplay tuning tables, the hitbox table and rig fit (ADR 0003), `lootTableVersion`, **and the exact `@babylonjs/core` and `@babylonjs/havok` versions**.
  - Those two packages are pinned to **exact** versions in every workspace package that runs simulation.
- Where the key is carried and checked:
  - it is sent in `version.json` and in matchmaking tickets;
  - `server_builds` registers the compat keys each build supports (exactly one);
  - the allocator pins it;
  - the join JWT carries **`pv` and `ch`** claims;
  - `Hello` carries both, and the server rejects a mismatch with `Disconnect{versionMismatch}`.
- The API answers a ticket with an unsupported key with `426`.

### 7. Admission and resume ladder

- `Hello{protocolVersion, contentHash, joinToken, maxDatagramSize, transport}` must be the first control message, within 3 s.
- The server verifies the Ed25519 JWT offline (ADR 0106), including `ch`.
- Reconnect has three layers:
  1. QUIC connection migration for blips ≤ 5 s;
  2. `resumeToken` (HMAC under a per-process secret, single use, ≤ 10 s; netcode.md §7.4), which needs no API call;
  3. join-token re-issue within the 60 s grace (ADR 0106).
- The per-process secret can mint resumes only for its own match. This doesn't reintroduce the minting-secret problem ADR 0106 rejected HS256 for.
- **M3 dev tokens** are Ed25519 JWTs signed by a local dev key, so the verification path is the production path from day one.

## Consequences

- Restrictive networks can always reach the fallback, from the first closed playtest.
- HAProxy is one more component per host: config generated by the agent, health-checked, restarted by systemd.
  - A HAProxy crash drops only WSS sessions, which resume through step 7.
  - Loopback proxying adds < 0.1 ms.
  - Match processes save TLS CPU on WSS.
- The sidecar decision is data-driven and made by M3 exit instead of the end of M4, so it doesn't collide with the hit-registration work.
- The exact-pin rule turns a Babylon upgrade into a coordinated client + server release with a new `contentHash`, which is intended.

## Alternatives considered

- **High ports for WSS until telemetry complains (ADR 0105).** The telemetry would come from players who already failed to connect, often without reaching the telemetry endpoint. Rejected.
- **Rust sidecar on UDP/TCP 443 from M3.** Adds a second language and a routing layer before the Node binding has even been tested. Rejected for now; pre-scoped with a trigger.
- **SNI-based routing per match.** The wildcard certificate covers one label, and DNS can't wildcard to different hosts. Rejected.
- **Central QUIC proxy.** Adds a hop and a single point of failure (ADR 0105/0203). Rejected.
- **`protocolVersion` only.** A tuning change without a wire change would silently break prediction. Rejected.
