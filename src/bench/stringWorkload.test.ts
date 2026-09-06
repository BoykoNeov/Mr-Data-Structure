import { describe, it, expect } from 'vitest';
import { generateStringCorpus } from '../data';
import { decodeStringKeys, encodeStringKeys } from '../data/marshal';
import {
  absentLike,
  buildStringProbes,
  churnKeyFor,
  medianLengthKey,
  prefixOf,
  ABSENT_STRING_PROBES,
  PRESENT_STRING_PROBES,
} from './stringWorkload';

/**
 * The string workload carries two measurement decisions (docs/METHODOLOGY.md §2.5) that a
 * later simplification would quietly reverse. These pin them the way the Rust side pins
 * the heap's churn key with `a_high_churn_key_would_drain_the_heap`: not "does it run",
 * but "does the shortcut that looks equivalent actually break it".
 */
describe('absentLike', () => {
  it('returns a key that is absent — and the same length as the one it came from', () => {
    const keys = generateStringCorpus(500, 3, 8, undefined, 11).keys as readonly string[];
    const stored = new Set(keys);
    for (let i = 0; i < 50; i++) {
      const seed = keys[i * 7];
      const absent = absentLike(seed, stored, i);
      expect(stored.has(absent)).toBe(false);
      // Length-preserving is the whole point. Rust compares string slices length-first, so
      // a probe of unique length bails out of every comparison on the length check —
      // understating the array's per-byte scan while overstating the hash set's per-key
      // cost. Two structures biased opposite ways on the chart that compares them.
      expect(absent.length).toBe(seed.length);
    }
  });

  it('never collides with keys already handed out', () => {
    const keys = ['aa', 'ab', 'ac'];
    const taken = new Set(keys);
    const first = absentLike('aa', taken, 0);
    taken.add(first);
    const second = absentLike('aa', taken, 0);
    expect(second).not.toBe(first);
    expect(new Set([first, second]).size).toBe(2);
  });

  it('falls back to a longer key only when a corpus exhausts its alphabet', () => {
    // Every single-character mutation is already stored, so length-preserving is
    // impossible and the documented fallback takes over.
    const all = new Set([...'abcdefghijklmnopqrstuvwxyz0123456789'].map((c) => c));
    const absent = absentLike('a', all, 0);
    expect(all.has(absent)).toBe(false);
    expect(absent.length).toBeGreaterThan(1);
  });

  it('handles an empty seed without looping', () => {
    expect(absentLike('', new Set(['a']), 0)).not.toBe('');
  });
});

describe('churnKeyFor', () => {
  it('takes its length from a typical key, not from whichever row arrived first', () => {
    // A corpus whose first row is atypically short. Seeding from `keys[0]` would cycle a
    // 1-character key and let row order move the measured mutation constant.
    const keys = ['x', ...Array.from({ length: 99 }, (_, i) => `key${String(i).padStart(5, '0')}`)];
    expect(medianLengthKey(keys).length).toBe(8);
    const churn = churnKeyFor(keys);
    expect(new Set(keys).has(churn)).toBe(false);
    expect(churn.length).toBe(8);
  });

  it('is absent from the corpus it was derived from', () => {
    const keys = generateStringCorpus(300, 4, 4, undefined, 5).keys as readonly string[];
    expect(new Set(keys).has(churnKeyFor(keys))).toBe(false);
  });
});

describe('buildStringProbes', () => {
  it('mixes present keys with absent ones drawn from the same corpus', () => {
    const keys = generateStringCorpus(1000, 3, 8, undefined, 2).keys as readonly string[];
    const stored = new Set(keys);
    const probes = buildStringProbes(keys);
    expect(probes).toHaveLength(PRESENT_STRING_PROBES + ABSENT_STRING_PROBES);
    const present = probes.slice(0, PRESENT_STRING_PROBES);
    const absent = probes.slice(PRESENT_STRING_PROBES);
    expect(present.every((p) => stored.has(p))).toBe(true);
    expect(absent.every((p) => !stored.has(p))).toBe(true);
    // The absent half must not be a block of identical keys either — a repeated probe
    // would sit in cache and make the "absent" half cheaper than it really is.
    expect(new Set(absent).size).toBe(absent.length);
  });

  it('still produces a workload when the corpus is smaller than the probe block', () => {
    const probes = buildStringProbes(['aa', 'bb']);
    expect(probes).toHaveLength(2 + ABSENT_STRING_PROBES);
  });
});

describe('prefixOf', () => {
  it('yields a valid offsets+bytes pair covering exactly the first n keys', () => {
    const keys = generateStringCorpus(200, 1, 12, undefined, 9).keys as readonly string[];
    const { offsets, bytes } = encodeStringKeys(keys);
    for (const n of [0, 1, 37, 200]) {
      const p = prefixOf(offsets, bytes, n);
      // The claim the JSDoc makes: keys are contiguous and offsets[0] === 0, so the views
      // round-trip through the same decode the Rust side runs.
      expect(p.offsets.length).toBe(n + 1);
      expect(decodeStringKeys(p.offsets, p.bytes, n)).toEqual(keys.slice(0, n));
      expect(p.bytes.length).toBe(offsets[n]);
    }
  });

  it('clamps past the end rather than reading out of bounds', () => {
    const { offsets, bytes } = encodeStringKeys(['a', 'bb']);
    const p = prefixOf(offsets, bytes, 99);
    expect(decodeStringKeys(p.offsets, p.bytes)).toEqual(['a', 'bb']);
  });

  it('does not copy — the views share the caller’s buffer', () => {
    const { offsets, bytes } = encodeStringKeys(['abc', 'de']);
    const p = prefixOf(offsets, bytes, 1);
    expect(p.bytes.buffer).toBe(bytes.buffer);
    expect(p.offsets.buffer).toBe(offsets.buffer);
  });
});
