const FONT = "font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace";

/**
 * DOM for the perf tools: a compact stats panel, a benchmark status line, a click shield while the benchmark drives
 * the camera, and a results dialog with a copy button. Inline styles, above the HUD.
 */
export class PerfOverlay {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLPreElement;
  private readonly status: HTMLDivElement;
  private readonly shield: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private readonly output: HTMLTextAreaElement;
  private readonly copyButton: HTMLButtonElement;
  private statsVisible = false;

  constructor(parent: HTMLElement = document.body) {
    this.root = element("div", "position:fixed;inset:0;pointer-events:none;z-index:60;color:#e8eef2", parent);
    this.shield = element("div", "position:absolute;inset:0;pointer-events:auto;cursor:progress;display:none", this.root);
    this.panel = element("pre", `position:absolute;left:12px;top:96px;margin:0;padding:8px 10px;background:rgba(8,10,14,.78);border-radius:6px;white-space:pre;display:none;${FONT}`, this.root);
    this.status = element(
      "div",
      `position:absolute;left:50%;bottom:120px;transform:translateX(-50%);padding:8px 14px;background:rgba(8,10,14,.82);border-radius:6px;display:none;${FONT};font-size:12px`,
      this.root,
    );

    this.dialog = element(
      "div",
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1100px,92vw);padding:14px 16px;background:rgba(12,15,20,.95);border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5);pointer-events:auto;display:none;font:13px system-ui,sans-serif",
      this.root,
    );
    const title = element("div", "font-weight:600;margin-bottom:8px", this.dialog);
    title.textContent = "Benchmark results: copy and paste them back into the chat";
    this.output = element("textarea", `width:100%;height:60vh;box-sizing:border-box;resize:vertical;background:#0b0e12;color:#dfe7ec;border:1px solid #2a323a;border-radius:4px;padding:8px;${FONT}`, this.dialog);
    this.output.readOnly = true;
    this.output.spellcheck = false;
    const buttons = element("div", "display:flex;gap:8px;justify-content:flex-end;margin-top:10px", this.dialog);
    this.copyButton = button("Copy results", buttons, () => void this.copy());
    button("Close", buttons, () => (this.dialog.style.display = "none"));
  }

  get panelVisible(): boolean {
    return this.statsVisible;
  }

  set panelVisible(visible: boolean) {
    this.statsVisible = visible;
    this.panel.style.display = visible ? "block" : "none";
  }

  setStats(text: string): void {
    if (this.statsVisible) this.panel.textContent = text;
  }

  /** Benchmark progress line; null hides it. */
  setStatus(text: string | null): void {
    this.status.style.display = text ? "block" : "none";
    if (text) this.status.textContent = text;
  }

  /** While the benchmark runs, clicks must not reach the canvas (pointer lock would hand control back). */
  setShield(active: boolean): void {
    this.shield.style.display = active ? "block" : "none";
  }

  showResults(text: string): void {
    this.output.value = text;
    this.copyButton.textContent = "Copy results";
    this.dialog.style.display = "block";
  }

  dispose(): void {
    this.root.remove();
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.output.value);
      this.copyButton.textContent = "Copied";
    } catch {
      // Clipboard API refused (permissions, insecure origin): select the text for a manual copy.
      this.output.focus();
      this.output.select();
      this.copyButton.textContent = "Press ⌘C / Ctrl+C";
    }
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, style: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = style;
  parent.append(node);
  return node;
}

function button(label: string, parent: HTMLElement, onClick: () => void): HTMLButtonElement {
  const node = element("button", "padding:6px 14px;border:0;border-radius:4px;background:#e8b04a;color:#111;font-weight:600;cursor:pointer", parent);
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}
