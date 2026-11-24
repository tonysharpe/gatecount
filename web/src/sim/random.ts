/** A seeded random stream.
 *
 * The simulated motorway draws every choice from one of these -- when the next
 * vehicle arrives, what it is, how fast it wants to go, how its detection box
 * wobbles -- so a given seed is always the same traffic. The tests rely on
 * that, and so does the page: the scene a visitor first sees is a known one.
 *
 * mulberry32: a 32-bit state, fast, and plenty for traffic. */

export class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [low, high). */
  range(low: number, high: number): number {
    return low + (high - low) * this.next();
  }

  /** Standard normal, by Box-Muller. */
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** The wait until the next event of a Poisson process with this rate. */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  /** One of `items`, with probability proportional to its weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T {
    const total = items.reduce((sum, [, weight]) => sum + weight, 0);
    let pick = this.next() * total;
    for (const [item, weight] of items) {
      pick -= weight;
      if (pick < 0) {
        return item;
      }
    }
    const last = items[items.length - 1];
    if (last === undefined) {
      throw new Error("weighted() needs at least one item");
    }
    return last[0];
  }
}
