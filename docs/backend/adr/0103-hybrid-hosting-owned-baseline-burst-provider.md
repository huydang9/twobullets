# ADR 0103: Hybrid hosting with owned bare metal as baseline and a per-minute provider for burst; no Kubernetes at launch

- Status: Proposed
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §4](../platform.md#4-deployment-and-hosting), ADR 0102, ADR 0104

## Context

Match servers dominate cost. The planning assumptions (platform.md §4.6) are:

- 0.25–0.5 vCPU and 150–300 MB per match;
- about P/7.5 concurrent matches at peak CCU P;
- about 40 kbps server-to-client per player.

Indicative prices, September 2026:

| Option | Price |
|---|---|
| OVHcloud Advance-1, Singapore | EPYC 4244P 6c/12t, US$136/mo, unmetered, anti-DDoS included (≈ $11/thread-month, $0 egress) |
| Hetzner CCX13, Singapore | €53.99/mo for 2 vCPU after the 2026 increases; Singapore traffic overage €7.40/TB |
| Edgegap | ≈ $0.069/vCPU-h + $0.10/GB, pay per match-minute, 615+ locations |
| Gameye | $0.07/vCPU-h, egress included |
| GameLift | AWS's own example is $2,978/mo for 1,000 CCU |

Estimated match-server cost at 1,000 peak CCU:

| Option | Monthly |
|---|---|
| Owned, N+1 | $816–1,360 |
| Edgegap only | $1,501–2,424 |
| GameLift | ~$3,000 |

Bare metal can't scale within minutes. Thin regions (Tokyo, US and EU at launch) can't justify a whole box.

Kubernetes plus Agones is the industry-standard orchestrator (v1.60, August 2026). For one developer it means running a control plane, CNI, upgrades and node pools, all before the first player.

## Decision

- **Baseline:** OVHcloud dedicated servers in Singapore (Advance range). Run N+1 hosts sized to the weekly p95 load. Each host runs our **host agent** under systemd in one container; it spawns one process per match and keeps a warm pool.
- **Burst and thin regions:** use Edgegap behind the `FleetProvider` interface (ADR 0102). Spill new allocations when owned free slots fall below demand. Tokyo, US and EU start burst-only. Evaluate Gameye as an egress-included alternative in Phase 2.
- **Buying and releasing capacity:**
  - Order an owned box when region p95 utilisation exceeds 70%, or when monthly burst spend in a region exceeds 60% of a box price.
  - Release a box after 30 days below 35%.
- **No Kubernetes until about 50 hosts** or multiple owned providers. The migration path is Agones (self-managed k3s on bare metal, or GameFabric), plugged in as another `FleetProvider`.
- Control-plane VMs, Postgres and Redis run in Singapore on ordinary cloud VMs and managed services (ADR 0107). Game hosts never share machines with the control plane.

## Consequences

**Benefits**

- About 40–60% lower match cost than all-managed at 1k–10k CCU.
- Unmetered bandwidth makes the result insensitive to the Netcode bandwidth outcome.
- Predictable tick timing on dedicated cores.

**Costs**

- We handle hardware failure (N+1, auto-quarantine, reallocate) and OS patching (drain → reboot).
- Monthly commitment plus a setup fee equal to one month per box.
- Two provider code paths to test. Edgegap must be exercised continuously (a small share of real traffic, or a daily synthetic match) so burst works when needed.
- Estimated monthly totals, including the platform: about $190 at 100 CCU, about $1.1–1.8k at 1k, about $6.8–12.5k at 10k.

## Alternatives considered

- **Edgegap/Gameye only.** Simplest, but costs 1.5–2× at steady load, and Edgegap egress grows with bandwidth. Good fallback if operating hosts becomes a burden.
- **GameLift managed fleets.** Mature, and bandwidth is now free, but roughly 2–3× cost, AWS lock-in, and SDK friction for Node or Rust.
- **Hetzner/Vultr cloud VMs for game servers in Singapore.** Higher price per vCPU plus Asia egress overage and weaker UDP DDoS protection. Kept for control-plane VMs only.
- **Fly.io Machines.** UDP needs a dedicated IPv4 and `fly-global-services`, QUIC support isn't documented, and it costs about $32+/vCPU-month. Rejected for match servers.
- **Agones on day one.** Rejected for operational burden; it is the scale path.
