/**
 * Geometric size sweep for the benchmark runner (docs/PLAN.md §6.1).
 *
 * Produces a 1-2-5 progression (…, 1000, 2000, 5000, 10000, …) bounded to
 * `[min, max]`. `max` is the user's dataset size, so it is always included as
 * the final point even when it doesn't land on a 1-2-5 step.
 */
export function geometricSweep(min: number, max: number): number[] {
  if (min <= 0 || max < min) return [];

  const steps = [1, 2, 5];
  const out: number[] = [];

  for (let decade = 1; decade <= max; decade *= 10) {
    for (const s of steps) {
      const n = s * decade;
      if (n >= min && n <= max) out.push(n);
    }
  }

  // Always anchor the final point to the actual dataset size.
  if (out.length === 0 || out[out.length - 1] !== max) {
    out.push(max);
  }

  return [...new Set(out)].sort((a, b) => a - b);
}
