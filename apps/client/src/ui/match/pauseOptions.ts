import { MatchCommandCode, MatchCommandStatus, type MatchCommandResult } from "@twobullets/protocol/messages/control";
import type { MessageKey } from "../../i18n";

// What the pause menu offers, as data: pure so the rules (who may end a match, what leaving costs) are unit-tested
// without a DOM. NetMatch and OfflineMatch turn the ids into the actual calls.

export type PauseOptionId = "leaveAlone" | "endForAll" | "playAgain" | "quitToMenu";

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
}

const END_FOR_ALL: PauseOption = {
  id: "endForAll",
  labelKey: "pause.endForAll",
  danger: true,
  confirm: { titleKey: "pause.endForAllTitle", bodyKey: "pause.endForAllBody", confirmKey: "pause.endForAllConfirm" },
};

/** The buttons under "Resume", in order. */
export function pauseOptions(context: PauseContext): PauseOption[] {
  if (context.kind === "practice") {
    return [
      { id: "playAgain", labelKey: "pause.playAgain", hintKey: "pause.playAgainHint" },
      { id: "quitToMenu", labelKey: "pause.quitToMenu" },
    ];
  }
  const options: PauseOption[] = [{ id: "leaveAlone", labelKey: "pause.leaveAlone", hintKey: context.warmup ? "pause.leaveWarmupHint" : "pause.leaveAloneHint" }];
  // Quick-play matches have no host, so nobody sees this button.
  if (context.isHost === true) options.push(END_FOR_ALL);
  return options;
}

/** Message key explaining a refused quit command, or null when nothing needs saying. */
export function commandRefusalKey(result: MatchCommandResult): MessageKey | null {
  if (result.status === MatchCommandStatus.ok || result.command !== MatchCommandCode.endForAll) return null;
  return result.status === MatchCommandStatus.denied ? "pause.endForAllHostOnly" : "pause.endForAllUnavailable";
}
