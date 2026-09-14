import type { BenchRun, SegmentResult } from "./BenchRunner";

export interface BenchReport extends BenchRun {
  /** Browser, GPU, resolution and settings the run used. */
  readonly meta: Readonly<Record<string, string | number | boolean>>;
}

/** Markdown tables for a human, followed by the rounded JSON for tooling. */
export function formatBenchReport(report: BenchReport): string {
  return `${formatBenchMarkdown(report)}\n<details><summary>JSON</summary>\n\n\`\`\`json\n${formatBenchJson(report)}\n\`\`\`\n</details>\n`;
}

export function formatBenchJson(report: BenchReport): string {
  return JSON.stringify(report, (_key, value: unknown) => (typeof value === "number" ? (Number.isFinite(value) ? Math.round(value * 100) / 100 : null) : value));
}

export function formatBenchMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  const { timing } = report;
  lines.push(`## twobullets bench v1 (${report.startedAt})`, "");
  for (const [key, value] of Object.entries(report.meta)) lines.push(`- ${key}: ${String(value)}`);
  lines.push(`- duration: ${formatDuration(report.durationS)}, interruptions: ${report.interruptions}`, "");
  lines.push("Frame = time between frames (display-paced: vsync caps it at the refresh interval). CPU = render-loop JS per frame. Times in ms.", "");

  const full = report.segments.filter((s) => s.pass === "full");
  if (full.length > 0) {
    lines.push(`### Full pass (${timing.fullWarmupMs / 1000} s warmup + ${timing.fullMeasureMs / 1000} s per viewpoint)`, "");
    lines.push(
      row(["Viewpoint", "FPS", "Frame avg", "p95", "p99", "CPU", "CPU p95", "Update", "Render", "Anim", "Physics", "Shadow RTT", "Eval", "Draw", "GPU", "Draw calls", "Meshes", "Tris k", "Bones", "Casters/cascade"]),
      row(["---", ...new Array<string>(19).fill("---:")]),
    );
    for (const s of full) {
      lines.push(
        row([
          labelOf(report, s.viewpoint),
          fixed(s.fps, 0),
          fixed(s.frame.avg, 2),
          fixed(s.frame.p95, 2),
          fixed(s.frame.p99, 2),
          fixed(s.cpu.avg, 2),
          fixed(s.cpu.p95, 2),
          fixed(s.updateMs, 2),
          fixed(s.renderMs, 2),
          fixed(s.animationsMs, 2),
          fixed(s.physicsMs, 2),
          fixed(s.shadowMs, 2),
          fixed(s.evaluateMs, 2),
          fixed(s.drawMs, 2),
          gpuOf(s),
          fixed(s.drawCalls, 0),
          fixed(s.activeMeshes, 0),
          fixed(s.triangles / 1000, 0),
          fixed(s.activeBones, 0),
          s.shadowCasters.map((c) => fixed(c, 0)).join(" · "),
        ]),
      );
    }
    lines.push(row(["**mean**", "", fixed(mean(full, (s) => s.frame.avg), 2), fixed(mean(full, (s) => s.frame.p95), 2), "", fixed(mean(full, (s) => s.cpu.avg), 2)]), "");
  }

  const ab = report.segments.filter((s) => s.pass === "ab");
  if (ab.length > 0) {
    const variants = [...new Set(ab.map((s) => s.variant))];
    const baseline = ab.filter((s) => s.variant === "baseline");
    const base = { frame: mean(baseline, (s) => s.frame.avg), p95: mean(baseline, (s) => s.frame.p95), cpu: mean(baseline, (s) => s.cpu.avg) };
    lines.push(`### A/B variants (${timing.shortWarmupMs / 1000} s warmup + ${timing.shortMeasureMs / 1000} s per viewpoint; means over viewpoints)`, "");
    lines.push(
      row(["Variant", "Frame avg", "Δ frame", "p95", "Δ p95", "CPU", "Δ CPU", "Render", "Shadow RTT", "Draw", "GPU", "Draw calls", "Tris k"]),
      row(["---", ...new Array<string>(12).fill("---:")]),
    );
    for (const id of variants) {
      const set = ab.filter((s) => s.variant === id);
      const frame = mean(set, (s) => s.frame.avg);
      const p95 = mean(set, (s) => s.frame.p95);
      const cpu = mean(set, (s) => s.cpu.avg);
      lines.push(
        row([
          variantLabel(report, id),
          fixed(frame, 2),
          delta(frame, base.frame),
          fixed(p95, 2),
          delta(p95, base.p95),
          fixed(cpu, 2),
          delta(cpu, base.cpu),
          fixed(mean(set, (s) => s.renderMs), 2),
          fixed(mean(set, (s) => s.shadowMs), 2),
          fixed(mean(set, (s) => s.drawMs), 2),
          set.some((s) => s.gpuMs !== null || s.gpuSyncMs !== null) ? fixed(mean(set, (s) => s.gpuMs ?? s.gpuSyncMs ?? Number.NaN), 2) : "n/a",
          fixed(mean(set, (s) => s.drawCalls), 0),
          fixed(mean(set, (s) => s.triangles) / 1000, 0),
        ]),
      );
    }
    lines.push("", "#### A/B frame avg per viewpoint (ms)", "");
    const viewpoints = [...new Set(ab.map((s) => s.viewpoint))];
    lines.push(row(["Variant", ...viewpoints.map((v) => labelOf(report, v))]), row(["---", ...viewpoints.map(() => "---:")]));
    for (const id of variants) {
      lines.push(row([variantLabel(report, id), ...viewpoints.map((v) => fixed(ab.find((s) => s.variant === id && s.viewpoint === v)?.frame.avg ?? Number.NaN, 2))]));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "–";
}

function delta(value: number, base: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return "–";
  const d = value - base;
  return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} (${d >= 0 ? "+" : "−"}${Math.abs((d / base) * 100).toFixed(0)}%)`;
}

function mean(segments: readonly SegmentResult[], pick: (s: SegmentResult) => number): number {
  const values = segments.map(pick).filter(Number.isFinite);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

function gpuOf(s: SegmentResult): string {
  if (s.gpuMs !== null) return fixed(s.gpuMs, 2);
  if (s.gpuSyncMs !== null) return `sync ${fixed(s.gpuSyncMs, 2)}`;
  return "n/a";
}

function labelOf(report: BenchReport, viewpoint: string): string {
  return report.viewpoints.find((v) => v.id === viewpoint)?.label ?? viewpoint;
}

function variantLabel(report: BenchReport, id: string): string {
  if (id === "baseline") return "baseline";
  if (id === "baseline_end") return "baseline (end, drift check)";
  return report.variants.find((v) => v.id === id)?.label ?? id;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
