import { describe, it, expect } from 'vitest';
import {
  generateGaussian,
  generateReverseSorted,
  generateSorted,
  generateStringCorpus,
  generateUniform,
  generateZipfian,
  type Dataset,
} from '../data';
import { encodeStringKeys } from '../data/marshal';
import { DynArrayF64, HashSetF64, SkipListF64, TrieStr } from '../structures';
import { buildDataset, DEFAULT_PICKER, PRESETS } from '../ui/DatasetPicker';
import {
  absentSeedsOf,
  buildNumericProbes,
  clampFraction,
  DEFAULT_PROBE_MIX,
  describeMix,
  probeCounts,
  PROBE_MIX_CHOICES,
  PROBES_PER_POINT,
  summarizeMix,
  type ProbeMix,
} from './probeMix';
import { absentLike, buildStringProbes } from './stringWorkload';
import { geometricSweep } from './sweep';
import { STRING_SWEEP_MAX, SWEEP_MAX, SWEEP_MIN } from '../compare/runSweeps';

// ── Frozen references ──────────────────────────────────────────────────────────────
//
// Verbatim copies of the two probe builders as they stood at commit 7450254, before the
// mix existed: `buildProbes` from `src/bench/engine.worker.ts` and `buildStringProbes` from
// `src/bench/stringWorkload.ts`. The browser gate's slope bands were calibrated on exactly
// the workload these produce, so the default mix must reproduce it byte for byte. They are
// copies on purpose — a reference that imports the code under test proves nothing. Do not
// "tidy" them to share code with the new builders.

const LEGACY_PRESENT_PROBES = 64;
const LEGACY_ABSENT_PROBES = 64;

function legacyBuildProbes(keys: Float64Array, n: number): Float64Array {
  const present = Math.min(LEGACY_PRESENT_PROBES, n);
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];
  if (!Number.isFinite(max)) max = 0; // n === 0 guard
  const probes = new Float64Array(present + LEGACY_ABSENT_PROBES);
  for (let i = 0; i < present; i++) {
    probes[i] = keys[Math.floor((i * n) / present)];
  }
  for (let i = 0; i < LEGACY_ABSENT_PROBES; i++) {
    probes[present + i] = max + 1 + i;
  }
  return probes;
}

function legacyBuildStringProbes(keys: readonly string[]): string[] {
  const n = keys.length;
  const present = Math.min(64, n);
  const probes: string[] = [];
  for (let i = 0; i < present; i++) probes.push(keys[Math.floor((i * n) / present)]);

  const taken = new Set(keys);
  for (let i = 0; i < 64; i++) {
    const absent = absentLike(present > 0 ? probes[i % present] : '', taken, i);
    taken.add(absent); // keep the absent block distinct from itself, too
    probes.push(absent);
  }
  return probes;
}

/** The bytes of a Float64Array — `toEqual` would call −0 and 0 equal; this does not. */
const bytesOf = (a: Float64Array) => Array.from(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));

const numericKeys = (d: Dataset) => Float64Array.from(d.keys as readonly number[]);
const stringKeys = (d: Dataset) => d.keys as readonly string[];

const EDGE_SIZES = [0, 1, 2, 5, 10, 63, 64, 65, 127, 128, 129, 1000];

