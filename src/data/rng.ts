/**
 * A tiny seeded PRNG so synthetic datasets (docs/PLAN.md §4.3) are fully
 * reproducible from their {@link import('./dataset').GeneratorDescriptor}:
 * same seed ⇒ same data, which keeps benchmarks and demos deterministic.
 *
 * `mulberry32` is a well-known 32-bit generator — fast, tiny, and good enough
 * for distribution shaping (not for cryptography).
 */
export type Rng = () => number;

/** Create a PRNG returning floats in `[0, 1)`. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in `[min, max]` inclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** A standard-normal-derived sample with the given mean/stddev (Box–Muller). */
export function gaussian(rng: Rng, mean: number, stddev: number): number {
  // Avoid log(0) by sampling u1 in (0, 1].
  const u1 = 1 - rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}
