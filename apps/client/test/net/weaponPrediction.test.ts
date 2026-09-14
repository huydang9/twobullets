import { appendFileSync } from "node:fs";
import { ManualClock } from "@twobullets/netcode/testing/clock";
import { LinkConditioner } from "@twobullets/netcode/testing/LinkConditioner";
import { createMemorySessionPair } from "@twobullets/netcode/testing/memorySession";
import { NETWORK_PROFILES, type NetworkProfile } from "@twobullets/netcode/testing/profiles";
import { createSeededRng } from "@twobullets/netcode/testing/rng";
import { PlayerInputRing } from "@twobullets/shared/inputRing";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createSimWorld, type SimWorld } from "@twobullets/sim/index";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalPlayerNet } from "../../src/net/LocalPlayerNet";
import { NetClient } from "../../src/net/NetClient";
import { NetClock, WS_BUFFER_TICKS, WT_BUFFER_TICKS } from "../../src/net/NetClock";
import { RemoteRoster } from "../../src/net/RemoteRoster";
import { FakeMatchServer, HeadlessPlayer, type FakeServerOptions } from "./netHarness";

// T4.5 acceptance: weapon prediction with the real `stepPlayer(..., { weapons: true })` on both sides (net loadout,
// fire bursts, ADS, reloads, weapon switches while moving), reconciled against the owner weapon group over
// LinkConditioner, and R11: replays never produce shots and no shot id is presented twice.

const TICK_MS = 1000 / 60;
const WARMUP_MS = 3000;

let serverWorld: SimWorld;
let clientWorld: SimWorld;

beforeAll(async () => {
  const havok = await loadHavok();
  serverWorld = await createSimWorld(havok, ARENA_LEVEL);
  clientWorld = await createSimWorld(havok, ARENA_LEVEL);
});

afterAll(() => {
  serverWorld?.dispose();
  clientWorld?.dispose();
});

interface Result {
  seconds: number;
  corrections: number;
  correctionsAfterWarmup: number;
  weaponCorrections: number;
  weaponCorrectionsAfterWarmup: number;
  weaponDiffMask: number;
  resyncs: number;
  synthetic: number;
  serverShots: number;
  emittedShots: number;
  suppressedShots: number;
  replayShots: number;
  duplicateEmits: number;
  missingEmits: number;
  state: string;
}

function run(profile: NetworkProfile, seconds: number, seed: number, serverOptions: FakeServerOptions = {}): Result {
  const clock = new ManualClock(10_000);
  const rng = createSeededRng(seed);
  const [clientEnd, serverEnd] = createMemorySessionPair({ clock, kind: profile.kind });
  const link = new LinkConditioner(clientEnd, profile, clock, seed);
  const server = new FakeMatchServer(serverEnd, clock, serverWorld, ARENA_LEVEL, 0, { weapons: true, ...serverOptions });
  const [sx, sy, sz] = ARENA_LEVEL.spawnPoints[1]!.position;
  const player = new HeadlessPlayer(clientWorld, { x: sx, y: sy, z: sz }, { weapons: true });
  const netClock = new NetClock({ bufferTicks: profile.kind === "websocket" ? WS_BUFFER_TICKS : WT_BUFFER_TICKS });
  const ring = new PlayerInputRing();
  const local = new LocalPlayerNet(player);
  const client = new NetClient(link, { clock, netClock, local, inputs: ring, roster: new RemoteRoster(), joinToken: "test" });
  client.start();

  const startMs = clock.now();
  const endMs = startMs + seconds * 1000;
  let nextServerTickMs = startMs;
  let nextFrameMs = startMs + 3;
  let lastFrameMs = startMs;
  let correctionsAtWarmup = -1;
  let weaponAtWarmup = -1;
  while (clock.now() < endMs) {
    clock.advance(0.5);
    link.pump();
    while (clock.now() >= nextServerTickMs) {
      server.step();
      nextServerTickMs += TICK_MS;
    }
    link.pump();
    if (clock.now() >= nextFrameMs) {
      const dt = (clock.now() - lastFrameMs) / 1000;
      client.update(dt);
      player.frame(dt, netClock, ring, client, client.state === "playing" ? local : null);
      lastFrameMs = clock.now();
      nextFrameMs += 1000 / 144 + (rng.next() - 0.5) * 2;
      if (correctionsAtWarmup < 0 && clock.now() - startMs > WARMUP_MS) {
        correctionsAtWarmup = local.stats.corrections;
        weaponAtWarmup = local.stats.weaponCorrections;
      }
    }
  }

  // Every presented id is unique; every id the server fired (after the client started predicting) was presented once.
  const emitted = new Set<number>();
  let duplicateEmits = 0;
  for (const id of player.emittedShotIds) {
    if (emitted.has(id)) duplicateEmits++;
    emitted.add(id);
  }
  const firstEmitted = player.emittedShotIds[0] ?? Infinity;
  const newestEmitted = player.emittedShotIds[player.emittedShotIds.length - 1] ?? -1;
  let missingEmits = 0;
  for (const id of server.firedShotIds) if (id >= firstEmitted && id <= newestEmitted && !emitted.has(id)) missingEmits++;

  return {
    seconds,
    corrections: local.stats.corrections,
    correctionsAfterWarmup: local.stats.corrections - Math.max(0, correctionsAtWarmup),
    weaponCorrections: local.stats.weaponCorrections,
    weaponCorrectionsAfterWarmup: local.stats.weaponCorrections - Math.max(0, weaponAtWarmup),
    weaponDiffMask: local.stats.weaponDiffMask,
    resyncs: client.stats.resyncs,
    synthetic: server.inputs.stats.synthetic,
    serverShots: server.firedShotIds.length,
    emittedShots: player.emittedShotIds.length,
    suppressedShots: player.suppressedShots,
    replayShots: player.replayShots,
    duplicateEmits,
    missingEmits,
    state: client.state,
  };
}

