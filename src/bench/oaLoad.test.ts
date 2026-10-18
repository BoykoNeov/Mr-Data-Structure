import { describe, it, expect } from 'vitest';
import type { SweepPoint, SweepSeries, StructureId } from './measure';
import { HashSetOaF64 } from '../structures/hashSetOa';
import { geometricSweep } from './sweep';
import {
  CHAINING_MAX_LOAD,
  DEFAULT_OA_MAX_LOAD,
  OA_MAX_LOAD_CHOICES,
  checkOaMaxLoad,
  isDefaultOaLoad,
  oaCapacity,
  oaLoadReach,
  stampMaxLoad,
} from './oaLoad';

const point = (n: number, storedN?: number): SweepPoint => ({
  n, nanosPerOp: 1, opCount: 1, batch: 1, reps: 1, stddevNanos: 0, minNanos: 1, maxNanos: 1,
  ...(storedN === undefined ? {} : { storedN }),
});

describe('the open-addressing load-factor control (docs/PLAN.md §13)', () => {
  it('defaults to the chaining set’s threshold, and offers it among the choices', () => {
    expect(DEFAULT_OA_MAX_LOAD).toBe(CHAINING_MAX_LOAD);
    expect(OA_MAX_LOAD_CHOICES).toContain(DEFAULT_OA_MAX_LOAD);
    expect(OA_MAX_LOAD_CHOICES).toEqual([0.5, 0.75, 0.9]);
    expect(isDefaultOaLoad(0.75)).toBe(true);
    expect(OA_MAX_LOAD_CHOICES.filter((l) => !isDefaultOaLoad(l))).toEqual([0.5, 0.9]);
  });

  it('rejects, before the worker is called, a threshold the Rust set would trap on', () => {
    for (const l of OA_MAX_LOAD_CHOICES) expect(checkOaMaxLoad(l)).toBe(l);
    for (const bad of [1, 1.5, 0.2, 0, Number.NaN, Infinity]) expect(() => checkOaMaxLoad(bad)).toThrow(/outside/);
  });

  it('computes the capacity the twin actually builds, at every offered threshold', () => {
    const keys = Array.from({ length: 6000 }, (_, i) => i);
    for (const l of OA_MAX_LOAD_CHOICES) {
      for (const n of [0, 1, 3, 4, 7, 50, 100, 777, 1000, 3000, 6000]) {
        expect(oaCapacity(n, l), `L=${l} n=${n}`).toBe(HashSetOaF64.fromKeys(keys.slice(0, n), l).capacity);
      }
    }
  });

  it('reports the load factors a search series really sat at — from the stored count', () => {
    // 100 stored keys: 128 slots at 0.9 (α 0.78), 256 at 0.75 (α 0.39); 10 keys: 16 either way.
    expect(oaLoadReach([point(10), point(100)], 0.9)).toEqual({
      min: 10 / 16, max: 100 / 128, atN: 100, resized: 1, points: 2,
    });
    // A de-duplicated point is read at what the set held, not at its input size.
    expect(oaLoadReach([point(1000, 630)], 0.75)).toEqual({
      min: 630 / 1024, max: 630 / 1024, atN: 1000, resized: 0, points: 1,
    });
    expect(oaLoadReach([], 0.5)).toBeNull();
  });

  it('the browser’s search ladder never reaches the top of the 0.9 sawtooth on distinct keys', () => {
    // The mirror of `hash_set_oa::tests::the_browser_ladders_sample_the_sawtooth_at_fixed_points`:
    // the reason the page prints the α reached, not just the threshold.
    const ladder = geometricSweep(10, 100_000).map((n) => point(n));
    expect(oaLoadReach(ladder, 0.9)).toMatchObject({ max: 0.78125, resized: 5, points: 13 });
    expect(oaLoadReach(ladder, 0.75)).toMatchObject({ max: 0.625, resized: 0 });
    expect(oaLoadReach(ladder, 0.5)).toMatchObject({ max: 0.48828125, resized: 5 });
  });

  it('stamps both hash sets with their thresholds and leaves every other series alone', () => {
    const s = (structure: StructureId): SweepSeries => ({ structure, op: 'search', points: [point(10)] });
    const out = stampMaxLoad([s('array'), s('hashset'), s('hashoa')], 0.5);
    expect(out.map((x) => x.maxLoad)).toEqual([undefined, 0.75, 0.5]);
    expect(out[0]).toEqual(s('array'));
  });
});
