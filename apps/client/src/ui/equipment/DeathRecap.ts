import { prepareAnimation, replay, setText } from "../anim";
import { t, type MessageKey } from "../../i18n";
import { el, elT, textNode } from "../dom";

export interface DeathRecapInfo {
  /** "Vụ nổ", "Bị thiêu cháy", "Rơi từ trên cao"… */
  readonly cause: string;
  /** "Chính bạn", "Lính 3", or null for the world. */
  readonly killer: string | null;
  readonly weapon: string | null;
  /** Killer or blast distance, m. */
  readonly distance: number | null;
  readonly damageTaken: number;
  readonly hits: number;
  /** performance.now() of the (offline) respawn, or null when there is none. */
  readonly respawnAt: number | null;
}

const SHOW_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translate3d(-50%,8px,0)", easing: "ease-out" },
  { opacity: 1, transform: "translate3d(-50%,0,0)" },
];

/** Elimination panel: cause, killer, weapon, distance, damage taken this life and the offline respawn countdown. */
export class DeathRecap {
  private readonly root: HTMLDivElement;
  private readonly cause: Text;
  private readonly killer: Text;
  private readonly weapon: Text;
  private readonly distance: Text;
  private readonly damage: Text;
  private readonly respawnRow: HTMLDivElement;
  private readonly respawn: Text;
  private readonly rows: Readonly<Record<"killer" | "weapon" | "distance", HTMLDivElement>>;
  private readonly showAnim: Animation;
  private respawnAt: number | null = null;
  private shownSeconds = -1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "tb-death", undefined, parent);
    elT("div", "tb-death__title", "recap.title", this.root);
    this.cause = textNode(el("div", "tb-death__cause", undefined, this.root));
    const stats = el("div", "tb-death__stats", undefined, this.root);
    const row = (label: MessageKey): [HTMLDivElement, Text] => {
      const node = el("div", "tb-death__row", undefined, stats);
      elT("span", "tb-death__label", label, node);
      return [node, textNode(el("span", "tb-death__value", undefined, node))];
    };
    const [killerRow, killer] = row("recap.killedBy");
    const [weaponRow, weapon] = row("recap.weapon");
    const [distanceRow, distance] = row("recap.distance");
    this.damage = row("recap.damageTaken")[1];
    this.killer = killer;
    this.weapon = weapon;
    this.distance = distance;
    this.rows = { killer: killerRow, weapon: weaponRow, distance: distanceRow };
    this.respawnRow = el("div", "tb-death__respawn", undefined, this.root);
    this.respawn = textNode(this.respawnRow);
    this.root.hidden = true;
    this.showAnim = prepareAnimation(this.root, SHOW_KEYFRAMES, { duration: 450, delay: 350, fill: "backwards" });
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(info: DeathRecapInfo): void {
    setText(this.cause, info.cause);
    this.rows.killer.hidden = info.killer === null;
    setText(this.killer, info.killer ?? "");
    this.rows.weapon.hidden = info.weapon === null;
    setText(this.weapon, info.weapon ?? "");
    this.rows.distance.hidden = info.distance === null;
    setText(this.distance, info.distance === null ? "" : t("common.meters", { m: Math.round(info.distance) }));
    setText(this.damage, t("recap.damageValue", { damage: Math.round(info.damageTaken), count: info.hits }));
    this.respawnAt = info.respawnAt;
    this.respawnRow.hidden = info.respawnAt === null;
    this.shownSeconds = -1;
    this.root.hidden = false;
    replay(this.showAnim);
  }

  hide(): void {
    this.root.hidden = true;
    this.respawnAt = null;
  }

  update(now: number): void {
    if (this.root.hidden || this.respawnAt === null) return;
    const seconds = Math.max(0, Math.ceil((this.respawnAt - now) / 1000));
    if (seconds === this.shownSeconds) return;
    this.shownSeconds = seconds;
    setText(this.respawn, t("recap.respawnIn", { seconds }));
  }
}
