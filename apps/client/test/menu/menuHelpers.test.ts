import { describe, expect, it } from "vitest";
import { creditLinesFrom } from "../../src/menu/credits";
import { menuSearch, netLaunchSearch, practiceSearch, shouldShowMenu } from "../../src/menu/launch";
import { unavailableNetworkMaps } from "../../src/menu/maps";
import { DEFAULT_PREFERENCES, parsePreferences } from "../../src/menu/preferences";
import { errorMessageKey, normalizeLobbyCode, normalizeNickname } from "../../src/menu/validation";
import { readOfflineMatchOptions } from "../../src/match/options";
import { vi as viCatalog } from "../../src/i18n/vi";
import { ACCOUNT } from "../platform/fakes";
import { catalog } from "./fixtures";

describe("menu entry and launch URLs", () => {
  it("shows the menu only without game flags", () => {
    expect(shouldShowMenu("")).toBe(true);
    expect(shouldShowMenu("?lang=en")).toBe(true);
    for (const flags of ["?map=v1", "?bots=1", "?net=ws://localhost:7350", "?bench=v1", "?teammate=1", "?quality=high&lang=vi"]) expect(shouldShowMenu(flags)).toBe(false);
  });

  it("offline practice reloads with the flags the offline match reads", () => {
    const search = practiceSearch("?lang=en&foo=1", { difficulty: "hard", mode: "squad", players: 16, mapId: "cz-holasovice" });
    expect(search).toBe("?bots=1&players=16&mode=squad&difficulty=hard&map=cz-holasovice&lang=en");
    const options = readOfflineMatchOptions(search, true);
    expect(options).toMatchObject({ enabled: true, difficulty: "hard", teamMode: "squad", maxPlayers: 16, teams: 4 });
  });

  it("networked launch flags carry the join URL, account, team and map; back to menu keeps only lang", () => {
    const join = { wsUrl: "ws://localhost:7400/m/m_1", joinToken: "J", expiresAt: 0, matchId: "m_1", teamId: 3, reconnect: false };
    const params = new URLSearchParams(netLaunchSearch("?lang=vi", { join, mapId: "v1", account: ACCOUNT, tokens: async () => ({ token: "J", matchId: "m_1", url: join.wsUrl, expiresAt: 0 }) }));
    expect(Object.fromEntries(params)).toEqual({ net: join.wsUrl, netId: ACCOUNT.id, team: "3", map: "v1", lang: "vi" });
    expect(menuSearch("?net=x&lang=en")).toBe("?lang=en");
    expect(menuSearch("?net=x")).toBe("");
  });
});

describe("menu validation", () => {
  it("normalizes nicknames like server-api", () => {
    expect(normalizeNickname("  Huy   Đặng ")).toBe("Huy Đặng");
    expect(normalizeNickname("ab")).toBeNull();
    expect(normalizeNickname("a".repeat(17))).toBeNull();
    expect(normalizeNickname("bad<name>")).toBeNull();
    expect(normalizeNickname("Người_chơi-1.")).toBe("Người_chơi-1.");
  });

  it("accepts 6-character lobby codes from the code alphabet", () => {
    expect(normalizeLobbyCode(" abcdef ")).toBe("ABCDEF");
    expect(normalizeLobbyCode("ABCDE")).toBeNull();
    expect(normalizeLobbyCode("ABCDE0")).toBeNull(); // no 0/O/1/I
  });

  it("has a message for every error code", () => {
    for (const code of ["badRequest", "unauthorized", "forbidden", "notFound", "conflict", "rateLimited", "upgradeRequired", "noCapacity", "inviteRequired", "nicknameInvalid", "lobbyFull", "lobbyClosed", "alreadyInMatch", "internal", "network", "badResponse"] as const) {
      expect(viCatalog[errorMessageKey(code)], code).toBeTruthy();
    }
    expect(viCatalog["error.upgradeRequired"]).toBe("Có bản cập nhật mới, tải lại trang");
  });
});

describe("menu data", () => {
  it("marks maps the server can't run as unavailable", () => {
    const all = [{ id: "v1" }, { id: "cz-holasovice" }, { id: "vn-camthanh" }];
    expect([...unavailableNetworkMaps(catalog, all)].sort()).toEqual(["cz-holasovice", "vn-camthanh"]);
    expect([...unavailableNetworkMaps(null, all)].sort()).toEqual(["cz-holasovice", "vn-camthanh"]);
  });

  it("parses stored preferences defensively", () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("{bad json")).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(JSON.stringify({ mode: "squad", players: 99, practiceDifficulty: "insane", mapId: "../x" }))).toMatchObject({ mode: "squad", players: 20, practiceDifficulty: "normal", mapId: "v1" });
  });

  it("reads every credits file shape", () => {
    expect(creditLinesFrom({ credits: [{ title: "fps carbine", author: "DJMaesen", license: "CC BY 4.0", url: "https://s/1" }] })).toEqual(["fps carbine by DJMaesen (CC BY 4.0) — https://s/1"]);
    expect(creditLinesFrom({ sources: [{ title: "Sounds", authors: ["A", "B"], license: "CC0", url: "https://s/2" }] })).toEqual(["Sounds by A, B (CC0) — https://s/2"]);
    expect(creditLinesFrom({ assets: [{ name: "Forest Ground", authors: [{ name: "Rob" }], license: "CC0", url: "https://s/3" }] })).toEqual(["Forest Ground by Rob (CC0) — https://s/3"]);
    expect(creditLinesFrom(null)).toEqual([]);
  });
});
