// Seeded PRNG for the link conditioner (mulberry32, the same family as the shared weapon RNG). Never Math.random.

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Standard normal (Box–Muller). */
  normal(): number;
}

export function createSeededRng(seed: number): Rng {
  let a = seed >>> 0;
  let spare = 0;
  let hasSpare = false;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    normal(): number {
      if (hasSpare) {
        hasSpare = false;
        return spare;
      }
      let u = 0;
      while (u === 0) u = next();
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      hasSpare = true;
      return r * Math.cos(2 * Math.PI * v);
    },
  };
}
