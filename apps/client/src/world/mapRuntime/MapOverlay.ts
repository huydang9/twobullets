/**
 * Minimal DOM overlay owned by the map runtime (the HUD has no map hooks yet): a loading card with a progress bar,
 * and an out-of-bounds warning with a countdown. Plain inline styles, no pointer events.
 */
export class MapOverlay {
  private readonly root: HTMLDivElement;
  private readonly loading: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly warning: HTMLDivElement;

  constructor(parent: HTMLElement = document.body) {
    this.root = element("div", "position:fixed;inset:0;pointer-events:none;font:14px system-ui,sans-serif;color:#fff;z-index:20");
    this.loading = element(
      "div",
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:320px;padding:18px 22px;background:rgba(10,13,18,.82);border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,.4)",
    );
    const title = element("div", "font-weight:600;letter-spacing:.04em;margin-bottom:10px");
    title.textContent = "Loading map";
    this.stage = element("div", "opacity:.8;margin-bottom:8px;font-size:12px");
    const track = element("div", "height:4px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden");
    this.bar = element("div", "height:100%;width:0;background:#e8b04a;transition:width .12s linear");
    track.append(this.bar);
    this.loading.append(title, this.stage, track);
    this.warning = element(
      "div",
      "position:absolute;left:50%;top:18%;transform:translateX(-50%);padding:10px 18px;background:rgba(150,20,20,.78);border-radius:6px;text-align:center;font-weight:600;display:none",
    );
    this.root.append(this.loading, this.warning);
    parent.append(this.root);
  }

  /** `fraction` is overall progress 0..1. */
  setProgress(stage: string, fraction: number): void {
    this.stage.textContent = stage;
    this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  hideLoading(): void {
    this.loading.style.display = "none";
  }

  /** Shows the out-of-bounds warning, or hides it with null. */
  setOutOfBounds(secondsLeft: number | null): void {
    if (secondsLeft === null) {
      this.warning.style.display = "none";
      return;
    }
    this.warning.style.display = "block";
    this.warning.textContent = `Outside the play area. Return in ${Math.max(0, secondsLeft).toFixed(1)} s`;
  }

  dispose(): void {
    this.root.remove();
  }
}

function element(tag: "div", style: string): HTMLDivElement {
  const el = document.createElement(tag);
  el.style.cssText = style;
  return el;
}
