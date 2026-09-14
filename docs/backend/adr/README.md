# Backend Architecture Decision Records

Entry point: [../architecture.md](../architecture.md). This index lists every backend ADR, its status after the Principal Architect's merge (2026-09-14), and where each one is amended.

## Numbering scheme

| Range | Area | Author role | Main document |
|---|---|---|---|
| **00xx** | Cross-cutting principal decisions. They resolve conflicts between areas and **take precedence** over any 01xx–03xx ADR they supersede or amend. | Principal Architect | [architecture.md](../architecture.md) |
| **01xx** | Platform & infrastructure: control plane, matchmaking, hosting, TLS, identity, data | Platform & Infrastructure Architect | [platform.md](../platform.md) |
| **02xx** | Netcode: authority, rates, protocol, transport, lag compensation, hitboxes, relevance | Netcode Architect | [netcode.md](../netcode.md) |
| **03xx** | Match-server runtime & performance: language, build, process model, scheduling, budgets | Server Runtime & Performance Engineer | [runtime-performance.md](../runtime-performance.md) |

Rules:

- **Numbers are never reused or renumbered.** A new decision in an area takes the next free number in that area's range.
- **Superseding:** write a new ADR (00xx for cross-area decisions, or the next number in the area). Change only the old ADR's `Status` line to `Superseded by ADR NNNN`.
- **Amending** (a new number or a narrower rule without replacing the decision): the old ADR stays accepted, and this index lists the amendment.
- **This index is the authoritative status record.** Specialist ADR files still say `Status: Proposed` in their headers because the merge edited only superseded headers. Read the status column below.

## Index

