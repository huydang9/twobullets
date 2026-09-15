// Tiny Prometheus text exposition (no client library). Low-cardinality labels only (platform.md §7.1: no match ids).

type Labels = Readonly<Record<string, string>>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`)
    .join(",");
}

export class Metrics {
  private readonly counters = new Map<string, { help: string; values: Map<string, number> }>();
  private readonly gauges = new Map<string, { help: string; read: () => number | readonly [Labels, number][] }>();

  inc(name: string, labels: Labels = {}, by = 1, help = ""): void {
    let c = this.counters.get(name);
    if (c === undefined) {
      c = { help, values: new Map() };
      this.counters.set(name, c);
    }
    const k = key(labels);
    c.values.set(k, (c.values.get(k) ?? 0) + by);
  }

  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.values.get(key(labels)) ?? 0;
  }

  gauge(name: string, help: string, read: () => number | readonly [Labels, number][]): void {
    this.gauges.set(name, { help, read });
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      if (c.help) lines.push(`# HELP ${name} ${c.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [k, v] of c.values) lines.push(`${name}${k ? `{${k}}` : ""} ${v}`);
    }
    for (const [name, g] of this.gauges) {
      lines.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
      const value = g.read();
      if (typeof value === "number") lines.push(`${name} ${value}`);
      else for (const [labels, v] of value) lines.push(`${name}{${key(labels)}} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
