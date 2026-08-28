/**
 * Seeded pseudo-randomness.
 *
 * The mock provider must be *reproducible* without being *static*: two runs of
 * the same project with the same seed produce the same dataset, so a demo can
 * be rehearsed and a bug reported, while a different seed produces a genuinely
 * different one. `Math.random()` would give neither property.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: string) {
    this.state = hashString(seed) || 0x2f6e2b1;
  }

  /** xorshift32 — small, fast, and good enough for demo data. */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  float(min: number, max: number, decimals = 2): number {
    const value = this.next() * (max - min) + min;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const picked: T[] = [];
    const target = Math.min(count, pool.length);
    while (picked.length < target) {
      const index = Math.floor(this.next() * pool.length);
      picked.push(pool.splice(index, 1)[0] as T);
    }
    return picked;
  }

  /** Normal-ish variate via the mean of three uniforms, clamped to [min, max]. */
  around(centre: number, spread: number, min = -Infinity, max = Infinity): number {
    const noise = (this.next() + this.next() + this.next()) / 3 - 0.5;
    return Math.min(max, Math.max(min, centre + noise * spread * 2));
  }
}

export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