describe('the default mix reproduces the calibrated workload exactly', () => {
  const numericDatasets: Array<[string, Dataset]> = [
    // The default Compare dataset — what the browser gate actually measures first.
    ['default picker (uniform, with repeats)', buildDataset(DEFAULT_PICKER)],
    ['sorted', generateSorted(5_000)],
    ['reverse-sorted', generateReverseSorted(5_000)],
    ['zipfian (duplicate-heavy)', generateZipfian(5_000, 500, 1, 3)],
    ['gaussian floats', generateGaussian(5_000, 0, 1000, 9)],
    ['negative range', generateUniform(5_000, -10_000, -1, true, 4)],
  ];

  it.each(numericDatasets)('numeric: %s — byte-identical at every edge size', (_name, d) => {
    const keys = numericKeys(d);
    for (const n of EDGE_SIZES.filter((s) => s <= keys.length)) {
      const want = bytesOf(legacyBuildProbes(keys, n));
      expect(bytesOf(buildNumericProbes(keys, n))).toEqual(want);
      expect(bytesOf(buildNumericProbes(keys, n, DEFAULT_PROBE_MIX))).toEqual(want);
      expect(bytesOf(buildNumericProbes(keys, n, { presentFraction: 0.5 }))).toEqual(want);
    }
  });

  it('numeric: byte-identical at every size the default Compare run sweeps', () => {
    // The real ladder on the real default dataset: the exact inputs the gate was tuned on.
    const keys = numericKeys(buildDataset(DEFAULT_PICKER));
    const sizes = geometricSweep(SWEEP_MIN, Math.min(SWEEP_MAX, keys.length));
    expect(sizes[sizes.length - 1]).toBe(100_000);
    for (const n of sizes) {
      expect(bytesOf(buildNumericProbes(keys, n, DEFAULT_PROBE_MIX))).toEqual(
        bytesOf(legacyBuildProbes(keys, n)),
      );
    }
    // Negative control: the comparison can fail — any other mix is a different workload.
    for (const presentFraction of PROBE_MIX_CHOICES.filter((f) => f !== 0.5)) {
      expect(bytesOf(buildNumericProbes(keys, 1_000, { presentFraction }))).not.toEqual(
        bytesOf(legacyBuildProbes(keys, 1_000)),
      );
    }
  });

  const stringDatasets: Array<[string, readonly string[]]> = [
    ['random 3–8 char keys (has repeats)', stringKeys(generateStringCorpus(3_000, 3, 8, undefined, 7))],
    ['long keys', stringKeys(generateStringCorpus(2_000, 30, 40, undefined, 2))],
    ['multi-byte text', ['café', 'naïve', 'über', 'ça', 'café', 'jalapeño', 'x', 'y', 'zz', 'résumé']],
    // Every 1-char mutation is taken: forces absentLike's documented long-key fallback.
    ['alphabet-exhausted 1-char corpus', [...'abcdefghijklmnopqrstuvwxyz0123456789']],
    ['duplicates only', Array.from({ length: 200 }, () => 'same')],
  ];

  it.each(stringDatasets)('string: %s — same keys, same order, same bytes', (_name, all) => {
    for (const n of EDGE_SIZES.filter((s) => s <= all.length)) {
      const keys = all.slice(0, n);
      const want = legacyBuildStringProbes(keys);
      const got = buildStringProbes(keys, DEFAULT_PROBE_MIX);
      expect(got).toEqual(want);
      expect(buildStringProbes(keys)).toEqual(want);
      // What the worker actually ships into WASM: the encoded offsets + UTF-8 bytes.
      const a = encodeStringKeys(got);
      const b = encodeStringKeys(want);
      expect(Array.from(a.offsets)).toEqual(Array.from(b.offsets));
      expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
    }
  });

  it('string: identical at every size the default string preset sweeps', () => {
    const preset = PRESETS.find((p) => p.id === 'short-text')!;
    const all = stringKeys(buildDataset(preset.state));
    for (const n of geometricSweep(SWEEP_MIN, Math.min(STRING_SWEEP_MAX, all.length))) {
      const keys = all.slice(0, n);
      expect(buildStringProbes(keys, DEFAULT_PROBE_MIX)).toEqual(legacyBuildStringProbes(keys));
    }
  });
});

describe('probeCounts', () => {
  it('splits the fixed probe budget by the requested fraction', () => {
    expect(probeCounts(10_000, { presentFraction: 0 })).toEqual({ present: 0, absent: 128 });
    expect(probeCounts(10_000, { presentFraction: 0.25 })).toEqual({ present: 32, absent: 96 });
    expect(probeCounts(10_000, DEFAULT_PROBE_MIX)).toEqual({ present: 64, absent: 64 });
    expect(probeCounts(10_000, { presentFraction: 0.75 })).toEqual({ present: 96, absent: 32 });
    expect(probeCounts(10_000, { presentFraction: 1 })).toEqual({ present: 128, absent: 0 });
    for (const f of PROBE_MIX_CHOICES) {
      const c = probeCounts(10_000, { presentFraction: f });
      expect(c.present + c.absent).toBe(PROBES_PER_POINT);
    }
  });

  it('caps the present half at n and never the absent half — today’s behaviour, kept', () => {
    // n = 10 is the bottom of every sweep: the default there was always 10 + 64.
    expect(probeCounts(10)).toEqual({ present: 10, absent: 64 });
    expect(probeCounts(10, { presentFraction: 1 })).toEqual({ present: 10, absent: 0 });
  });

  it('never leaves a point with no probes at all', () => {
    expect(probeCounts(0, { presentFraction: 1 })).toEqual({ present: 0, absent: 1 });
    expect(buildNumericProbes(new Float64Array(0), 0, { presentFraction: 1 })).toHaveLength(1);
    expect(buildStringProbes([], { presentFraction: 1 })).toHaveLength(1);
  });

  it('clamps out-of-range requests and reads garbage as the default', () => {
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(7)).toBe(1);
    expect(clampFraction(Number.NaN)).toBe(0.5);
    expect(probeCounts(1000, { presentFraction: 2 })).toEqual({ present: 128, absent: 0 });
  });
});

