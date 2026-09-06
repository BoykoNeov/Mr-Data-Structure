import { describe, it, expect } from 'vitest';
import { buildDataset, describeDataset, DEFAULT_PICKER, GENERATORS, keyTypeOf } from './DatasetPicker';

describe('DatasetPicker.buildDataset', () => {
  it('builds every generator kind with the requested n, never de-duplicating', () => {
    for (const g of GENERATORS) {
      const d = buildDataset({ ...DEFAULT_PICKER, kind: g.kind, n: 500 });
      expect(d.size).toBe(500);
      // Each generator declares which key type — and therefore which sweep — it drives.
      expect(d.keyType).toBe(g.keyType);
      expect(keyTypeOf(g.kind)).toBe(g.keyType);
      expect(d.order.kind).toBe(g.kind);
    }
    const z = buildDataset({ ...DEFAULT_PICKER, kind: 'zipfian', n: 500 });
    expect(new Set(z.keys as readonly number[]).size).toBeLessThan(500); // duplicate-heavy by design
  });

  it('parses a pasted CSV with a chosen key field, keeping order', () => {
    const d = buildDataset({
      ...DEFAULT_PICKER,
      source: 'paste',
      text: 'id,name\n9,a\n3,b\n7,c\n',
      keyField: 'id',
    });
    expect(d.keyType).toBe('number');
    expect(d.keys).toEqual([9, 3, 7]);
    expect(d.order.kind).toBe('as-loaded');
  });

  it('parses pasted JSON and a single-column paste without a key field', () => {
    const j = buildDataset({ ...DEFAULT_PICKER, source: 'paste', text: '[{"k": 1}, {"k": 2}]', keyField: '' });
    expect(j.keys).toEqual([1, 2]);
    const c = buildDataset({ ...DEFAULT_PICKER, source: 'paste', text: 'k\n5\n4\n', keyField: '' });
    expect(c.keys).toEqual([5, 4]);
  });

  it('explains an empty paste and a missing key field', () => {
    expect(() => buildDataset({ ...DEFAULT_PICKER, source: 'paste', text: '  ' })).toThrow(/paste some/);
    expect(() => buildDataset({ ...DEFAULT_PICKER, source: 'paste', text: 'a,b\n1,2\n' })).toThrow(/keyField/);
  });

  it('builds a string corpus at the requested key length — the run’s second cost axis', () => {
    const d = buildDataset({ ...DEFAULT_PICKER, kind: 'string-corpus', n: 200, minLen: 12, maxLen: 12 });
    expect(d.keyType).toBe('string');
    expect(new Set((d.keys as readonly string[]).map((k) => k.length))).toEqual(new Set([12]));
    // A reversed range still yields keys rather than throwing (max clamps up to min).
    const clamped = buildDataset({ ...DEFAULT_PICKER, kind: 'string-corpus', n: 20, minLen: 9, maxLen: 2 });
    expect((clamped.keys as readonly string[]).every((k) => k.length === 9)).toBe(true);
  });

  it('puts the key length in a string dataset’s caption — the run’s second cost axis', () => {
    const short = buildDataset({ ...DEFAULT_PICKER, kind: 'string-corpus', n: 50, minLen: 3, maxLen: 8 });
    const long = buildDataset({ ...DEFAULT_PICKER, kind: 'string-corpus', n: 50, minLen: 30, maxLen: 40 });
    // Two runs that differ only in key length must not read identically in the one field
    // an exported chart carries its provenance in (docs/METHODOLOGY.md §2.5).
    expect(describeDataset(short)).toMatch(/3–8 chars/);
    expect(describeDataset(long)).toMatch(/30–40 chars/);
    expect(describeDataset(short)).not.toBe(describeDataset(long));
    const fixed = buildDataset({ ...DEFAULT_PICKER, kind: 'string-corpus', n: 50, minLen: 6, maxLen: 6 });
    expect(describeDataset(fixed)).toMatch(/6 chars/);
    // Numeric captions are unchanged.
    expect(describeDataset(buildDataset({ ...DEFAULT_PICKER, n: 12 }))).not.toMatch(/chars/);
  });

  it('describes provenance for captions', () => {
    expect(describeDataset(buildDataset({ ...DEFAULT_PICKER, kind: 'sorted', n: 12 }))).toMatch(/^sorted — 12 number keys$/);
    expect(describeDataset(buildDataset({ ...DEFAULT_PICKER, n: 12 }))).toMatch(/uniform — 12 number keys \(seed 7\)/);
  });
});
