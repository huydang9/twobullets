# ADR 0102: Build the matchmaker and allocator; buy compute only

- Status: Proposed
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §2](../platform.md#2-matchmaking-10-players-5-teams-parties-of-12), ADR 0103

## Context

- **Game shape:** one queue with 5 team slots of 1–2 players (up to 10 players), parties of 1–2 with a fill/no-fill option, latency-based regions, backfill until landing lock, a minimum player count with a countdown, and bots later.
- **Server requirements:** authoritative 60 Hz servers in Node or Rust with WebTransport and/or WSS.
- **Market in 2026:**
  - Hathora shut down on May 5, 2026.
  - Rivet dropped game server hosting.
  - Unity Multiplay ended direct support on March 31, 2026.
  - Edgegap bills $0.00115/vCPU-min plus $0.10/GB.
  - Gameye bills $0.07/vCPU-h with egress included.
  - GameLift includes FlexMatch free with managed hosting and made gen-6+ bandwidth free on June 15, 2026, but its official server SDKs are C++/C#/Go only.
  - Open Match 2 is in public preview.
  - Colyseus and Photon don't fit an authoritative custom-protocol server at 60 Hz.

  Sources and the full table are in platform.md §2.7.

## Decision

1. **Build the matchmaker** in `server-api` (`matchmaking` module):
   - Redis tickets and per-region sorted-set queues, with a 1 Hz leader loop per region.
   - Team formation (pairing fill-solos) and match formation by priority, then age.
   - A time-based relaxation table covering player count, region and later MMR.
   - Backfill into `open:{region}` matches until landing lock, and requeue with priority after aborts.
2. **Build a thin allocator / fleet manager** (`fleet` module) with a **provider interface**:

   ```ts
   interface FleetProvider {
     readonly id: "owned" | "edgegap" | "gameye" | "agones";
     capacity(region: RegionId): Promise<CapacitySnapshot>;
     allocate(req: AllocationRequest): Promise<Allocation>; // → endpoint, certHash?, hostId
     release(allocationId: string): Promise<void>;
     drain(target: HostId | BuildVersion): Promise<void>;
   }
   ```

   - `owned` talks to our host agents over an outbound WebSocket.
   - `edgegap` is implemented in Phase 2.
   - `gameye` and `agones` are optional later.
3. **Buy compute** (bare metal and per-minute hosts). Don't buy the control plane.

## Consequences

- Full control over the rules that define player experience (region trade-offs, backfill, party fill). No per-player matchmaking fees. No SDK lock-in for Node or Rust servers.
- Estimated effort: matchmaker v1 about 1–2 weeks; allocator and agent about 2 weeks. Both are testable locally with fake providers.
- The provider abstraction is our insurance against more vendor exits like Hathora's.
- We own the correctness of the leader loops (Redis leases, idempotent allocation keyed by `matchId`) and must load-test them (platform.md §7.5, scenario 2).

## Alternatives considered

- **Open Match 2.** Scales to huge populations, but brings Go/gRPC services and a separate director for a problem that is small at our scale. Revisit above ~100k CCU or with complex skill models.
- **Nakama matchmaker.** Good party support and properties queries. It pulls in Nakama's identity and runtime, and its authoritative match handlers are unsuitable for our simulation. Keep it as the fallback if our matchmaker stalls.
- **GameLift + FlexMatch.** The most complete managed option, and bandwidth is now free on gen-6+. It is roughly 2–3× our owned-hardware cost (AWS's own 1k CCU example is $2,978/mo compute), is AWS-locked, and needs a Go sidecar or community SDK for Node or Rust. Plan B if operations become the bottleneck.
- **Edgegap matchmaker** (~$22–395/mo). Fine, but region and backfill logic stays closer to our game rules if we own it, and we'd still call Edgegap's deploy API from our allocator.
- **Colyseus / Photon / Hathora / Rivet.** Rejected (fit or availability; see platform.md §2.7).