describe('every mix keeps the workload honest', () => {
  const mixes: ProbeMix[] = PROBE_MIX_CHOICES.map((presentFraction) => ({ presentFraction }));

  it('numeric: present probes are stored keys; absent ones are past the max and distinct', () => {
    const keys = numericKeys(generateZipfian(4_000, 400, 1, 5));
    for (const n of [10, 100, 4_000]) {
      const stored = new Set(Array.from(keys.subarray(0, n)));
      const max = Math.max(...stored);
      for (const mix of mixes) {
        const { present, absent } = probeCounts(n, mix);
        const p = Array.from(buildNumericProbes(keys, n, mix));
        expect(p).toHaveLength(present + absent);
        expect(p.slice(0, present).every((k) => stored.has(k))).toBe(true);
        const miss = p.slice(present);
        expect(miss.every((k) => k > max && !stored.has(k))).toBe(true);
        expect(new Set(miss).size).toBe(miss.length);
      }
    }
  });

  it('string: absent probes are derived from stored keys at every mix — never invented', () => {
    const keys = stringKeys(generateStringCorpus(2_000, 4, 9, undefined, 13));
    const stored = new Set(keys);
    for (const mix of mixes) {
      const { present, absent } = probeCounts(keys.length, mix);
      const p = buildStringProbes(keys, mix);
      expect(p.slice(0, present).every((k) => stored.has(k))).toBe(true);
      const miss = p.slice(present);
      expect(miss).toHaveLength(absent);
      expect(miss.every((k) => !stored.has(k))).toBe(true);
      expect(new Set(miss).size).toBe(miss.length);
      // Derived, not invented: each miss is a stored key with only its last character
      // changed — same length, same prefix (docs/METHODOLOGY.md §2.5, CLAUDE.md).
      const seeds = absentSeedsOf(keys, absent);
      miss.forEach((k, i) => {
        const seed = seeds[i % seeds.length];
        expect(k.length).toBe(seed.length);
        expect(k.slice(0, -1)).toBe(seed.slice(0, -1));
      });
    }
  });

  it('a misses-only string run seeds from the data, where the old cycling rule had nothing', () => {
    // The fixed builder seeded misses from its present block. With no present probes that
    // block is empty and every miss would have come from absentLike('') — a one-character
    // string unrelated to the corpus: exactly the invented-key bias §2.5 rules out.
    const keys = stringKeys(generateStringCorpus(500, 6, 6, undefined, 21));
    const miss = buildStringProbes(keys, { presentFraction: 0 });
    expect(miss).toHaveLength(128);
    expect(miss.every((k) => k.length === 6)).toBe(true);
    expect(absentLike('', new Set(keys), 0).length).toBe(1); // what the old rule would have used
  });

  it('spreads the seeds over the whole prefix, not its first third', () => {
    const keys = Array.from({ length: 1_000 }, (_, i) => `k${String(i).padStart(4, '0')}`);
    const seeds = absentSeedsOf(keys, probeCounts(1_000, { presentFraction: 0.75 }).absent);
    expect(seeds).toHaveLength(32);
    expect(seeds[0]).toBe('k0000');
    expect(seeds[31] > 'k0900').toBe(true);
  });

  it('is a pure function of (keys, n, mix) — every structure is handed the same set', () => {
    const keys = numericKeys(generateUniform(3_000, 0, 3_000, true, 2));
    const skeys = stringKeys(generateStringCorpus(800, 3, 8, undefined, 2));
    for (const mix of mixes) {
      expect(bytesOf(buildNumericProbes(keys, 3_000, mix))).toEqual(bytesOf(buildNumericProbes(keys, 3_000, mix)));
      expect(buildStringProbes(skeys, mix)).toEqual(buildStringProbes(skeys, mix));
    }
  });
});

