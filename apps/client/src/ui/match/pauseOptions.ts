import { MatchCommandCode, MatchCommandStatus, type MatchCommandResult } from "@twobullets/protocol/messages/control";
import type { MessageKey } from "../../i18n";

// What the pause menu offers, as data: pure so the rules (who may end a match, what leaving costs) are unit-tested
// without a DOM. NetMatch and OfflineMatch turn the ids into the actual calls.

export type PauseOptionId = "leaveAlone" | "endForAll" | "playAgain" | "quitToMenu" | "seeResults";

export interface PauseOptionConfirmKeys {
  readonly titleKey: MessageKey;
  readonly bodyKey: MessageKey;
  readonly confirmKey: MessageKey;
}

export interface PauseOption {
  readonly id: PauseOptionId;
  readonly labelKey: MessageKey;
  readonly hintKey?: MessageKey;
  /** Destructive: drawn in the warning colour and confirmed first. */
  readonly danger?: boolean;
  readonly confirm?: PauseOptionConfirmKeys;
}

export interface PauseContext {
  /** `net`: a match on a server. `practice`: the offline bot match, where "end for everyone" is meaningless. */
  readonly kind: "net" | "practice";
  /** Net: this player holds the roster's host bit, so the server accepts `endForAll` from them. */
  readonly isHost?: boolean;
  /** Net: the match has not started, so leaving gives up the slot instead of counting as an elimination. */
  readonly warmup?: boolean;
  /** The player is eliminated: the death or spectate screen is what they are looking at, and leaving costs nothing more. */
  readonly dead?: boolean;
  /** The match is over; the only way on is the results. */
  readonly ended?: boolean;
}

const END_FOR_ALL: PauseOption = {
  id: "endForAll",
  labelKey: "pause.endForAll",
  danger: true,
  confirm: { titleKey: "pause.endForAllTitle", bodyKey: "pause.endForAllBody", confirmKey: "pause.endForAllConfirm" },
};

/**
 * The buttons under "Resume", in order. The menu opens over the death and spectate screens too (a dead player must
 * always be able to get out), so `dead` only changes what leaving is said to cost.
 */
export function pauseOptions(context: PauseContext): PauseOption[] {
  if (context.kind === "practice") {
    return [
      { id: "playAgain", labelKey: "pause.playAgain", hintKey: "pause.playAgainHint" },
      { id: "quitToMenu", labelKey: "pause.quitToMenu" },
    ];
  }
  // Over: nothing is left to leave or end, so the only way on is the front door's results.
  if (context.ended === true) return [{ id: "seeResults", labelKey: "pause.seeResults", hintKey: "pause.seeResultsHint" }];
  const hintKey = context.dead === true ? "pause.leaveDeadHint" : context.warmup === true ? "pause.leaveWarmupHint" : "pause.leaveAloneHint";
  const options: PauseOption[] = [{ id: "leaveAlone", labelKey: "pause.leaveAlone", hintKey }];
  // Quick-play matches have no host, so nobody sees this button.
  if (context.isHost === true) options.push(END_FOR_ALL);
  return options;
}

/**
 * The quit buttons the death and spectate screens carry next to "Spectate", so an eliminated player never has to guess
 * that Esc opens the pause menu. `endForAll` is destructive, so the owner opens the pause menu on its confirm step.
 */
export function deathQuitOptions(context: PauseContext): PauseOption[] {
  if (context.kind !== "net" || context.ended === true) return [];
  const options: PauseOption[] = [{ id: "leaveAlone", labelKey: "screens.leaveMatch" }];
  if (context.isHost === true) options.push(END_FOR_ALL);
  return options;
}

/** Message key explaining a refused quit command, or null when nothing needs saying. */
export function commandRefusalKey(result: MatchCommandResult): MessageKey | null {
  if (result.status === MatchCommandStatus.ok || result.command !== MatchCommandCode.endForAll) return null;
  return result.status === MatchCommandStatus.denied ? "pause.endForAllHostOnly" : "pause.endForAllUnavailable";
}
