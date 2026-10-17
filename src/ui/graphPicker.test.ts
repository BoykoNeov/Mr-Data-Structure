import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRAPH_PICKER,
  GRAPH_FAMILIES,
  MAX_PICKER_DEGREE,
  buildGraphSource,
  describeEdgeList,
  parsePickerEdgeList,
} from './graphPicker';

describe('graph picker', () => {
  it('defaults to the synthetic random family at degree 4', () => {
    expect(buildGraphSource(DEFAULT_GRAPH_PICKER)).toEqual({ kind: 'random', degree: 4, seed: 1 });
    expect(GRAPH_FAMILIES.map((f) => f.family)).toEqual(['random', 'path', 'grid', 'edge-list']);
  });

  it('builds the other synthetic families and rejects a nonsense degree', () => {
    expect(buildGraphSource({ ...DEFAULT_GRAPH_PICKER, family: 'path' })).toEqual({ kind: 'path' });
    expect(buildGraphSource({ ...DEFAULT_GRAPH_PICKER, family: 'grid' })).toEqual({ kind: 'grid' });
    expect(() => buildGraphSource({ ...DEFAULT_GRAPH_PICKER, degree: Number.NaN })).toThrow(/average degree/);
    expect(() => buildGraphSource({ ...DEFAULT_GRAPH_PICKER, degree: MAX_PICKER_DEGREE + 1 })).toThrow(/average degree/);
  });

  it('parses an edge list with the chosen options, and refuses one too small to sweep', () => {
    const text = '# comment\nfrom\tto\n' + Array.from({ length: 25 }, (_, i) => `0${i}\t0${i + 1}`).join('\n');
    const state = { ...DEFAULT_GRAPH_PICKER, family: 'edge-list' as const, text, delimiter: 'tab' as const, header: true };
    const list = parsePickerEdgeList(state);
    expect(list?.labels[0]).toBe('00'); // a label, never Number('00')
    const src = buildGraphSource(state);
    expect(src.kind).toBe('edge-list');
    expect(() => buildGraphSource({ ...state, header: false, text: 'a\tb\n' })).toThrow(/at least 20 edges \(got 1\)/);
    expect(parsePickerEdgeList(DEFAULT_GRAPH_PICKER)).toBeNull();
  });

  it('summarises what it understood before anything is measured', () => {
    const list = parsePickerEdgeList({
      ...DEFAULT_GRAPH_PICKER,
      family: 'edge-list',
      text: 'x,y,3\ny,y\nlonely\ny,z\n',
    });
    expect(list).not.toBeNull();
    if (!list) return;
    const s = describeEdgeList(list);
    expect(s).toContain('3 edges between 3 vertices');
    expect(s).toContain('traversals start at “x”');
    expect(s).toContain('1 self-loop kept');
    expect(s).toContain('1 line without two labels skipped');
    expect(s).toContain('extra columns ignored on 1 line');
  });
});
