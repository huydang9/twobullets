# ADR 0203: WebTransport primary, WSS fallback, no WebRTC; transport behind an interface

- Status: Proposed
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §7](../netcode.md#7-transport), Platform ADR 0105 (TLS), ADR 0106 (join tokens), Platform Q1/Q4/Q10

## Context

- Snapshots and inputs need **unreliable, unordered** delivery. TCP head-of-line blocking turns a single lost segment into a burst of stale snapshots.
- **Browser support, September 2026:** WebTransport is available in Chrome 97+, Edge 98+, Firefox 114+ and **Safari 26.4+ (March 2026)**, with datagrams and streams — Baseline, ~91% global support ([caniuse](https://caniuse.com/webtransport), [WebKit](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)).
- `serverCertificateHashes` works in Chrome; Firefox's behavior differs from the spec ([bug 1873263](https://bugzilla.mozilla.org/1873263)).
- **Servers:**
  - **Node:** `@fails-components/webtransport` (libquiche binding) describes itself as "duct tape-style" until Node ships native support, and some datagram options are unimplemented. `node:quic` is experimental with no WebTransport ([repo](https://github.com/fails-components/webtransport), [Node](https://github.com/nodejs/node/blob/main/doc/api/quic.md)).
  - **Rust:** `wtransport` 0.7 (not fully production-ready per its docs) and `web-transport-quinn`.
  - **Go:** `webtransport-go` (draft-16, active).
- **Networks:** UDP/443 is fully blocked on an estimated 3–5% of public networks, and more on corporate networks.
- **WebRTC DataChannels** offer unreliable delivery everywhere, but need signaling, ICE, TURN relays for UDP-blocked users, and SCTP/DTLS overhead.

## Decision

1. **Primary: WebTransport.** One session per match: one bidirectional control stream (tier S) + datagrams (tiers U and R, netcode.md §6.2).
2. **Fallback: WSS** with the same message IDs and codecs. Datagram-class messages become WS binary messages; the server drops stale snapshots instead of queueing. On WSS the client uses a 50 ms interpolation floor and 30 Hz snapshots if TCP retransmits exceed 1%.
3. **No WebRTC.**
4. **Connection policy:**
   - WebTransport with a 3 s timeout.
   - Then a **datagram echo check** (10 pings in 1 s).
   - Then WSS, with the reason reported.
   - The per-network choice is remembered for 24 h.
   - Region beacons also try a datagram echo so UDP blocking is known before queueing.
5. **Transport interface** (`Session`: `sendDatagram`, `sendStream`, `onDatagram`, `onStream`, `maxDatagramSize`, `close`), so the implementation can change without touching netcode.
6. **Implementation path:** M3 uses the Node binding in-process. If the M4 soak test (≈ 300 sessions / 36k datagrams per second per host) shows instability or > 1 ms p99 send latency, terminate QUIC in a **Rust sidecar per host on UDP 443**, forwarding to match processes over Unix sockets. Runtime decides the final runtime.
7. **Resume:** QUIC rides out ≤ 5 s blips and NAT rebinding (non-zero connection IDs, 10 s idle timeout). A lost session reconnects with a 10 s single-use `resumeToken` from `Welcome`; after that, Platform's join-token reconnect (ADR 0106).
8. Snapshot payloads are capped at min(1,000 B, client-reported `maxDatagramSize`).

## Consequences

- Most players get UDP-like delivery. Blocked networks still play, with a visible "TCP" indicator and slightly worse feel.
- Burst hosts that rely on certificate hashes will push more Firefox players to WSS. Track fallback rate by browser and host type.
- A server library risk remains until the M4 soak test; the sidecar plan bounds it.
- Platform should prefer UDP 443 / TCP 443 per host over high port ranges for firewall reach.

## Alternatives considered

- **WSS only.** Simplest, universally reachable, but loss causes stalls and bursts. Rejected as primary.
- **WebRTC DataChannel primary.** Complexity (signaling, TURN) for no remaining browser-coverage gain. Rejected.
- **WebTransport only.** Leaves 3–5%+ of networks unable to play. Rejected.
- **Central QUIC proxy / CDN.** Adds a hop and a single point of failure; datagram support in proxies is uneven. Rejected (matches Platform ADR 0105).
