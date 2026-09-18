import { describe, expect, it, vi } from "vitest";
import { readNetConfig, resolveLaunch, type GameLaunch } from "../../src/game/launch";
import { readOfflineMatchOptions } from "../../src/match/options";

const tokens = async () => ({ token: "J", matchId: "m_1", url: "ws://localhost:7400/m/m_1", expiresAt: 0 });
const DEV: GameLaunch = { kind: "dev" };

/** Resolves a DEV URL and collects whatever it warned about. */
function resolveDev(search: string): { resolved: ReturnType<typeof resolveLaunch>; warnings: string[] } {
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")));
  try {
    return { resolved: resolveLaunch(DEV, search, true, readOfflineMatchOptions), warnings };
  } finally {
    warn.mockRestore();
  }
}

describe("game launch", () => {
  it("net launch: the match's endpoint, account, team and map, in DEV and production alike, whatever the URL says", () => {
    const exits: unknown[] = [];
    const launch: GameLaunch = { kind: "net", wsUrl: "wss://play.example.com/gs/7400/m/m_1", accountId: "acc_1", teamId: 2, mapId: "vn-hangxanh", matchId: "m_1", tokens, onExit: (e) => exits.push(e) };
    for (const dev of [true, false]) {
      const resolved = resolveLaunch(launch, "?bots=1&map=v1&bench=v1&net=ws://other", dev, readOfflineMatchOptions);
      expect(resolved.practice).toBeNull();
      expect(resolved.benchmark).toBeNull();
      expect(resolved.mapId).toBe("vn-hangxanh");
      expect(resolved.net).toMatchObject({ sub: "acc_1", team: 2, matchId: "m_1", avatar: "soldier", debugHitboxes: false, zoneTimeScale: 1 });
      expect(resolved.net!.endpoint.wsUrl).toBe("wss://play.example.com/gs/7400/m/m_1");
      expect(resolved.net!.tokens).toBe(tokens);
      resolved.net!.onExit?.({ matchId: "m_1", reason: "ended" });
    }
    expect(exits).toHaveLength(2);
  });

  it("practice launch: bots on its map (Map v1 by default) in production", () => {
    const options = readOfflineMatchOptions("?bots=1&players=16&mode=squad&difficulty=hard&map=vn-hangxanh", false);
    const resolved = resolveLaunch({ kind: "practice", options, mapId: "vn-hangxanh" }, "", false, readOfflineMatchOptions);
    expect(resolved).toMatchObject({ net: null, mapId: "vn-hangxanh", benchmark: null });
    expect(resolved.practice).toMatchObject({ enabled: true, maxPlayers: 16, teamMode: "squad", difficulty: "hard" });
    expect(resolveLaunch({ kind: "practice", options, mapId: "" }, "", false, readOfflineMatchOptions).mapId).toBe("v1");
  });

  it("dev launch in production ignores URL flags (the arena, offline)", () => {
    expect(resolveLaunch(DEV, "?net=ws://localhost:7350&bots=1&map=v1&bench=v1", false, readOfflineMatchOptions)).toEqual({ net: null, practice: null, mapId: null, benchmark: null });
  });

  it("DEV flags: bench implies v1, bots implies v1 unless map is set, net runs its map (arena by default)", () => {
    expect(resolveLaunch(DEV, "", true, readOfflineMatchOptions)).toEqual({ net: null, practice: null, mapId: null, benchmark: null });
    expect(resolveLaunch(DEV, "?map=vn-phandangluu", true, readOfflineMatchOptions)).toMatchObject({ net: null, practice: null, mapId: "vn-phandangluu" });
    expect(resolveLaunch(DEV, "?bench=v1&bots=1&net=ws://x", true, readOfflineMatchOptions)).toMatchObject({ net: null, practice: null, mapId: "v1", benchmark: "v1" });
    const bots = resolveLaunch(DEV, "?bots=1&difficulty=easy", true, readOfflineMatchOptions);
    expect(bots.mapId).toBe("v1");
    expect(bots.practice).toMatchObject({ enabled: true, difficulty: "easy" });
    expect(resolveLaunch(DEV, "?bots=1&map=vn-hangxanh", true, readOfflineMatchOptions).mapId).toBe("vn-hangxanh");
    const net = resolveLaunch(DEV, "?net=ws://localhost:7350&team=1&netId=alice&bots=1", true, readOfflineMatchOptions);
    expect(net).toMatchObject({ practice: null, mapId: null, benchmark: null });
    expect(net.net).toMatchObject({ sub: "alice", team: 1, tokens: null });
    expect(resolveLaunch(DEV, "?net=ws://localhost:7350&map=v1", true, readOfflineMatchOptions).mapId).toBe("v1");
  });

  it("a standalone level keeps the level and drops the bots flag (no nav grid on a LevelData)", () => {
    const maze = resolveDev("?map=maze&bots=1&difficulty=hard");
    expect(maze.resolved).toMatchObject({ net: null, practice: null, mapId: "maze", benchmark: null });
    expect(maze.warnings).toEqual(['[map] bots need a full map; ignoring bots=1 on level "maze"']);
    // The arena is a level too, so `?map=arena&bots=1` is the same trap.
    expect(resolveDev("?map=arena&bots=1").resolved.practice).toBeNull();

    // Unchanged: bots with no map imply Map v1, and an explicit real map still runs a bot match.
    const v1 = resolveDev("?bots=1&difficulty=easy");
    expect(v1.resolved.mapId).toBe("v1");
    expect(v1.resolved.practice).toMatchObject({ enabled: true, difficulty: "easy" });
    expect(v1.warnings).toEqual([]);
    const explicit = resolveDev("?map=v1&bots=1");
    expect(explicit.resolved.mapId).toBe("v1");
    expect(explicit.resolved.practice).toMatchObject({ enabled: true });
    expect(explicit.warnings).toEqual([]);

    // The level on its own is exactly what it was: no match, no warning.
    const alone = resolveDev("?map=maze");
    expect(alone.resolved).toMatchObject({ net: null, practice: null, mapId: "maze", benchmark: null });
    expect(alone.warnings).toEqual([]);
  });

  it("a networked session ignores a standalone level map id (the server would simulate the arena)", () => {
    const net = resolveDev("?net=ws://localhost:7350/m/local&map=maze");
    expect(net.resolved.mapId).toBeNull();
    expect(net.resolved.net).not.toBeNull();
    expect(net.warnings).toEqual([`[map] a networked match runs the server's map; ignoring level "maze" and loading the arena`]);

    // The arena is what Game reports anyway, and a real map is the server's map: both pass through unwarned.
    expect(resolveDev("?net=ws://localhost:7350/m/local&map=arena")).toMatchObject({ resolved: { mapId: "arena" }, warnings: [] });
    expect(resolveDev("?net=ws://localhost:7350/m/local&map=v1")).toMatchObject({ resolved: { mapId: "v1" }, warnings: [] });

    // From the front door the match's map wins the same way.
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.join(" ")));
    const launch: GameLaunch = { kind: "net", wsUrl: "ws://h:1/m/m_1", accountId: "acc_1", teamId: 0, mapId: "maze", matchId: "m_1", tokens };
    expect(resolveLaunch(launch, "", true, readOfflineMatchOptions).mapId).toBeNull();
    warn.mockRestore();
    expect(warnings).toHaveLength(1);
  });

  it("?net= flags: endpoint and dev token URL, team range, avatar, hitbox debug, zone scale hint", () => {
    const config = readNetConfig(new URLSearchParams("net=localhost:7350&team=19&netId=bob&netAvatar=capsule&debug=hitboxes,other&zoneScale=0.25"))!;
    expect(config.endpoint).toEqual({ wsUrl: "ws://localhost:7350/m/local", tokenUrl: "http://localhost:7350/dev/token" });
    expect(config).toMatchObject({ sub: "bob", team: 19, avatar: "capsule", debugHitboxes: true, zoneTimeScale: 0.25 });
    expect(readNetConfig(new URLSearchParams("net=ws://h:1/m/x&team=20&zoneScale=50"))).toMatchObject({ team: 0, zoneTimeScale: 1, avatar: "soldier" });
    expect(readNetConfig(new URLSearchParams("team=1"))).toBeNull();
  });
});
