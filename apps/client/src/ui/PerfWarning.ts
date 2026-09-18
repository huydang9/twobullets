import { bindTitle, onLanguageChange, t, type MessageKey } from "../i18n";
import type { GpuInfo } from "../perf/gpuClass";
import { el, elT } from "./dom";

// Low-FPS warning. It exists because Chrome can bind its GPU process to a Windows laptop's integrated chip while the
// discrete card idles (11-16 FPS on an RTX 5050 machine), with nothing on screen saying so. Two layers, because the
// pointer is locked while playing: a compact banner that never covers the crosshair and never takes the pointer, and a
// full guide panel with the fix, which assumes the pointer was released.
//
// `hybridHint` is only a hint: it is true for every Windows machine on an integrated GPU, including the ones with no
// second card to switch to. So the guide asks "if you have a dedicated card" and never claims the player has one, and
// when the renderer string was not recognised the quick wins come first and the GPU steps read as a guess. The software
// rasterizer is the worst case and has its own first step (turn hardware acceleration back on).

export interface PerfWarningInfo {
  readonly gpu: GpuInfo;
  /** Smoothed FPS at the moment the warning fired. */
  readonly fps: number;
}

export interface PerfWarningHandlers {
  /** Player pressed "lower graphics quality". Integration drops the preset to "performance". */
  readonly onReduceQuality: () => void;
  /** Player dismissed it for this session. */
  readonly onDismiss?: () => void;
}

/** One numbered step of the guide: a title and the lines under it. */
interface GuideStep {
  readonly title: MessageKey;
  readonly lines: readonly MessageKey[];
}

/** Shown only for the software rasterizer, where nothing else matters until the GPU is used at all. */
const ACCEL_STEP: GuideStep = {
  title: "perf.guide.accel.title",
  lines: ["perf.guide.accel.enable", "perf.guide.accel.check"],
};

// In the order the player has to do them: the Windows setting, the restart that actually applies it, then the check.
const GPU_STEPS: readonly GuideStep[] = [
  { title: "perf.guide.windows.title", lines: ["perf.guide.windows.path", "perf.guide.windows.app"] },
  { title: "perf.guide.restart.title", lines: ["perf.guide.restart.why", "perf.guide.restart.tasks"] },
  { title: "perf.guide.verify.title", lines: ["perf.guide.verify.body"] },
  { title: "perf.guide.laptop.title", lines: ["perf.guide.laptop.nvidia", "perf.guide.laptop.asus"] },
];

/** Works on every machine, so it leads when switching GPUs is not the likely fix. */
const QUICK_STEP: GuideStep = {
  title: "perf.guide.more.title",
  lines: ["perf.guide.more.quality", "perf.guide.more.tabs", "perf.guide.more.power"],
};

/** The banner dims to a quieter state after this long, but stays up until the player dismisses it. */
const QUIET_AFTER_MS = 10_000;

/** A renderer string can be 60+ characters ("Vulkan 1.3.0 (SwiftShader Device (Subzero)), …"); the banner is one line. */
const MAX_GPU_NAME = 40;

/** Banner + guide panel telling the player the game is slow and how to fix it. */
export class PerfWarning {
  private readonly parent: HTMLElement;
  private readonly handlers: PerfWarningHandlers;
  private readonly banner: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly unsubscribeLanguage: () => void;
  private guide: HTMLDivElement | null = null;
  private detected: HTMLDivElement | null = null;
  private intro: HTMLDivElement | null = null;
  private steps: HTMLOListElement | null = null;
  private accelStep: HTMLLIElement | null = null;
  private quickStep: HTMLLIElement | null = null;
  private qualityDone: HTMLDivElement | null = null;
  private info: PerfWarningInfo | null = null;
  private statusText = "";
  private detectedText = "";
  private introText = "";
  private quickFirst = false;
  private dismissed = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;

