# ADR 0204: Hand-rolled bit-packed protocol with quantization, per-client delta snapshots and three reliability tiers

- Status: Proposed
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §6](../netcode.md#6-protocol), `tools/bench/netcode/snapshot-codec.mjs`; Platform Q6/Q8

## Context

- Per-tick state is small (10 players), mostly unchanged between snapshots, and made of bounded ranges (1 km map, angles, speeds ≤ 64 m/s). *Superseded on 2026-09-16: the maps are now 500 × 500 m. The position ranges below keep their headroom and their bit widths are unchanged.*
- Measured encodings of one full 10-player snapshot:

| Encoding | Size | Encode time |
|---|---|---|
| JSON | 1,826 B (deflate 480 B) | 14–28 µs |
| float32 byte-aligned struct (the size class of FlatBuffers / protobuf with floats) | 414 B | 0.5–1.8 µs |
| Bit-packed quantized, full | 220 B (header and owner block included) | |
| Bit-packed quantized, delta against acked baseline | **~105 B mean**, p95 135 B | ~2 µs per client (prototype) |

- deflate on the bit-packed deltas saves 3–4%.
- Events differ in reliability needs: tracers are disposable; hit confirms must arrive but shouldn't wait behind a stream retransmit; lobby and inventory state needs order.

## Decision

1. **Wire format:** LSB-first bit packing over `Uint8Array` via shared `BitWriter`/`BitReader` codecs in `packages/protocol`, with zero dependencies. No generic compression on datagrams.
2. **Quantization:**
   - positions 1 mm (x/z 20 bits, y 19 bits)
   - remote yaw 12 / pitch 10 bits
   - remote velocity 0.125 m/s (10 bits)
   - owner velocity 1 mm/s
   - input aim 20/18 bits
   - health 0.1 HP
   - timers in ticks
3. **Deltas:**
   - The server keeps the last 128 sent snapshots per client and encodes against the newest acked one (ack in every `Input`); field groups carry changed bits.
   - Position deltas use a shared-bucket vector code (±127 mm / ±2047 / ±32767 / absolute).
   - Full snapshot when no usable ack exists. Dead-reckoned deltas (−6 to −8%) are optional in M5.
4. **Reliability tiers:**
   - **U**, unreliable datagrams: inputs, snapshot state, `Shot`, `PlayerHit`, `AudioShot`, throwable corrections.
   - **R**, reliable-over-unreliable: events resent inside snapshots until an acked snapshot contains them; 12-bit seq dedup.
   - **S**, one ordered control stream: handshake, phases, zone, inventory/loot resync, kill feed, match end.
   - Client actions ride input redundancy until acked.
5. **Size cap** min(1,000 B, `maxDatagramSize`), with a defined drop order (U events → bystander FX → audible-only entities → far entities; never R events or the owner block).
6. **Versioning:** exact match of `PROTOCOL_VERSION` (u16) and a generated `contentHash` of gameplay tuning, per match. Message IDs are never reused; new sections use presence bits.

## Consequences

- ~4× smaller than a float struct and ~17× smaller than JSON. 80 kbps per client at 60 Hz.
- Codecs are hand-written. That's more code than a schema compiler, and it needs roundtrip + fuzz tests as CI gates (planned) and a single source of truth for bit widths (`quantize.ts`).
- No cross-version compatibility: clients reload on mismatch (fits Platform's canary model).
- Debugging needs a decoder tool (JSON dump of decoded snapshots) in `packages/protocol`.

## Alternatives considered

- **protobuf / FlatBuffers / Cap'n Proto.** Byte-aligned, no sub-byte quantization, no delta against a baseline; FlatBuffers' zero-copy benefit doesn't matter for 100 B messages. Rejected.
- **msgpack/CBOR.** Self-describing overhead. Rejected.
- **JSON + permessage-deflate.** 480 B per snapshot and 14–28 µs encode. Rejected except for tooling.
- **Reliable ordered streams for all events.** Head-of-line blocking on hit confirms. Rejected.
