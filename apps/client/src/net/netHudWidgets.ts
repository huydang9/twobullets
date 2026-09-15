import { t } from "../i18n";

// Small networked-play HUD pieces with no offline counterpart: the incoming damage direction indicator and the death /
// reviving banner. Inline styles (like NetDebugHud) so hud.css stays untouched; DOM is built once and pooled.

const INDICATOR_POOL = 6;
const INDICATOR_MS = 1400;
const INDICATOR_RADIUS_PX = 120;
const TAU = Math.PI * 2;

const INDICATOR_ROOT_STYLE = "position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:2";
const INDICATOR_ARM_STYLE = "position:absolute;left:0;top:0;width:0;height:0;opacity:0;will-change:transform,opacity";
const INDICATOR_ARC_STYLE =
  `position:absolute;left:-46px;top:-${INDICATOR_RADIUS_PX + 10}px;width:92px;height:20px;border-radius:50%/100% 100% 0 0;` +
  "background:radial-gradient(ellipse at 50% 100%,rgba(210,20,20,0) 45%,rgba(220,30,30,0.85) 70%,rgba(220,30,30,0) 100%)";

interface Arm {
  readonly node: HTMLDivElement;
  yaw: number;
  bornAt: number;
  strength: number;
  shown: boolean;
}

function wrap(a: number): number {
  let d = (a + Math.PI) % TAU;
  if (d < 0) d += TAU;
  return d - Math.PI;
}

/**
 * PUBG-style red arcs around the crosshair pointing at where damage came from (world yaw, MoveInput convention),
 * re-aimed every frame against the camera yaw while they fade.
 */
export class DamageDirectionIndicator {
  private readonly root: HTMLDivElement;
  private readonly arms: Arm[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.style.cssText = INDICATOR_ROOT_STYLE;
    parent.appendChild(this.root);
    for (let i = 0; i < INDICATOR_POOL; i++) {
      const node = document.createElement("div");
      node.style.cssText = INDICATOR_ARM_STYLE;
      const arc = document.createElement("div");
      arc.style.cssText = INDICATOR_ARC_STYLE;
      node.appendChild(arc);
      this.root.appendChild(node);
      this.arms.push({ node, yaw: 0, bornAt: -Infinity, strength: 0, shown: false });
    }
  }

  /** `yaw`: world direction from the player toward the damage source. Hits from one direction refresh one arc. */
  show(yaw: number, amount: number, now: number): void {
    let arm: Arm | null = null;
    for (const candidate of this.arms) {
      if (now - candidate.bornAt < INDICATOR_MS && Math.abs(wrap(candidate.yaw - yaw)) < 0.35) {
        arm = candidate;
        break;
      }
    }
    if (arm === null) {
      arm = this.arms[0]!;
      for (const candidate of this.arms) if (candidate.bornAt < arm.bornAt) arm = candidate;
    }
    arm.yaw = yaw;
    arm.bornAt = now;
    arm.strength = Math.min(1, 0.45 + amount / 40);
  }

  /** Per frame: `cameraYaw` in the same convention. */
  update(now: number, cameraYaw: number): void {
    for (const arm of this.arms) {
      const age = now - arm.bornAt;
      if (age >= INDICATOR_MS) {
        if (arm.shown) {
          arm.shown = false;
          arm.node.style.opacity = "0";
        }
        continue;
      }
      arm.shown = true;
      const fade = 1 - age / INDICATOR_MS;
      arm.node.style.opacity = (arm.strength * fade * fade).toFixed(3);
      arm.node.style.transform = `rotate(${wrap(arm.yaw - cameraYaw).toFixed(4)}rad)`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

const BANNER_STYLE =
  "position:absolute;left:50%;top:30%;transform:translateX(-50%);min-width:280px;padding:14px 22px;text-align:center;" +
  "background:rgba(10,10,10,0.62);color:#eee;font:600 13px/1.5 system-ui,sans-serif;letter-spacing:0.04em;pointer-events:none;z-index:3";
const TITLE_STYLE = "font-size:22px;font-weight:700;letter-spacing:0.08em;color:#ff5a4a;margin-bottom:4px";

/** Centre banner while dead ("BẠN ĐÃ BỊ HẠ GỤC", cause, respawn countdown) or while reviving a teammate. */
export class NetLifeBanner {
  private readonly root: HTMLDivElement;
  private readonly title: Text;
  private readonly line: Text;
  private readonly detail: Text;
  private respawnAt = 0;
  private mode: "hidden" | "dead" | "reviving" = "hidden";

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.style.cssText = BANNER_STYLE;
    const title = document.createElement("div");
    title.style.cssText = TITLE_STYLE;
    this.title = title.appendChild(document.createTextNode(""));
    const line = document.createElement("div");
    this.line = line.appendChild(document.createTextNode(""));
    const detail = document.createElement("div");
    detail.style.cssText = "opacity:0.7;font-weight:500";
    this.detail = detail.appendChild(document.createTextNode(""));
    this.root.append(title, line, detail);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  get dead(): boolean {
    return this.mode === "dead";
  }

  showDeath(cause: string, respawnSeconds: number, now: number): void {
    this.mode = "dead";
    this.respawnAt = now + respawnSeconds * 1000;
    this.title.data = t("death.title");
    this.line.data = cause;
    this.root.hidden = false;
  }

  /** Local estimate while interact is held next to a downed teammate (the server doesn't report reviver progress). */
  showReviving(progress: number, name: string): void {
    if (this.mode === "dead") return;
    this.mode = "reviving";
    this.title.data = t("net.reviving");
    this.line.data = name;
    this.detail.data = `${Math.min(100, Math.round(progress * 100))}%`;
    this.root.hidden = false;
  }

  hide(): void {
    this.mode = "hidden";
    this.root.hidden = true;
  }

  hideReviving(): void {
    if (this.mode === "reviving") this.hide();
  }

  update(now: number): void {
    if (this.mode !== "dead") return;
    const left = Math.max(0, Math.ceil((this.respawnAt - now) / 1000));
    const text = left > 0 ? t("net.spectatingRespawn", { seconds: left }) : t("net.respawning");
    if (this.detail.data !== text) this.detail.data = text;
  }

  dispose(): void {
    this.root.remove();
  }
}