| ADR | Title | Area | Status | Amended by / notes |
|---|---|---|---|---|
| [0001](0001-capacity-bandwidth-cost-baseline.md) | Reconciled capacity, bandwidth and cost baseline; three tiers of tick targets | Cross-cutting | **Accepted** | Provisional numbers until the Linux re-measure in M3 |
| [0002](0002-match-endpoints-ports-tls-and-admission.md) | Match endpoints: WSS on TCP 443 from Phase 1, WT on per-process UDP until a sidecar owns UDP 443; one build-compat key | Cross-cutting | **Accepted** | Supersedes 0105; amends 0106, 0203, 0204 |
| [0003](0003-hitbox-model-and-shared-hitbox-table.md) | Procedural hitbox rig; `SOLDIER_HITBOXES` in `packages/shared` with a generated fit and drift gate | Cross-cutting | **Accepted** | Supersedes 0206 |
| [0004](0004-match-process-model-and-packing-trigger.md) | Process per match at launch; `MatchHost` packs from M3; measured switch triggers | Cross-cutting | **Accepted** | Supersedes 0303 |
| [0005](0005-monorepo-package-boundaries-and-server-build.md) | Package boundaries, dependency direction, bundled erasable-TS server build | Cross-cutting | **Accepted** | Consolidates 0302, netcode.md §12.1 and platform.md §8 |
| [0101](0101-modular-monolith-backend.md) | Control plane as one TypeScript modular monolith with role entrypoints | Platform | **Accepted** | Shared schemas live in `packages/contracts` (0005) |
| [0102](0102-build-matchmaker-and-allocator.md) | Build the matchmaker and allocator; buy compute only | Platform | **Accepted** | Tickets carry the compat key (0002 §6); placement rules (0002 §5) |
| [0103](0103-hybrid-hosting-owned-baseline-burst-provider.md) | Hybrid hosting: owned bare metal baseline, per-minute burst; no Kubernetes at launch | Platform | **Accepted** | Cost figures and break-even replaced by 0001; burst ≥ 0.5 vCPU (0001 §3); Gameye evaluation promoted |
| [0104](0104-region-strategy-singapore-first.md) | Launch in Singapore only; open regions by population | Platform | **Accepted** | — |
| [0105](0105-game-server-tls-and-endpoints.md) | Game-server TLS, endpoints and WSS fallback | Platform | **Superseded by 0002** | TLS content carried forward in 0002 §2 |
| [0106](0106-signed-join-tokens-and-reconnect.md) | Short-lived Ed25519 join tokens, verified offline; reconnect by re-issue | Platform | **Accepted** | Adds a `ch` (contentHash) claim; three-layer resume ladder (0002 §7) |
| [0107](0107-data-stores.md) | Postgres, Redis/Valkey, R2; ClickHouse deferred | Platform | **Accepted** | Replay format = inputs + 10 s keyframes (architecture.md §4, C14) |
| [0201](0201-server-authoritative-shared-simulation.md) | Server-authoritative shared TS tick; no player-vs-player movement collision | Netcode | **Accepted** | Prerequisite refactors R1–R14 (architecture.md §7.2); Babylon/Havok versions in `contentHash` (0002 §6) |
| [0202](0202-tick-and-send-rates.md) | 60 Hz sim, 60 Hz redundant input, 60 Hz adaptive snapshots | Netcode | **Accepted** | Snapshot skip/step-down thresholds unified (architecture.md §4, C18) |
| [0203](0203-webtransport-primary-websocket-fallback.md) | WebTransport primary, WSS fallback, no WebRTC; transport behind an interface | Netcode | **Accepted** | Transport gate moved to M3 exit; ports per 0002 |
| [0204](0204-bitpacked-delta-snapshot-protocol.md) | Bit-packed quantized delta protocol, three reliability tiers | Netcode | **Accepted** | Compat key enforced end to end (0002 §6) |
| [0205](0205-projectile-lag-compensation-shooter-time-rewind.md) | Server projectiles vs hitboxes rewound by shooter view delay, cap 200 ms | Netcode | **Accepted** | — |
| [0206](0206-procedural-capsule-hitboxes.md) | Procedural capsule hitboxes from pose inputs | Netcode | **Superseded by 0003** | Model kept; placement and verification replaced |
| [0207](0207-visibility-and-audibility-relevance.md) | Replicate enemies only when potentially visible or audible | Netcode | **Accepted** | Must ship before public launch (M5 / Phase 2 exit) |
| [0301](0301-node-typescript-match-runtime.md) | Node.js 24 + TypeScript match runtime reusing shared code and Havok WASM | Runtime | **Accepted** | Bun re-evaluated after the transport gate (0002 §4) |
| [0302](0302-havok-via-babylon-deep-imports-bundled.md) | Havok via Babylon deep imports in a bundled server; split `packages/shared` | Runtime | **Accepted** | Package boundaries detailed in 0005 |
| [0303](0303-process-per-match-with-packable-match-host.md) | Process per match with a packable `MatchHost` | Runtime | **Superseded by 0004** | Architecture kept; triggers replaced |
| [0304](0304-drift-free-hybrid-tick-scheduler.md) | Drift-free hybrid tick scheduler; cpusets, never CPU quotas | Runtime | **Accepted** | SLO tiers per 0001 §5 |
| [0305](0305-performance-budgets-and-ci-gates.md) | Per-tick budgets, allocation-free hot paths, CI gates | Runtime | **Accepted** | RSS gate applies to the bundled server with collision-only level (0001); gate list merged in architecture.md §6.9 |
| [0306](0306-performance-migration-path.md) | Migration path: minimal controller → packing → sidecar → WASM physics core | Runtime | **Accepted** | Step 2 and step 3 triggers per 0004 and 0002 §4 |

## By topic

- **Simulation and prediction:** 0201, 0202, 0301, 0302, 0305, 0306, 0005
- **Wire and transport:** 0203, 0204, 0002
- **Hit registration:** 0205, 0003
- **Anti-cheat and information hiding:** 0201, 0205, 0207
- **Process, capacity and cost:** 0001, 0004, 0304, 0103
- **Control plane and data:** 0101, 0102, 0104, 0106, 0107, 0002
