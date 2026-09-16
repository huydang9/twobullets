import { describe, expect, it } from "vitest";
import { readNetConfig, resolveLaunch, type GameLaunch } from "../../src/game/launch";
import { readOfflineMatchOptions } from "../../src/match/options";

const tokens = async () => ({ token: "J", matchId: "m_1", url: "ws://localhost:7400/m/m_1", expiresAt: 0 });
const DEV: GameLaunch = { kind: "dev" };

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

  it("?net= flags: endpoint and dev token URL, team range, avatar, hitbox debug, zone scale hint", () => {
    const config = readNetConfig(new URLSearchParams("net=localhost:7350&team=19&netId=bob&netAvatar=capsule&debug=hitboxes,other&zoneScale=0.25"))!;
    expect(config.endpoint).toEqual({ wsUrl: "ws://localhost:7350/m/local", tokenUrl: "http://localhost:7350/dev/token" });
    expect(config).toMatchObject({ sub: "bob", team: 19, avatar: "capsule", debugHitboxes: true, zoneTimeScale: 0.25 });
    expect(readNetConfig(new URLSearchParams("net=ws://h:1/m/x&team=20&zoneScale=50"))).toMatchObject({ team: 0, zoneTimeScale: 1, avatar: "soldier" });
    expect(readNetConfig(new URLSearchParams("team=1"))).toBeNull();
  });
});
