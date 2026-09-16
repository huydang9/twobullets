import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_MANIFEST } from "../../src/audio/audioManifest";
import { MatchEndCue, type MatchEndMusicSink } from "../../src/audio/matchEndCue";

function setup() {
  const calls: string[] = [];
  const sink: MatchEndMusicSink = {
    playMatchEndMusic: () => calls.push("play"),
    stopMatchEndMusic: () => calls.push("stop"),
  };
  const deferred: (() => void)[] = [];
  const cue = new MatchEndCue(
    () => sink,
    (run) => deferred.push(run),
  );
  const flush = () => deferred.splice(0).forEach((run) => run());
  return { calls, cue, flush };
}

describe("MatchEndCue", () => {
  afterEach(() => vi.unstubAllGlobals());

  const death = {};
  const result = {};

  it("plays once per match and stops when the owning screen hides", () => {
    const { calls, cue, flush } = setup();
    cue.show(result);
    cue.hide(result);
    flush();
    cue.show(result); // Enter re-opens the results: no replay
    cue.hide(result);
    flush();
    expect(calls).toEqual(["play", "stop"]);
    expect(cue.hasPlayed).toBe(true);
  });

  it("hands the clip from the death screen to the result screen without cutting it", () => {
    const { calls, cue, flush } = setup();
    cue.show(death);
    cue.hide(death); // showResult hides the death screen…
    cue.show(result); // …and shows the results in the same task
    flush();
    expect(calls).toEqual(["play"]);
    cue.hide(result);
    flush();
    expect(calls).toEqual(["play", "stop"]);
  });

  it("ignores hides of screens that don't own the clip", () => {
    const { calls, cue, flush } = setup();
    cue.hide(death);
    cue.show(result);
    cue.hide(death);
    flush();
    expect(calls).toEqual(["play"]);
  });

  it("spectating after the placement screen stops it, and the later result screen stays silent", () => {
    const { calls, cue, flush } = setup();
    cue.show(death);
    cue.hide(death);
    flush();
    cue.show(result);
    flush();
    expect(calls).toEqual(["play", "stop"]);
  });

  it("default-constructed cue calls queueMicrotask with a global receiver (browsers throw Illegal invocation)", async () => {
    const native = globalThis.queueMicrotask;
    vi.stubGlobal("queueMicrotask", function (this: unknown, run: () => void) {
      if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
      native(run);
    });
    const cue = new MatchEndCue();
    expect(() => {
      cue.show(result);
      cue.hide(result);
    }).not.toThrow();
    await Promise.resolve();
  });

  it("a new match silences the previous clip", () => {
    const calls: string[] = [];
    MatchEndCue.newMatch({ playMatchEndMusic: () => calls.push("play"), stopMatchEndMusic: () => calls.push("stop") });
    expect(calls).toEqual(["stop"]);
  });
});

describe("owner-supplied clips in the manifest", () => {
  it("results clip is stereo and lazy; the frag-out shout is mono and eager", () => {
    expect(AUDIO_MANIFEST["music.matchEnd"]).toMatchObject({ channels: 2, load: "lazy" });
    expect(AUDIO_MANIFEST["voice.fragOut"]).toMatchObject({ channels: 1, load: "eager" });
  });
});
