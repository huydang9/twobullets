# ADR 0107: Postgres as the source of truth, Redis/Valkey for ephemeral state, R2 for blobs and raw telemetry, ClickHouse deferred

- Status: Proposed
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §5](../platform.md#5-data)

## Context

**Durable data:** accounts, identities, sanctions, match results, stats.

**Ephemeral high-churn state:** presence, parties, matchmaking tickets, the live match directory, host heartbeats, rate limits.

**Bulky write-once data:** replays (1–2 MB per match), gameplay events, client telemetry.

**Volume at 10k CCU:** about 250k matches per month, 2.5M participant rows per month.

The team is one developer, so managed services are preferred where cost is small. Players are in Southeast Asia, and Vietnam's PDPL (effective January 1, 2026) regulates offshore processing of Vietnamese residents' data.

## Decision

- **Postgres, managed, in Singapore** (Neon or equivalent) with point-in-time recovery, plus a weekly logical dump to R2.
  - Stores all durable relational data (schema sketch in platform.md §5.1).
  - Migrations are forward-only, expand/contract.
  - Local dev uses PGlite or `DATABASE_URL`.
- **Redis-compatible Valkey**, self-hosted on the control-plane VMs (a primary and a replica), persistence off.
  - Every key is reconstructible or expendable: tickets, parties, presence, `active:{accountId}`, `match:{id}`, `host:{id}`, rate-limit buckets, pub/sub, telemetry buffer stream.
  - Local dev uses an in-memory adapter.
- **Cloudflare R2** holds replays (14-day retention, 90 days if reported), crash dumps, raw telemetry NDJSON/Parquet (90 days) and backup copies.
  - Analysis in Phases 1–2 is DuckDB over R2 files.
- **ClickHouse is deferred to Phase 3.** It will ingest from R2 files, either Cloud Basic at about $66–186/mo or self-hosted, once ad hoc DuckDB queries and Postgres dashboards stop being enough.
- **PII minimisation:** guests have no email or name; IPs are truncated in analytics; export and delete endpoints exist from Phase 2.

## Consequences

- Losing Redis costs players their place in the queue and their parties, not their accounts. It can be recovered by requeueing.
- Postgres comfortably handles 10k CCU on a single primary. Read replicas and partitioning of `match_participants` by month come only if needed.
- Telemetry costs almost nothing until Phase 3, and no events are lost in the meantime because the raw files are kept.
- Data residency sits in Singapore, which is offshore for Vietnam. Transfer impact assessments and processor agreements need legal review before the public launch.

## Alternatives considered

- **Self-hosted Postgres on a bare-metal box.** Cheaper at scale but needs a DBA mindset (backups, failover, upgrades). Revisit at 10k+ CCU.
- **A NoSQL primary store (DynamoDB, Firestore, Mongo).** The relational queries (stats, sanctions, reports) fit Postgres, and those options add lock-in.
- **ClickHouse or another OLAP store from day one.** A recurring cost and an ops surface before there are questions to answer.
- **Nakama storage.** See ADR 0101 and ADR 0102.
