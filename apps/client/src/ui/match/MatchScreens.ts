import { prepareAnimation, replay } from "../anim";
import { el } from "../dom";
import { formatClock } from "./MatchHud";

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

/** Centred panel with a title, lines and buttons; clicks never reach the game or the play overlay. */
class MatchScreen {
  protected readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly subtitle: HTMLDivElement;
  private readonly lines: HTMLDivElement;
  private readonly actions: HTMLDivElement;
  private readonly showAnim: Animation;

  constructor(parent: HTMLElement, modifier: string) {
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
  /** "Bot Kilo killed you with AR-4 (Headshot)", "You died to the zone"… */
  readonly cause: string;
  /** Team placement when the team is out, else null (a teammate is still in play). */
  readonly placement: number | null;
  readonly teamCount: number;
  readonly kills: number;
  readonly damage: number;
  readonly survivedSeconds: number;
}

/** "YOU WERE KILLED": cause, placement once the team is out, kills/damage/survival, spectate and new match. */
export class DeathScreen extends MatchScreen {
  constructor(parent: HTMLElement) {
    super(parent, "death");
  }

  show(info: DeathInfo, actions: readonly ScreenAction[]): void {
    const subtitle = info.placement !== null ? `#${info.placement} of ${info.teamCount}` : "Your teammate is still in the fight";
    this.render("YOU WERE KILLED", info.cause, statRows(info, subtitle), actions);
  }
}

export interface ResultInfo {
  readonly placement: number;
  readonly teamCount: number;
  readonly kills: number;
  readonly teamKills: number;
  readonly damage: number;
  readonly survivedSeconds: number;
  /** "Last team standing", "Time limit"… */
  readonly reason: string;
}

/** Match result: "#1 WINNER" or "#3 of 5", kills, damage, survival time; new match. */
export class ResultScreen extends MatchScreen {
  constructor(parent: HTMLElement) {
    super(parent, "result");
  }

  show(info: ResultInfo, actions: readonly ScreenAction[]): void {
    const winner = info.placement === 1;
    const rows: (readonly [string, string])[] = [
      ["Placement", `#${info.placement} / ${info.teamCount}`],
      ["Kills", String(info.kills)],
      ["Team kills", String(info.teamKills)],
      ["Damage dealt", String(Math.round(info.damage))],
      ["Survived", formatClock(info.survivedSeconds)],
    ];
    this.render(winner ? "#1 WINNER" : `#${info.placement} OF ${info.teamCount}`, info.reason, rows, actions, winner);
  }
}

function statRows(info: DeathInfo, placement: string): (readonly [string, string])[] {
  return [
    ["Placement", placement],
    ["Kills", String(info.kills)],
    ["Damage dealt", String(Math.round(info.damage))],
    ["Survived", formatClock(info.survivedSeconds)],
  ];
}
