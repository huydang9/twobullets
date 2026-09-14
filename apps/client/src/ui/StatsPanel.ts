import type { PlayerDebugState } from "@twobullets/shared";
import { el } from "./dom";

const REFRESH_INTERVAL_MS = 100;

type FpsTier = "good" | "ok" | "bad";

/** Throttled debug readout. DOM is built once; only changed `textContent` is written. */
export class StatsPanel {
  private readonly node: HTMLDivElement;
  private readonly fps: Text;
  private readonly position: Text;
  private readonly hSpeed: Text;
  private readonly vSpeed: Text;
  private readonly grounded: Text;
  private readonly stance: Text;
  private readonly sprinting: Text;
  private readonly fpsCell: HTMLElement;
  private fpsTier: FpsTier | undefined;
  private lastRefresh = -Infinity;

  constructor(parent: HTMLElement, visible: boolean) {
    this.node = el("div", "tb-stats", undefined, parent);
    this.fps = this.row("FPS");
    this.fpsCell = this.fps.parentElement!;
    this.position = this.row("POS");
    this.hSpeed = this.row("H-SPD");
    this.vSpeed = this.row("V-SPD");
    this.grounded = this.row("GROUND");
    this.stance = this.row("STANCE");
    this.sprinting = this.row("SPRINT");
    this.visible = visible;
  }

  get visible(): boolean {
    return !this.node.hidden;
  }

  set visible(visible: boolean) {
    this.node.hidden = !visible;
    // Refresh on the very next update rather than showing stale values for up to one interval.
    if (visible) this.lastRefresh = -Infinity;
  }

  update(fps: number, player: PlayerDebugState): void {
    if (this.node.hidden) return;
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_INTERVAL_MS) return;
    this.lastRefresh = now;

    const [x, y, z] = player.position;
    set(this.fps, Math.round(fps).toString());
    set(this.position, `${x.toFixed(1)}  ${y.toFixed(1)}  ${z.toFixed(1)}`);
    set(this.hSpeed, `${player.horizontalSpeed.toFixed(2)} m/s`);
    set(this.vSpeed, `${player.verticalSpeed.toFixed(2)} m/s`);
    set(this.grounded, player.grounded ? "YES" : "NO");
    set(this.stance, player.stance.toUpperCase());
    set(this.sprinting, player.sprinting ? "YES" : "NO");

    const tier: FpsTier = fps >= 55 ? "good" : fps >= 30 ? "ok" : "bad";
    if (tier !== this.fpsTier) {
      this.fpsTier = tier;
      this.fpsCell.dataset.tier = tier;
    }
  }

  private row(label: string): Text {
    const row = el("div", "tb-stats__row", undefined, this.node);
    el("span", "tb-stats__label", label, row);
    const value = el("span", "tb-stats__value", undefined, row);
    return value.appendChild(document.createTextNode(""));
  }
}

function set(node: Text, value: string): void {
  if (node.data !== value) node.data = value;
}
