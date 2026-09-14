# ADR 0104: Launch in Singapore only; open regions based on population

- Status: Proposed
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §2.2, §2.5, §4.1](../platform.md#41-regions)

## Context

The owner is in Vietnam and the first audience is Southeast Asia. Average RTT from WonderNetwork:

| From | Singapore | Hong Kong | Tokyo |
|---|---|---|---|
| Ho Chi Minh City | 37 ms | 53 ms | 104 ms |
| Bangkok | 23 ms | | |
| Jakarta | 19 ms | | |
| Manila | 32 ms | | |
| Hong Kong | 30 ms | | |
| Taipei | 44 ms | | |
| Seoul | 73 ms | | |

A 10-player battle royale needs about 100 regional CCU at prime time to fill lobbies in under a minute. Players cycle about every 8 minutes, so tickets arrive at roughly CCU/8 per minute. Each extra region splits the pool.

## Decision

- **Launch with one game region, Singapore**, and put the control plane there too.
- **Region order after that:**
  1. **Tokyo** (Japan, Korea, Taiwan).
  2. **US-West and US-East.**
  3. **EU (Frankfurt).**

  **Hong Kong is not a separate region**: Singapore covers it at 30 ms.
- **Opening a region:** a region's queue opens only when its prime-time CCU is at least about 100 for 7 days, or when the forecast p90 wait is 60 s or less. New regions start **burst-only** (ADR 0103) and get owned hardware once sustained.
- **Region choice per ticket:** clients measure RTT to open regions' beacons (median of 5 samples).
  - The matchmaker prefers the lowest-RTT region.
  - It relaxes to any region within best + 30 ms after 30 s.
  - It relaxes to any region at or below 90 ms after 60 s.
  - A party uses the maximum RTT across its members.
- Players far from every open region can still play, and see the expected ping before queueing.

## Consequences

- Short queues at launch at the cost of higher ping for North Asia, the Americas and Europe. That is acceptable for an SEA-first free-to-play launch.
- Single-region control plane: menu calls from other continents take 150–250 ms. Gameplay is unaffected.
- The regions list is data-driven (`GET /v1/matchmaking/regions`), so opening one is a config change plus capacity, not a client release.

## Alternatives considered

- **SG + Tokyo + HK at launch.** Splits a small population three ways; queues would dominate the experience.
- **Hong Kong as the SEA hub.** Worse for Indonesia, Malaysia and Thailand, and not better for southern Vietnam than Singapore.
- **Global single region.** Rejected: RTT above 150 ms breaks a 60 Hz shooter for most players outside SEA.
