import type { InputManager } from "../input/InputManager";
import type { NetStats } from "../net/NetClient";
import type { NetCombatStats } from "../net/NetCombat";
import { t } from "../i18n";
import { el, textNode } from "./dom";

const KEY = "F6";
const REFRESH_MS = 250;

const PANEL_STYLE =
  "position:absolute;top:8px;right:8px;z-index:50;padding:6px 8px;background:rgba(0,0,0,0.6);color:#d8f0d8;" +
  "font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre;pointer-events:none;border-radius:3px";
const BANNER_STYLE =
  "position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:50;padding:6px 14px;background:rgba(20,20,20,0.75);" +
  "color:#ffd9a0;font:600 13px/1.3 system-ui,sans-serif;letter-spacing:0.02em;pointer-events:none;border-radius:3px";

const LIFE_TEXT: Readonly<Record<number, string>> = { 0: "alive", 1: "downed", 2: "dead" };
/** `WeaponDiff` bit names (shared/weapons/reconcile). */
const WEAPON_DIFF_NAMES = ["slots", "ammo", "active", "phase", "shots", "trigger", "phaseTimer", "cooldown", "bloom", "ads"];

function weaponDiffText(mask: number): string {
  if (mask === 0) return "-";
  const names: string[] = [];
  for (let i = 0; i < WEAPON_DIFF_NAMES.length; i++) if ((mask & (1 << i)) !== 0) names.push(WEAPON_DIFF_NAMES[i]!);
  return names.join(",");
}

const f0 = (v: number) => v.toFixed(0);
const f1 = (v: number) => v.toFixed(1);

/**
 * DEV net debug panel (F6): RTT, jitter, loss, input buffer depth, interpolation delay, corrections, resyncs, bytes
 * per second and transport. The connection banner (connecting, interrupted, disconnected + reason) is always shown.
 * Refreshes text 4× per second.
 */
export class NetDebugHud {
  private readonly panel: HTMLDivElement;
  private readonly text: Text;
  private readonly banner: HTMLDivElement;
  private readonly bannerText: Text;
  private readonly input: InputManager;
  private visible: boolean;
  private lastRefreshMs = -Infinity;

  constructor(root: HTMLElement, input: InputManager, options: { readonly visible?: boolean } = {}) {
    this.input = input;
    this.visible = options.visible ?? true;
    this.panel = el("div", "tb-net-debug", undefined, root);
    this.panel.style.cssText = PANEL_STYLE;
    this.text = textNode(this.panel);
    this.panel.hidden = !this.visible;
    this.banner = el("div", "tb-net-banner", undefined, root);
    this.banner.style.cssText = BANNER_STYLE;
    this.bannerText = textNode(this.banner);
    this.banner.hidden = true;
    // F6 would move focus to the address bar.
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.code === KEY) event.preventDefault();
      },
      { capture: true },
    );
  }

  update(stats: NetStats, nowMs: number, combat: NetCombatStats | null = null, predictedHits = 0): void {
    if (this.input.wasPressed(KEY)) {
      this.visible = !this.visible;
      this.panel.hidden = !this.visible;
      this.lastRefreshMs = -Infinity;
    }
    if (nowMs - this.lastRefreshMs < REFRESH_MS) return;
    this.lastRefreshMs = nowMs;
    this.updateBanner(stats);
    if (!this.visible) return;
    this.text.data =
      `NET ${stats.transport}${stats.fallbackReason ? ` (${stats.fallbackReason})` : ""}  ${stats.state}  slot ${stats.slot} team ${stats.team}\n` +
      `rtt ${f0(stats.rttMs)} ms (min ${f0(stats.rttMinMs)})  jitter ${f1(stats.jitterMs)} ms  loss ${f1(stats.lossPct)}%\n` +
      `buffer ${f1(stats.bufferDepthTicks)}/${f0(stats.bufferTargetTicks)} t  dilation ${f1((stats.tickScale - 1) * 100)}%  lead ${f1(stats.leadTicks)} t\n` +
      `interp ${f0(stats.interpDelayMs)} ms  remotes ${stats.remoteCount}  extrap ${f1(stats.extrapolatedPct)}%\n` +
      `corr ${stats.correctionsPerMin}/min (${stats.corrections})  last ${f1(stats.lastCorrectionCm)} cm  mean ${f1(stats.meanCorrectionCm)} cm\n` +
      `replayed ${stats.replayedTicks} t  resyncs ${stats.resyncs}  decode fail ${stats.decodeFailures}\n` +
      `in ${f1(stats.bytesInPerSec / 1024)} KB/s  out ${f1(stats.bytesOutPerSec / 1024)} KB/s  tick ${stats.clientTick}\n` +
      `weapon mispredict ${stats.weaponCorrectionsPerMin}/min (${stats.weaponCorrections})  last ${weaponDiffText(stats.lastWeaponDiff)}\n` +
      `life ${LIFE_TEXT[stats.ownerLife] ?? stats.ownerLife}  events ${stats.eventsDelivered} (dup ${stats.eventDuplicates})  shots in ${stats.shotsReceived}  hits in ${stats.hitsReceived}\n` +
      (combat
        ? `confirms ${combat.hitConfirms}  predicted ${predictedHits}  dmg taken ${combat.damageTaken}  kills ${combat.kills}  feed ${combat.feedLines}  shots played ${combat.shotsPlayed}/${combat.shotsDropped} dropped\n`
        : "") +
      `server: movement + weapons + damage (M4); equipment local`;
  }

  /** Shown when there's no server yet (token fetch or socket failure before a NetClient exists). */
  showError(message: string): void {
    this.banner.hidden = false;
    this.bannerText.data = message;
  }

  dispose(): void {
    this.panel.remove();
    this.banner.remove();
  }

  private updateBanner(stats: NetStats): void {
    let message = "";
    if (stats.state === "handshaking") message = t("net.connecting");
    else if (stats.state === "syncing") message = t("net.syncing");
    else if (stats.state === "disconnected") message = t("net.disconnected", { reason: stats.disconnectReason || t("net.reason.connectionClosed") });
    else if (stats.interrupted) message = t("net.interrupted");
    this.banner.hidden = message === "";
    if (message !== "" && this.bannerText.data !== message) this.bannerText.data = message;
  }
}
