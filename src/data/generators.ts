import { makeDataset, type Dataset } from './dataset';
import { mulberry32, randInt, gaussian, type Rng } from './rng';

/**
 * Synthetic data generators (docs/PLAN.md §4.3). Each returns a normalized
 * {@link Dataset} whose `order` carries the exact descriptor that produced it,
 * so the data is reproducible and the chart can label *what* was generated.
 *
 * Leaning into order/distribution is the empirical selling point: `sorted` /
 * `reverse-sorted` input is what degenerates a naive BST to O(n), and
 * `zipfian` is duplicate-heavy on purpose — generators never de-duplicate.
 */

/** Ascending consecutive integers `start, start+1, …` — the canonical sorted (worst-case) input. */
export function generateSorted(n: number, start = 0): Dataset {
  const keys = Array.from({ length: n }, (_, i) => start + i);
  return makeDataset(keys, 'number', { kind: 'sorted', n, start });
}

/** Descending consecutive integers — the mirror worst case. */
export function generateReverseSorted(n: number, start = 0): Dataset {
  const keys = Array.from({ length: n }, (_, i) => start + (n - 1 - i));
  return makeDataset(keys, 'number', { kind: 'reverse-sorted', n, start });
}

/** Sorted integers perturbed by `swaps` random adjacent transpositions. */
export function generateNearSorted(n: number, swaps = Math.ceil(n / 20), start = 0, seed = 1): Dataset {
  const rng = mulberry32(seed);
  const keys = Array.from({ length: n }, (_, i) => start + i);
  for (let s = 0; s < swaps && n >= 2; s++) {
    const i = randInt(rng, 0, n - 2);
    [keys[i], keys[i + 1]] = [keys[i + 1], keys[i]];
  }
  return makeDataset(keys, 'number', { kind: 'near-sorted', n, start, swaps, seed });
}

/** Uniform random numbers in `[min, max]` (integers when `integer`). */
export function generateUniform(
  n: number,
  min = 0,
  max = n - 1,
  integer = true,
  seed = 1,
): Dataset {
  const rng = mulberry32(seed);
  const keys = Array.from({ length: n }, () =>
    integer ? randInt(rng, min, max) : min + rng() * (max - min),
  );
  return makeDataset(keys, 'number', { kind: 'uniform', n, min, max, integer, seed });
}

/** Gaussian-distributed numbers (floats). */
export function generateGaussian(n: number, mean = 0, stddev = 1, seed = 1): Dataset {
  const rng = mulberry32(seed);
  const keys = Array.from({ length: n }, () => gaussian(rng, mean, stddev));
  return makeDataset(keys, 'number', { kind: 'gaussian', n, mean, stddev, seed });
}

/**
 * Zipfian / duplicate-heavy integers in `[1, distinct]`: rank `r` is drawn with
 * probability ∝ `1 / r^skew`, so small ranks dominate and duplicates pile up as
 * `skew` rises. Sampled by inverse-CDF over a precomputed cumulative table.
 */
export function generateZipfian(
  n: number,
  distinct = Math.max(1, Math.ceil(n / 10)),
  skew = 1,
  seed = 1,
): Dataset {
  const rng = mulberry32(seed);

  const cumulative = new Float64Array(distinct);
  let total = 0;
  for (let r = 1; r <= distinct; r++) {
    total += 1 / Math.pow(r, skew);
    cumulative[r - 1] = total;
  }

  const keys = Array.from({ length: n }, () => {
    const target = rng() * total;
    // Binary search for the first rank whose cumulative weight ≥ target.
    let lo = 0;
    let hi = distinct - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1; // ranks are 1-based
  });

  return makeDataset(keys, 'number', { kind: 'zipfian', n, distinct, skew, seed });
}

/** Random fixed-alphabet strings of length `[minLen, maxLen]` — feeds the trie too. */
export function generateStringCorpus(
  n: number,
  minLen = 3,
  maxLen = 8,
  alphabet = 'abcdefghijklmnopqrstuvwxyz',
  seed = 1,
): Dataset {
  const rng: Rng = mulberry32(seed);
  const keys = Array.from({ length: n }, () => {
    const len = randInt(rng, minLen, maxLen);
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[randInt(rng, 0, alphabet.length - 1)];
    return s;
  });
  return makeDataset(keys, 'string', {
    kind: 'string-corpus',
    n,
    minLen,
    maxLen,
    alphabet,
    seed,
  });
}
