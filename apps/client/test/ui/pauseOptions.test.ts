import { MatchCommandCode, MatchCommandStatus } from "@twobullets/protocol/messages/control";
import { describe, expect, it } from "vitest";
import { setLanguage, t, type MessageKey } from "../../src/i18n";
import { commandRefusalKey, deathQuitOptions, pauseOptions } from "../../src/ui/match/pauseOptions";

// What the pause menu offers (ui/match/pauseOptions.ts), and that every key it names exists in both catalogs.

const keysOf = (options: ReturnType<typeof pauseOptions>): MessageKey[] =>
  options.flatMap((o) => [o.labelKey, ...(o.hintKey ? [o.hintKey] : []), ...(o.confirm ? [o.confirm.titleKey, o.confirm.bodyKey, o.confirm.confirmKey] : [])]);

describe("pause menu options", () => {
  it("a networked match offers leaving alone; only the host can end it for everyone", () => {
    const guest = pauseOptions({ kind: "net", isHost: false });
    expect(guest.map((o) => o.id)).toEqual(["leaveAlone"]);
    const host = pauseOptions({ kind: "net", isHost: true });
    expect(host.map((o) => o.id)).toEqual(["leaveAlone", "endForAll"]);
    // The destructive one is marked and asks first, with an explanation.
    const end = host[1]!;
    expect(end.danger).toBe(true);
    expect(end.confirm).toBeDefined();
    expect(t(end.confirm!.bodyKey).length).toBeGreaterThan(20);
    // No host at all (quick play): nobody sees the button.
    expect(pauseOptions({ kind: "net" }).map((o) => o.id)).toEqual(["leaveAlone"]);
  });

  it("explains what leaving costs, and that warmup is free", () => {
    expect(pauseOptions({ kind: "net", warmup: false })[0]!.hintKey).toBe("pause.leaveAloneHint");
    expect(pauseOptions({ kind: "net", warmup: true })[0]!.hintKey).toBe("pause.leaveWarmupHint");
  });

  it("a dead player still gets out, and the host can still end it for everyone", () => {
    const dead = pauseOptions({ kind: "net", dead: true });
    expect(dead.map((o) => o.id)).toEqual(["leaveAlone"]);
    expect(dead[0]!.hintKey).toBe("pause.leaveDeadHint");
    expect(pauseOptions({ kind: "net", dead: true, isHost: true }).map((o) => o.id)).toEqual(["leaveAlone", "endForAll"]);
    // Being dead is not warmup: the "you only give up your slot" line must not appear.
    expect(pauseOptions({ kind: "net", dead: true, warmup: true })[0]!.hintKey).toBe("pause.leaveDeadHint");
  });

  it("once the match is over there is nothing to leave or end, only the results", () => {
    expect(pauseOptions({ kind: "net", ended: true, isHost: true, dead: true }).map((o) => o.id)).toEqual(["seeResults"]);
    // Practice keeps its own two, which already work from the result screen.
    expect(pauseOptions({ kind: "practice", ended: true }).map((o) => o.id)).toEqual(["playAgain", "quitToMenu"]);
  });

  it("the death and spectate screens carry their own quit buttons (host's end-for-all still asks first)", () => {
    expect(deathQuitOptions({ kind: "net" }).map((o) => o.id)).toEqual(["leaveAlone"]);
    expect(deathQuitOptions({ kind: "net" })[0]!.labelKey).toBe("screens.leaveMatch");
    const host = deathQuitOptions({ kind: "net", isHost: true, dead: true });
    expect(host.map((o) => o.id)).toEqual(["leaveAlone", "endForAll"]);
    expect(host[1]!.confirm).toBeDefined();
    // Over, or offline: the screens already offer results / play again / back to menu.
    expect(deathQuitOptions({ kind: "net", ended: true, isHost: true })).toEqual([]);
    expect(deathQuitOptions({ kind: "practice", isHost: true })).toEqual([]);
  });

  it("practice offers play again and quitting to the menu, never ending for everyone", () => {
    const options = pauseOptions({ kind: "practice", isHost: true });
    expect(options.map((o) => o.id)).toEqual(["playAgain", "quitToMenu"]);
    expect(options.some((o) => o.confirm)).toBe(false);
  });

  it("every label is translated in Vietnamese and English (no hardcoded strings)", () => {
    const keys = [
      ...keysOf(pauseOptions({ kind: "net", isHost: true, warmup: true })),
      ...keysOf(pauseOptions({ kind: "net", isHost: true, dead: true })),
      ...keysOf(pauseOptions({ kind: "net", ended: true })),
      ...keysOf(pauseOptions({ kind: "practice" })),
      ...keysOf(deathQuitOptions({ kind: "net", isHost: true })),
      "pause.title",
      "pause.resume",
      "pause.backToScreen",
      "pause.cancel",
      "pause.escHint",
    ] as MessageKey[];
    for (const language of ["vi", "en"] as const) {
      setLanguage(language);
      for (const key of keys) {
        expect(t(key), `${language} ${key}`).not.toBe("");
        expect(t(key), `${language} ${key}`).not.toContain("{");
      }
    }
    setLanguage("vi");
  });

  it("turns a refused quit command into an explanation, and says nothing when it worked", () => {
    expect(commandRefusalKey({ command: MatchCommandCode.endForAll, status: MatchCommandStatus.ok, detail: 0 })).toBeNull();
    expect(commandRefusalKey({ command: MatchCommandCode.leave, status: MatchCommandStatus.denied, detail: 0 })).toBeNull();
    expect(commandRefusalKey({ command: MatchCommandCode.endForAll, status: MatchCommandStatus.denied, detail: 0 })).toBe("pause.endForAllHostOnly");
    expect(commandRefusalKey({ command: MatchCommandCode.endForAll, status: MatchCommandStatus.unavailable, detail: 0 })).toBe("pause.endForAllUnavailable");
  });
});