const log = (label: string, r: Result) => {
  const out = process.env.NET_VERBOSE;
  if (out) appendFileSync(out, `${JSON.stringify({ label, ...r })}\n`);
};

describe("weapon prediction over LinkConditioner with the real stepPlayer weapons", () => {
  it("lan: zero corrections (movement and weapon) while shooting, every server shot presented exactly once", () => {
    const r = run(NETWORK_PROFILES.lan, 30, 41);
    log("weapons-lan", r);
    expect(r.state).toBe("playing");
    expect(r.serverShots).toBeGreaterThan(40);
    expect(r.correctionsAfterWarmup).toBe(0);
    expect(r.weaponCorrectionsAfterWarmup).toBe(0);
    expect(r.resyncs).toBe(0);
    expect(r.replayShots).toBe(0);
    expect(r.duplicateEmits).toBe(0);
    expect(r.missingEmits).toBe(0);
    expect(r.suppressedShots).toBe(0);
  }, 120_000);

  it("typical: bounded weapon mispredictions, no resyncs, replays never emit (3 seeds × 60 s)", () => {
    let weapon = 0;
    let corrections = 0;
    for (const seed of [42, 52, 62]) {
      const r = run(NETWORK_PROFILES.typical, 60, seed);
      log("weapons-typical", r);
      expect(r.state).toBe("playing");
      expect(r.resyncs).toBe(0);
      expect(r.serverShots).toBeGreaterThan(80);
      expect(r.replayShots).toBe(0);
      expect(r.duplicateEmits).toBe(0);
      weapon += r.weaponCorrectionsAfterWarmup;
      corrections += r.correctionsAfterWarmup;
    }
    // Every weapon misprediction is a lost input the server synthesized (the previous input repeated, edge buttons
    // cleared) while the trigger or a reload/switch changed; the script changes them far more often than a player.
    expect(weapon / 3).toBeLessThan(15);
    expect(corrections / 3).toBeLessThan(25);
  }, 240_000);

  it("a shot the server never fired: corrected, replayed silently, the reused ids are never presented again", () => {
    // Drop fire for whole script segments after warm-up: the client predicted bursts there that the server never fired,
    // so each correction rewinds the shot counter and the next live shots reuse ids that were already presented.
    const drop = new Set<number>();
    for (let t = 1400; t < 3600; t += 200) for (let k = 0; k < 80; k++) drop.add(t + k);
    const r = run(NETWORK_PROFILES.lan, 45, 43, { dropFireAt: drop });
    log("weapons-dropped-fire", r);
    expect(r.state).toBe("playing");
    expect(r.weaponCorrections).toBeGreaterThan(0);
    expect(r.replayShots).toBe(0);
    expect(r.duplicateEmits).toBe(0);
    expect(r.suppressedShots).toBeGreaterThan(0);
  }, 120_000);
});
