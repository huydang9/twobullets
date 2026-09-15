import { MatchEndCue } from "../../audio/matchEndCue";
import { t } from "../../i18n";
import { prepareAnimation, replay } from "../anim";
import { el } from "../dom";
import { formatClock } from "./MatchHud";
import { MATCH_STRINGS } from "./strings";

const SHOW_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(-50%,10px,0)", easing: "ease-out" },
  { opacity: 1, transform: "translate3d(-50%,0,0)" },
];

export interface ScreenAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  run(): void;
}

/** One results clip per match: a match's death and result screens share their parent layer. */
const matchEndCues = new WeakMap<HTMLElement, MatchEndCue>();

function matchEndCueFor(parent: HTMLElement): MatchEndCue {
  let cue = matchEndCues.get(parent);
  if (!cue) {
    MatchEndCue.newMatch();
    cue = new MatchEndCue();
    matchEndCues.set(parent, cue);
  }
  return cue;
}

/** Centred panel with a title, lines and buttons; clicks never reach the game or the play overlay. */
class MatchScreen {
  protected readonly cue: MatchEndCue;
  protected readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly lines: HTMLDivElement;
  private readonly actions: HTMLDivElement;
  private readonly showAnim: Animation;

  constructor(parent: HTMLElement, modifier: string) {
    this.cue = matchEndCueFor(parent);
    this.root = el("div", `tb-mscreen tb-mscreen--${modifier}`, undefined, parent);
    this.root.addEventListener("click", (event) => event.stopPropagation());
    this.root.addEventListener("mousedown", (event) => event.stopPropagation());
    this.title = el("div", "tb-mscreen__title", undefined, this.root);
    this.subtitle = el("div", "tb-mscreen__subtitle", undefined, this.root);
    this.lines = el("div", "tb-mscreen__stats", undefined, this.root);
    this.actions = el("div", "tb-mscreen__actions", undefined, this.root);
    this.root.hidden = true;
    this.showAnim = prepareAnimation(this.root, SHOW_KEYFRAMES, { duration: 420, delay: 250, fill: "backwards" });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  hide(): void {
    this.root.hidden = true;
    // Leaving the screen (close, spectate, leave, exit to menu) stops the results clip it started.
    this.cue.hide(this);
  }

  /** Rare (death, match end), so the content is rebuilt. */
  protected render(title: string, subtitle: string, rows: readonly (readonly [string, string])[], actions: readonly ScreenAction[], accent = false): void {
    this.title.textContent = title;
    this.title.toggleAttribute("data-accent", accent);
    this.subtitle.textContent = subtitle;
    this.subtitle.hidden = subtitle === "";
    this.lines.replaceChildren();
    for (const [label, value] of rows) {
      const row = el("div", "tb-mscreen__row", undefined, this.lines);
      el("span", "tb-mscreen__label", label, row);
      el("span", "tb-mscreen__value", value, row);
    }
    this.actions.replaceChildren();
    for (const action of actions) {
      const button = el("button", `tb-mscreen__button${action.primary ? " tb-mscreen__button--primary" : ""}`, action.label, this.actions);
      button.type = "button";
      button.disabled = action.disabled === true;
      button.addEventListener("click", () => {
        button.blur();
        action.run();
      });
    }
    this.root.hidden = false;
    replay(this.showAnim);
  }
}

export interface DeathInfo {
  /** "Bot Kilo đã hạ gục bạn bằng AR-4 (Headshot)", "Bạn chết ngoài bo"… */
  readonly cause: string;
  /** Team placement when the team is out, else null (a teammate is still in play). */
  readonly placement: number | null;
  readonly teamCount: number;
  readonly kills: number;
  readonly damage: number;
  readonly survivedSeconds: number;
}

/** "BẠN ĐÃ BỊ HẠ GỤC": cause, placement once the team is out, kills/damage/survival, spectate and new match. */
export class DeathScreen extends MatchScreen {
  constructor(parent: HTMLElement) {
    super(parent, "death");
  }

  show(info: DeathInfo, actions: readonly ScreenAction[]): void {
    const subtitle = info.placement !== null ? t("death.placementOf", { place: info.placement, count: info.teamCount }) : MATCH_STRINGS.screens.teamStillFighting;
    this.render(t("death.title"), info.cause, statRows(info, subtitle), actions);
    // The team is out: this is the player's placement screen, so the results clip plays here (once per match).
    if (info.placement !== null) this.cue.show(this);
  }
}

export interface ResultInfo {
  readonly placement: number;
  readonly teamCount: number;
  readonly kills: number;
  readonly teamKills: number;
  readonly damage: number;
  readonly survivedSeconds: number;
  /** "Đội cuối cùng trụ lại", "Hết thời gian"… */
  readonly reason: string;
}

/** Match result: "#1 CHIẾN THẮNG!" or "HẠNG #3 / 5", kills, damage, survival time; new match. */
export class ResultScreen extends MatchScreen {
  constructor(parent: HTMLElement) {
    super(parent, "result");
  }

  show(info: ResultInfo, actions: readonly ScreenAction[]): void {
    const winner = info.placement === 1;
    const rows: (readonly [string, string])[] = [
      [t("stats.placement"), t("result.placementValue", { place: info.placement, count: info.teamCount })],
      [t("stats.kills"), String(info.kills)],
      [t("stats.teamKills"), String(info.teamKills)],
      [t("stats.damage"), String(Math.round(info.damage))],
      [t("stats.survived"), formatClock(info.survivedSeconds)],
    ];
    this.render(winner ? t("result.winner") : t("result.placement", { place: info.placement, count: info.teamCount }), info.reason, rows, actions, winner);
    this.cue.show(this);
  }
}

function statRows(info: DeathInfo, placement: string): (readonly [string, string])[] {
  return [
    [t("stats.placement"), placement],
    [t("stats.kills"), String(info.kills)],
    [t("stats.damage"), String(Math.round(info.damage))],
    [t("stats.survived"), formatClock(info.survivedSeconds)],
  ];
}
