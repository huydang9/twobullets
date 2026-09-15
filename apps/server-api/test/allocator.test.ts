import type { MatchConfig } from "@twobullets/contracts/match";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AllocationError, type AllocatorListener } from "../src/fleet/allocator";
import { LocalProcessAllocator, type LocalProcessAllocatorOptions } from "../src/fleet/localProcessAllocator";
import { buildMatchConfig } from "../src/matches/matchConfig";

const FIXTURE = fileURLToPath(new URL("./fixtures/fakeMatchProcess.mjs", import.meta.url));

function options(overrides: Partial<LocalProcessAllocatorOptions> = {}, lines: string[] = []): LocalProcessAllocatorOptions {
  return {
    command: process.execPath,
    args: [FIXTURE],
    bindHost: "127.0.0.1",
    portMin: 7400,
    portMax: 7401,
    maxMatches: 2,
    urlTemplate: "wss://play.test/gs/{port}/m/{matchId}",
    readyTimeoutMs: 3000,
    maxMinutes: 25,
    killGraceMs: 500,
    log: (l) => lines.push(l),
    ...overrides,
  };
}

function config(matchId: string): MatchConfig {
  return buildMatchConfig({ matchId, hostId: "sg-1", region: "sg", matchSeed: 1, settings: { mode: "duo", maxPlayers: 4, mapId: "v1", fillWithBots: true }, humans: [{ accountId: "g_player", teamId: 0 }] });
}

function recorder(): AllocatorListener & { events: string[]; exited: Promise<void> } {
  const events: string[] = [];
  let resolveExit!: () => void;
  const exited = new Promise<void>((r) => (resolveExit = r));
  return {
    events,
    exited,
    onPhase: (id, phase) => events.push(`phase ${id} ${phase}`),
    onPlayer: (id, acct, ev) => events.push(`player ${id} ${acct} ${ev}`),
    onMetrics: () => {},
    onResult: (id, r) => events.push(`result ${id} ${r.outcome}`),
    onExit: (id, code) => {
      events.push(`exit ${id} ${code}`);
      resolveExit();
    },
  };
}

describe("LocalProcessAllocator (agent IPC with a fake match process)", () => {
  it("spawns, hands over JWKS + config, resolves on the first phase, reports players/result/exit and frees the port", async () => {
    const lines: string[] = [];
    const alloc = new LocalProcessAllocator(options({}, lines), [{ kty: "OKP", crv: "Ed25519", x: "AAAA", kid: "k1" }]);
    const rec = recorder();
    alloc.setListener(rec);
    const allocated = await alloc.allocate(config("m_one"));
    expect(allocated).toEqual({ matchId: "m_one", hostId: "sg-1", wsUrl: "wss://play.test/gs/7400/m/m_one" });
    expect(alloc.capacity()).toEqual({ used: 1, max: 2 });
    alloc.release("m_one");
    await rec.exited;
    expect(rec.events).toEqual(["phase m_one Warmup", "player m_one g_player joined", "phase m_one Ended", "result m_one completed", "exit m_one 0"]);
    expect(alloc.capacity().used).toBe(0);
    expect(lines.some((l) => l.includes("[match m_one] jwks k1"))).toBe(true);
    expect(lines.some((l) => l.includes("allocated m_one on 127.0.0.1:7400 env m_one"))).toBe(true);
  });

  it("refuses beyond capacity and reuses freed ports", async () => {
    const alloc = new LocalProcessAllocator(options({ maxMatches: 1 }));
    alloc.setListener(recorder());
    await alloc.allocate(config("m_a"));
    await expect(alloc.allocate(config("m_b"))).rejects.toMatchObject({ reason: "noCapacity" });
    await alloc.shutdown();
    const again = await alloc.allocate(config("m_c"));
    expect(again.wsUrl).toContain("/gs/7400/");
    await alloc.shutdown();
  });

  it("fails allocation when the process crashes or never becomes ready", async () => {
    const crash = new LocalProcessAllocator(options({ env: { FAKE_MATCH: "crash-on-allocate" } }));
    crash.setListener(recorder());
    const err = await crash.allocate(config("m_crash")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllocationError);
    expect((err as AllocationError).reason).toBe("crashed");
    expect(crash.capacity().used).toBe(0);

    const slow = new LocalProcessAllocator(options({ env: { FAKE_MATCH: "never-ready" }, readyTimeoutMs: 300 }));
    slow.setListener(recorder());
    await expect(slow.allocate(config("m_slow"))).rejects.toMatchObject({ reason: "timeout" });
    await slow.shutdown();
  });

  it("force-kills a process that ignores drain and reports the exit", async () => {
    const alloc = new LocalProcessAllocator(options({ env: { FAKE_MATCH: "ignore-drain" }, killGraceMs: 200 }));
    const rec = recorder();
    alloc.setListener(rec);
    await alloc.allocate(config("m_stuck"));
    alloc.pushJwks([{ kty: "OKP", crv: "Ed25519", x: "BBBB", kid: "k2" }]);
    alloc.release("m_stuck");
    await rec.exited;
    expect(rec.events.at(-1)).toMatch(/^exit m_stuck \d+$/);
    expect(alloc.capacity().used).toBe(0);
  });
});