  /** Capture phase: while the guide is up, Esc closes it and nothing else (the match must not also pause). */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.guide === null || this.guide.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeGuide();
  };

  constructor(parent: HTMLElement, handlers: PerfWarningHandlers) {
    this.parent = parent;
    this.handlers = handlers;

    this.banner = el("div", "tb-perfwarn", undefined, parent);
    this.banner.setAttribute("role", "status");
    this.banner.hidden = true;
    el("span", "tb-perfwarn__icon", "⚠", this.banner);
    const text = el("div", "tb-perfwarn__text", undefined, this.banner);
    elT("div", "tb-perfwarn__title", "perf.warn.title", text);
    this.status = el("div", "tb-perfwarn__status", undefined, text);
    const hint = elT("button", "tb-perfwarn__hint", "perf.warn.hint", text);
    hint.type = "button";
    hint.addEventListener("click", () => {
      hint.blur();
      this.openGuide();
    });
    const close = el("button", "tb-perfwarn__close", "×", this.banner);
    close.type = "button";
    bindTitle(close, "perf.warn.dismiss");
    close.addEventListener("click", () => {
      close.blur();
      this.dismiss();
    });

    // Static labels re-translate themselves; the lines built from values are rewritten here.
    this.unsubscribeLanguage = onLanguageChange(() => {
      this.statusText = "";
      this.detectedText = "";
      this.introText = "";
      this.render();
    });
    window.addEventListener("keydown", this.onKeyDown, true);
  }

  /** True while the banner or the guide is on screen. */
  get visible(): boolean {
    return !this.banner.hidden || (this.guide !== null && !this.guide.hidden);
  }

  /** True only while the guide panel is open. The banner alone must not block the pause menu. */
  get guideOpen(): boolean {
    return this.guide !== null && !this.guide.hidden;
  }

  /** Shows the compact banner. Idempotent: a second call only refreshes the numbers. */
  show(info: PerfWarningInfo): void {
    if (this.dismissed) return;
    this.info = info;
    this.render();
    if (!this.banner.hidden) return;
    this.banner.hidden = false;
    this.banner.classList.remove("tb-perfwarn--quiet");
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = undefined;
      this.banner.classList.add("tb-perfwarn--quiet");
    }, QUIET_AFTER_MS);
  }

  /** Opens the full guide (banner hint, or the key the game binds). Works after a dismissal, so F10 stays useful. */
  openGuide(): void {
    const guide = this.guide ?? this.buildGuide();
    guide.hidden = false;
    this.render();
    // The panel is meant to be read and clicked, so give the mouse back if the game still holds it.
    if (document.pointerLockElement) document.exitPointerLock();
  }

  hide(): void {
    clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    this.banner.hidden = true;
    if (this.guide) this.guide.hidden = true;
  }

  dispose(): void {
    clearTimeout(this.quietTimer);
    this.unsubscribeLanguage();
    window.removeEventListener("keydown", this.onKeyDown, true);
    this.guide?.remove();
    this.guide = null;
    this.banner.remove();
  }

  /** The banner's close button: gone for the rest of the session. */
  private dismiss(): void {
    this.dismissed = true;
    this.hide();
    this.handlers.onDismiss?.();
  }

  /** Closing the guide leaves the banner up (quieted), so the player can reopen it. */
  private closeGuide(): void {
    if (this.guide) this.guide.hidden = true;
    if (!this.dismissed && this.info !== null) this.banner.classList.add("tb-perfwarn--quiet");
  }

  private render(): void {
    const info = this.info;
    const gpu = info?.gpu ?? null;
    if (info) {
      const params = { fps: Math.round(info.fps), gpu: gpuLabel(info.gpu) };
      const status = t("perf.warn.status", params);
      if (status !== this.statusText) {
        this.statusText = status;
        this.status.textContent = status;
      }
      if (this.detected) {
        const detected = t("perf.guide.detected", params);
        if (detected !== this.detectedText) {
          this.detectedText = detected;
          this.detected.textContent = detected;
        }
      }
    }
    // Opened by the key before any measurement: the guide still reads fine without the detected lines.
    if (this.detected) this.detected.hidden = info === null;
    if (this.intro) {
      const intro = gpu === null ? "" : t(introKey(gpu));
      if (intro !== this.introText) {
        this.introText = intro;
        this.intro.textContent = intro;
      }
      this.intro.hidden = intro === "";
    }
    if (this.accelStep) this.accelStep.hidden = gpu?.gpuClass !== "software";
    // Nothing to switch to (or nothing recognised): put the advice that always works first.
    this.orderSteps(gpu === null || !gpu.hybridHint);
  }

  /** The quick wins are the last step by default; moving that one node is enough to swap the two groups. */
  private orderSteps(quickFirst: boolean): void {
    if (this.steps === null || this.quickStep === null || this.quickFirst === quickFirst) return;
    this.quickFirst = quickFirst;
    // The hardware-acceleration step is the first child and stays on top whenever it is shown.
    if (quickFirst) this.steps.insertBefore(this.quickStep, this.accelStep?.nextSibling ?? this.steps.firstChild);
    else this.steps.append(this.quickStep);
  }

  /** Built once, on the first open. */
  private buildGuide(): HTMLDivElement {
    const root = el("div", "tb-perfwarn-guide", undefined, this.parent);
    root.setAttribute("role", "dialog");
    root.addEventListener("click", () => this.closeGuide());
    const panel = el("div", "tb-perfwarn-guide__panel", undefined, root);
    panel.addEventListener("click", (event) => event.stopPropagation());

    const header = el("div", "tb-perfwarn-guide__header", undefined, panel);
    elT("div", "tb-perfwarn-guide__title", "perf.guide.title", header);
    const close = el("button", "tb-perfwarn-guide__close", "×", header);
    close.type = "button";
    bindTitle(close, "perf.guide.close");
    close.addEventListener("click", () => this.closeGuide());

    this.detected = el("div", "tb-perfwarn-guide__detected", undefined, panel);
    this.intro = el("div", "tb-perfwarn-guide__intro", undefined, panel);

    this.steps = el("ol", "tb-perfwarn-guide__steps", undefined, panel);
    this.accelStep = this.stepItem(this.steps, ACCEL_STEP);
    this.accelStep.hidden = true;
    for (const step of GPU_STEPS) this.stepItem(this.steps, step);
    this.quickStep = this.stepItem(this.steps, QUICK_STEP);

    const actions = el("div", "tb-perfwarn-guide__actions", undefined, panel);
    const reduce = elT("button", "tb-perfwarn-guide__button tb-perfwarn-guide__button--primary", "perf.guide.reduceQuality", actions);
    reduce.type = "button";
    reduce.addEventListener("click", () => {
      reduce.blur();
      reduce.disabled = true;
      if (this.qualityDone) this.qualityDone.hidden = false;
      this.handlers.onReduceQuality();
    });
    const done = elT("button", "tb-perfwarn-guide__button", "perf.guide.close", actions);
    done.type = "button";
    done.addEventListener("click", () => {
      done.blur();
      this.closeGuide();
    });

    this.qualityDone = elT("div", "tb-perfwarn-guide__done", "perf.guide.qualityDone", panel);
    this.qualityDone.hidden = true;
    elT("div", "tb-perfwarn-guide__esc", "perf.guide.escHint", panel);

    this.guide = root;
    return root;
  }

  private stepItem(list: HTMLOListElement, step: GuideStep): HTMLLIElement {
    const item = el("li", "tb-perfwarn-guide__step", undefined, list);
    elT("div", "tb-perfwarn-guide__step-title", step.title, item);
    for (const line of step.lines) elT("div", "tb-perfwarn-guide__line", line, item);
    return item;
  }
}

/**
 * Which opening line the panel leads with. `hybridHint` means "forcing the discrete GPU is worth trying" — phrased as a
 * conditional, since plenty of Windows machines have no discrete GPU at all. An unrecognised renderer gets the hedged
 * line instead, because the GPU steps are then guesswork.
 */
function introKey(gpu: GpuInfo): MessageKey {
  if (gpu.gpuClass === "software") return "perf.guide.software";
  if (gpu.hybridHint) return "perf.guide.hybrid";
  return gpu.gpuClass === "unknown" ? "perf.guide.unknown" : "perf.guide.generic";
}

/**
 * What to print for `{gpu}`. The software rasterizer reports a long driver string that means nothing to a player, so it
 * gets a name of its own; everything else is capped, because the banner is a single line.
 */
function gpuLabel(gpu: GpuInfo): string {
  if (gpu.gpuClass === "software") return t("perf.gpu.software");
  const name = gpu.name;
  return name.length > MAX_GPU_NAME ? `${name.slice(0, MAX_GPU_NAME - 1).trimEnd()}…` : name;
}
