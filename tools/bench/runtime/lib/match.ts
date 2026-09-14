/** Common shape of a benchmark match so havok-tick, multi-match and worker benchmarks can drive any mode. */
export type PhaseName = "move" | "weapons" | "hitboxes" | "worldStep" | "projectiles" | "render";

export interface MatchLike {
  readonly mode: string;
  /** Phase names in the order tick() writes their durations (ms) into `out`. */
  readonly phases: readonly PhaseName[];
  readonly setupMs: Record<string, number>;
  setup(module?: WebAssembly.Module, sharedHavok?: unknown): Promise<void>;
  tick(out: Float64Array): void;
  sanity(): Record<string, number>;
  dispose(): void;
}

export async function createMatch(mode: string, options: import("./scenario.ts").ScenarioOptions): Promise<MatchLike> {
  if (mode === "direct") {
    const { DirectMatch } = await import("./directMatch.ts");
    return new DirectMatch(options);
  }
  if (mode === "babylon" || mode === "babylon-render") {
    const { BabylonMatch } = await import("./babylonMatch.ts");
    return new BabylonMatch(options, mode === "babylon-render");
  }
  throw new Error(`unknown mode ${mode}`);
}