/**
 * What a mix does to each structure's search curve, on the clock-free TS twins (whose
 * per-op counts the conformance corpora tie to the Rust bench twins). These are the claims
 * the UI and METHODOLOGY §4.9 make about the control; each is pinned here rather than asserted
 * from the textbook.
 */
describe('what the mix does to the curves (op-counts, no clock)', () => {
  const meanOps = (search: (k: number) => { ops: number }, probes: ArrayLike<number>) => {
    let sum = 0;
    for (let i = 0; i < probes.length; i++) sum += search(probes[i]).ops;
    return sum / probes.length;
  };
  const HITS: ProbeMix = { presentFraction: 1 };
  const MISSES: ProbeMix = { presentFraction: 0 };

  it('unsorted array: a miss costs exactly n, a hit about n/2 — a constant, not a class', () => {
    const keys = numericKeys(generateUniform(20_000, 0, 1e9, true, 8)); // ~distinct
    const at = (n: number, mix: ProbeMix) => {
      const a = DynArrayF64.fromKeys(Array.from(keys.subarray(0, n)));
      return meanOps((k) => a.search(k), buildNumericProbes(keys, n, mix));
    };
    for (const n of [2_000, 20_000]) {
      expect(at(n, MISSES)).toBe(n);
      const hit = at(n, HITS);
      expect(hit / n).toBeGreaterThan(0.45);
      expect(hit / n).toBeLessThan(0.55);
    }
    // Both mixes grow 10× over a 10× ladder: the class does not move.
    expect(at(20_000, HITS) / at(2_000, HITS)).toBeCloseTo(10, 0);
    expect(at(20_000, MISSES) / at(2_000, MISSES)).toBe(10);
  });

  it('hash set: flat in n at both extremes', () => {
    const keys = numericKeys(generateUniform(20_000, 0, 1e9, true, 8));
    for (const mix of [HITS, MISSES]) {
      const at = (n: number) => {
        const s = HashSetF64.fromKeys(Array.from(keys.subarray(0, n)));
        return meanOps((k) => s.search(k), buildNumericProbes(keys, n, mix));
      };
      expect(at(20_000) / at(1_000)).toBeLessThan(1.5);
    }
  });

  it('skip list: the above-max misses are its cheaper query (METHODOLOGY §4 hurdle 9)', () => {
    const keys = numericKeys(generateUniform(10_000, 0, 1e9, true, 8));
    const s = SkipListF64.fromKeys(Array.from(keys));
    const hits = meanOps((k) => s.search(k), buildNumericProbes(keys, 10_000, HITS));
    const misses = meanOps((k) => s.search(k), buildNumericProbes(keys, 10_000, MISSES));
    expect(misses).toBeLessThan(hits);
  });

  it('trie: a derived miss walks the whole key like a hit, so its cost does not move with the mix', () => {
    const keys = stringKeys(generateStringCorpus(5_000, 3, 12, undefined, 4));
    const t = TrieStr.fromKeys(keys);
    const mean = (mix: ProbeMix) => {
      const probes = buildStringProbes(keys, mix);
      return probes.reduce((acc, p) => acc + t.search(p).ops, 0) / probes.length;
    };
    const hits = mean(HITS);
    // Exactly equal, not just close: a hit and a last-character miss both cost 1 + L, and
    // the hit spread and the seed spread are the same 128 keys at either extreme.
    expect(mean(MISSES)).toBe(hits);
    expect(mean(DEFAULT_PROBE_MIX)).toBeCloseTo(hits, 0);
  });
});

describe('provenance', () => {
  it('summarises a mix with the counts it produced at the top of the sweep', () => {
    const s = summarizeMix(DEFAULT_PROBE_MIX, 100_000);
    expect(s).toEqual({ presentFraction: 0.5, present: 64, absent: 64, atN: 100_000 });
    expect(describeMix(s)).toBe(
      'search probes: 50% present / 50% absent (64 + 64 per point at n = 100,000, the calibrated default)',
    );
    expect(describeMix(summarizeMix({ presentFraction: 0 }, 10))).toBe(
      'search probes: 0% present / 100% absent (0 + 128 per point at n = 10)',
    );
  });
});
