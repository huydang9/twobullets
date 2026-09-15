import { el, elT, textNode } from "./dom";

/** Connection numbers the strip shows online (NetClient `stats` satisfies it). */
export interface StatsStripNet {
  readonly state: string;
  readonly rttMs: number;
  readonly lossPct: number;
}

const STORAGE_KEY = "tb.hud.statsStrip";
const REFRESH_MS = 250;
/** Time constant of the FPS smoothing on top of Babylon's own 60-frame average, s. */
const FPS_SMOOTH_S = 0.5;

type PingTier = "good" | "ok" | "bad";

/** Menu setting: the strip is on unless turned off. */
export function loadStatsStripEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveStatsStripEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/**
 * Small always-on readout in the top-left corner: FPS everywhere, ping and packet loss in online matches. DOM is built
 * once; text is rewritten about 4 times per second, only when the shown value changed.
 */
export class StatsStrip {
  private readonly root: HTMLDivElement;
  private readonly fps: Text;
  private readonly pingItem: HTMLSpanElement;
  private readonly pingValue: HTMLSpanElement;
  private readonly ping: Text;
  private readonly lossItem: HTMLSpanElement;
  private readonly loss: Text;
  private net: (() => StatsStripNet | null) | null = null;
  private smoothedFps = -1;
  private shownFps = -1;
  private shownPing = -2;
  private shownLoss = -2;
  private pingTier: PingTier | undefined;
  private lastRefresh = -Infinity;

  constructor(parent: HTMLElement, enabled: boolean = loadStatsStripEnabled()) {
    this.root = el("div", "tb-strip", undefined, parent);
    this.fps = this.item("hud.stats.fps").value;
    const ping = this.item("hud.stats.ping");
    this.pingItem = ping.item;
    this.pingValue = ping.node;
    this.ping = ping.value;
    const loss = this.item("hud.stats.loss");
    this.lossItem = loss.item;
    this.loss = loss.value;
    this.pingItem.hidden = true;
    this.lossItem.hidden = true;
    this.root.hidden = !enabled;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Online: where ping and loss come from (read at the refresh rate); null shows FPS only. */
  setNet(source: (() => StatsStripNet | null) | null): void {
    this.net = source;
    this.pingItem.hidden = source === null;
    this.lossItem.hidden = source === null;
    this.shownPing = this.shownLoss = -2;
  }

  /** Every frame with Babylon's `engine.getFps()`. */
  update(now: number, fps: number, dt: number): void {
    if (this.root.hidden) return;
    if (Number.isFinite(fps) && fps > 0) this.smoothedFps = this.smoothedFps < 0 ? fps : this.smoothedFps + (fps - this.smoothedFps) * Math.min(1, dt / FPS_SMOOTH_S);
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;

    const shownFps = this.smoothedFps < 0 ? 0 : Math.round(this.smoothedFps);
    if (shownFps !== this.shownFps) this.fps.data = String((this.shownFps = shownFps));

    const source = this.net;
    if (!source) return;
    const stats = source();
    const live = stats !== null && stats.state === "playing";
    // −1: no number yet (connecting, syncing, disconnected).
    const ping = live && stats.rttMs > 0 ? Math.round(stats.rttMs) : -1;
    if (ping !== this.shownPing) {
      this.shownPing = ping;
      this.ping.data = ping < 0 ? "–" : `${ping} ms`;
      const tier: PingTier | undefined = ping < 0 ? undefined : ping < 60 ? "good" : ping < 120 ? "ok" : "bad";
      if (tier !== this.pingTier) {
        this.pingTier = tier;
        if (tier) this.pingValue.dataset.tier = tier;
        else delete this.pingValue.dataset.tier;
      }
    }
    // Tenths of a percent.
    const loss = live ? Math.round(Math.max(0, stats.lossPct) * 10) : -1;
    if (loss !== this.shownLoss) {
      this.shownLoss = loss;
      this.loss.data = loss < 0 ? "–" : `${(loss / 10).toFixed(1)}%`;
    }
  }

  dispose(): void {
    this.root.remove();
  }

  private item(label: "hud.stats.fps" | "hud.stats.ping" | "hud.stats.loss"): { item: HTMLSpanElement; node: HTMLSpanElement; value: Text } {
    const item = el("span", "tb-strip__item", undefined, this.root);
    elT("span", "tb-strip__label", label, item);
    const node = el("span", "tb-strip__value", undefined, item);
    return { item, node, value: textNode(node, "–") };
  }
}
