/**
 * UI → audio bridge for the results-screen clip. Match screens (ui/match/MatchScreens.ts) have no audio dependency,
 * so the AudioDirector registers itself as the sink and the screens drive a per-match {@link MatchEndCue}.
 * Dependency-free (no DOM, no WebAudio) so the gating is unit-testable.
 */

export interface MatchEndMusicSink {
  playMatchEndMusic(): void;
  stopMatchEndMusic(): void;
}

let activeSink: MatchEndMusicSink | null = null;

/** AudioDirector: register on creation, pass null on dispose. */
export function setMatchEndMusicSink(sink: MatchEndMusicSink | null): void {
  activeSink = sink;
}

export function matchEndMusicSink(): MatchEndMusicSink | null {
  return activeSink;
}

/**
 * One match's results clip. The first screen that shows the player's final placement plays it (once per match) and
 * owns it; it stops when that screen hides. A hide followed in the same task by another screen of the match showing
 * (death screen → result screen when the match ends) hands the clip over instead of cutting it.
 */
export class MatchEndCue {
  private played = false;
  private owner: object | null = null;
  private stopPending = false;

  constructor(
    private readonly sink: () => MatchEndMusicSink | null = matchEndMusicSink,
    private readonly defer: (run: () => void) => void = queueMicrotask,
  ) {}

  get hasPlayed(): boolean {
    return this.played;
  }

  /** A screen showing the final placement (result screen, or the death screen once the team is out). */
  show(screen: object): void {
    if (!this.played) {
      this.played = true;
      this.owner = screen;
      this.sink()?.playMatchEndMusic();
    } else if (this.stopPending) {
      this.owner = screen;
    }
  }

  /** Any screen of the match hiding; only the owner's hide stops the clip. */
  hide(screen: object): void {
    if (this.owner !== screen) return;
    this.owner = null;
    this.stopPending = true;
    this.defer(() => {
      this.stopPending = false;
      if (this.owner === null) this.sink()?.stopMatchEndMusic();
    });
  }

  /** A new match's screens exist: silence a clip left over from the previous one. */
  static newMatch(sink: MatchEndMusicSink | null = activeSink): void {
    sink?.stopMatchEndMusic();
  }
}
