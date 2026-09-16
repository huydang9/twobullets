import { MatchCommandCode, MatchCommandStatus } from "@twobullets/protocol/messages/control";
import { describe, expect, it } from "vitest";
import { setLanguage, t, type MessageKey } from "../../src/i18n";
import { commandRefusalKey, pauseOptions } from "../../src/ui/match/pauseOptions";

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

  it("practice offers play again and quitting to the menu, never ending for everyone", () => {
    const options = pauseOptions({ kind: "practice", isHost: true });
    expect(options.map((o) => o.id)).toEqual(["playAgain", "quitToMenu"]);
    expect(options.some((o) => o.confirm)).toBe(false);
  });

  it("every label is translated in Vietnamese and English (no hardcoded strings)", () => {
    const keys = [...keysOf(pauseOptions({ kind: "net", isHost: true, warmup: true })), ...keysOf(pauseOptions({ kind: "practice" })), "pause.title", "pause.resume", "pause.cancel", "pause.escHint"] as MessageKey[];
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
