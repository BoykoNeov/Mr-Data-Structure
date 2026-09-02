import { describe, it, expect } from 'vitest';
import { buildDataset, describeDataset, DEFAULT_PICKER, GENERATORS } from './DatasetPicker';

describe('DatasetPicker.buildDataset', () => {
  it('builds every generator kind with the requested n, never de-duplicating', () => {
    for (const g of GENERATORS) {
      const d = buildDataset({ ...DEFAULT_PICKER, kind: g.kind, n: 500 });
      expect(d.size).toBe(500);
      expect(d.keyType).toBe('number');
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

  it('describes provenance for captions', () => {
    expect(describeDataset(buildDataset({ ...DEFAULT_PICKER, kind: 'sorted', n: 12 }))).toMatch(/^sorted — 12 number keys$/);
    expect(describeDataset(buildDataset({ ...DEFAULT_PICKER, n: 12 }))).toMatch(/uniform — 12 number keys \(seed 7\)/);
  });
});
