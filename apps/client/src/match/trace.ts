// DEV `&matchTrace=1`: breadcrumbs that survive a hung renderer (localStorage is written synchronously), so after a
// freeze the tab can be reloaded and `localStorage["tb.matchTrace"]` shows the last step that started.

const KEY = "tb.matchTrace";
/** Only the start path and the first frames/ticks are traced; later steps only warn when slow. */
const MAX_CRUMBS = 400;
const SLOW_MS = 50;

export class MatchTrace {
  private crumbs = 0;
  private readonly lines: string[] = [];

  constructor(readonly enabled: boolean) {
    if (enabled) {
      try {
        localStorage.setItem(KEY, "");
      } catch {
        // Storage blocked: console only.
      }
    }
  }

  /** Records that `stage` is starting. */
  mark(stage: string): void {
    if (!this.enabled || this.crumbs >= MAX_CRUMBS) return;
    this.crumbs++;
    this.lines.push(`${performance.now().toFixed(1)} ${stage}`);
    if (this.lines.length > 40) this.lines.shift();
    try {
      localStorage.setItem(KEY, this.lines.join("\n"));
    } catch {
      // ignore
    }
  }

  /** Times `run`; marks it while tracing and warns when it takes longer than 50 ms. */
  time<T>(stage: string, run: () => T): T {
    if (!this.enabled) return run();
    this.mark(`${stage} …`);
    const t0 = performance.now();
    const result = run();
    const ms = performance.now() - t0;
    if (ms > SLOW_MS) console.warn(`[match] slow ${stage}: ${ms.toFixed(1)} ms`);
    this.mark(`${stage} ${ms.toFixed(1)} ms`);
    return result;
  }
}
