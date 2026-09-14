# ADR 0101: The control plane is one TypeScript modular monolith with role entrypoints

- Status: Proposed
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §1](../platform.md#1-service-architecture), ADR 0102

## Context

The platform needs auth, profile, party, presence, matchmaking, allocation/fleet management, results ingest, stats and telemetry. The team is one developer plus AI assistants. The monorepo is already TypeScript (pnpm, TS 7). Control-plane load is tiny even at 10k CCU: about 1,250 tickets per minute and a few thousand WebSocket connections. The game servers are what's expensive and latency-sensitive, and they live in a separate app.

Microservices would add deploys, network hops, distributed failure modes and observability overhead that no one has time to run.

## Decision

- Build `apps/server-api` as a **modular monolith** (Node 24, TypeScript, Fastify or Hono). Each module (`auth`, `profile`, `party`, `presence`, `matchmaking`, `fleet`, `results`, `stats`, `telemetry`) owns its tables and Redis keys and exposes an in-process interface. No module reads another module's tables.
- Ship **one image** with a `ROLE` entrypoint: `api`, `matchmaker`, `fleet`, or `all`.
  - Launch runs `all` on two VMs. `matchmaker` and `fleet` leader loops use Redis leases, so only one instance is active per region.
- Share request and response schemas through `packages/contracts` (TypeBox or Zod) with the client and `server-match`.
- Keep the match server (`apps/server-match`) a separate deployable. Its language is the Runtime teammate's decision.

## Consequences

- One codebase, one deploy pipeline (Kamal), one set of dashboards. Local dev runs everything in a single process.
- Scaling out is horizontal replication of the whole image. That is fine at this load.
- A bug in one module can crash the process for all modules. This is mitigated by two replicas, supervisors, and stateless design (state lives in Postgres and Redis).
- Splitting later is mechanical: module boundaries are already enforced, so `fleet` or `matchmaker` can become its own deployment by changing `ROLE`.

## Alternatives considered

- **Microservices from day one.** Rejected: operational cost with no load-driven need.
- **Nakama as the control plane.** A strong feature set (auth, parties, matchmaker, social), but a Go/goja runtime and its own identity and storage model become core lock-in. We would still need our own fleet allocator. Revisit if social features become urgent (see ADR 0102).
- **Serverless functions** (Workers/Lambda) for the API. Rejected for launch: we need long-lived WebSockets and leader loops, and the result would split our runtime into two platforms.
