# ADR 0105: Game-server TLS uses per-host names on a separate domain with a wildcard certificate, certificate hashes on burst hosts, and a WSS fallback

- Status: Superseded by [ADR 0002](0002-match-endpoints-ports-tls-and-admission.md)
- Date: 2026-09-14
- Owner: Platform & Infrastructure Architect
- Related: [platform.md §4.3–4.4](../platform.md#44-tls-for-game-servers), Netcode transport ADR (pending)

## Context

Browsers require TLS for both WebTransport (HTTP/3 over QUIC) and WSS. Each match process listens on its own UDP and TCP ports on a host.

- **Owned hosts** have stable IPs that we control.
- **Burst hosts** (Edgegap) are ephemeral. They come with the provider's own FQDN, and Edgegap offers a "TLS Upgrade" proxy for WSS.
- **Certificate hashes:** WebTransport supports `serverCertificateHashes` for self-signed certificates. The certificate must be ECDSA P-256 (RSA isn't allowed) with validity under 14 days, and support has been uneven (for example Firefox bug 1873263).
- **Browser support:** Safari shipped WebTransport in 26.4 (March 2026), so it now works across the major browsers.
- **Let's Encrypt:**
  - It is shortening lifetimes: 45-day certificates are available now, the default drops to 64 days in February 2027 and to 45 days in February 2028.
  - It limits issuance to 50 certificates per registered domain per week.
  - It has issued 6-day IP-address certificates since January 2026.

## Decision

1. **Separate registrable domain for game infrastructure.** The placeholder is `tbgs.net`, distinct from the website and API domain. Host names look like `sg-01.tbgs.net`, and region beacons like `ping-sg.tbgs.net`.
2. **Owned hosts** use one **wildcard certificate `*.tbgs.net`** from Let's Encrypt via **DNS-01** (a Cloudflare token scoped to that zone only).
   - The `fleet` role issues it and renews every 20 days.
   - Agents fetch it over their authenticated channel and hot-reload it into match processes.
   - Alert when expiry is under 14 days.
3. **Burst and third-party hosts:**
   - **WebTransport:** the process generates an ephemeral ECDSA P-256 certificate valid for 10 days and reports its SHA-256 to the allocator. The hash is returned in `match.found` as `certHashes`.
   - **WSS:** use the provider's TLS termination and FQDN (Edgegap TLS Upgrade).
4. **The client connection policy is the same everywhere.**
   - Try WebTransport, with a 3 s timeout.
   - If that fails, use WSS on the same allocation.
   - Report the fallback reason to telemetry.

   Networks that block high ports get a host-level TCP 443 WSS proxy in Phase 2 if telemetry shows the need.
5. **Local dev** uses a generated self-signed certificate plus `serverCertificateHashes` (Chrome) and plain WS on localhost.

## Consequences

- One certificate to manage for all owned hosts, with no per-host issuance and no rate-limit exposure when hosts churn.
- A leaked host key can impersonate other game hosts, but **not** the API or website, and can't touch auth cookies, because the domain is separate. The blast radius is limited to gameplay endpoints, where join tokens are also bound to host ID (ADR 0106).
- Burst hosts depend on certificate-hash support. The WSS fallback covers browsers where it fails.
- We need automation for DNS records per owned host (Terraform) and certificate distribution in the agent.

## Alternatives considered

- **Per-host Let's Encrypt certificates (HTTP-01/TLS-ALPN-01).** More issuance, rate limits if hosts churn, and port 80/443 exposure on every host.
- **Let's Encrypt IP-address certificates (6-day).** Avoids DNS but needs renewal every ~4 days and an ACME challenge responder per host. Kept as a fallback option.
- **Certificate hashes everywhere.** Simplest operationally, but uneven browser support would push more players to WSS. Rejected as the primary path for owned hosts.
- **Terminating QUIC at a central proxy.** Adds a latency hop and a single point of failure. Rejected.
