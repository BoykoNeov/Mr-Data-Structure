import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BstSearchNote, bstSheetNote } from './BstNotes';

/**
 * Honesty guard for the BST's search line (docs/METHODOLOGY.md §4 hurdle 15). The shared
 * absent probes sit above every stored key, so on reverse-sorted data a misses-only run charts
 * an O(n) chain as flat. The copy that says so must appear exactly when it can happen, and must
 * travel with an exported image.
 */
const note = (props: {
  present?: boolean;
  sorted?: boolean;
  reverse?: boolean;
  presentFraction?: number;
}) =>
  renderToStaticMarkup(
    createElement(BstSearchNote, {
      present: props.present ?? true,
      sorted: props.sorted ?? false,
      reverse: props.reverse ?? false,
      presentFraction: props.presentFraction,
    }),
  );

describe('BST search notes', () => {
  it('renders nothing when the BST is not on the chart', () => {
    expect(note({ present: false, presentFraction: 0 })).toBe('');
  });

  it('at the default mix it is a quiet note that still names the blind spot', () => {
    const html = note({ presentFraction: 0.5 });
    expect(html).toMatch(/the same search, different shapes/);
    expect(html).toMatch(/right-hand edge/);
    expect(html).toMatch(/misses only/);
    expect(html).not.toMatch(/This run asked only for keys that are missing/);
  });

  it('on sorted data it says the BST search is a walk down a chain, O(n)', () => {
    const html = note({ sorted: true, presentFraction: 0.5 });
    expect(html).toMatch(/This dataset is sorted/);
    expect(html).toMatch(/O\(n\)/);
  });

  it('a misses-only reverse-sorted run gets the loud form: flat line, O(n) chain, re-run with hits', () => {
    const html = note({ sorted: true, reverse: true, presentFraction: 0 });
    expect(html).toMatch(/Misses only: the purple line sees only one edge of the BST/);
    expect(html).toMatch(/reads flat, O\(1\), for a tree that is really an O\(n\)/);
    expect(html).toMatch(/some hits in the mix/);
  });

  it('a misses-only run on other data still warns, without claiming the line is flat', () => {
    const html = note({ presentFraction: 0 });
    expect(html).toMatch(/Misses only/);
    expect(html).toMatch(/lower\s+and flatter than the tree really is/);
    expect(html).not.toMatch(/for a tree that is really an O\(n\)/);
  });

  it('the PNG caption travels only on a misses-only run with the BST on the sheet', () => {
    expect(bstSheetNote(['array', 'bst'], 0.5)).toBeNull();
    expect(bstSheetNote(['array', 'avl'], 0)).toBeNull();
    expect(bstSheetNote(['bst'], undefined)).toBeNull();
    const caption = bstSheetNote(['array', 'bst', 'avl'], 0);
    expect(caption).toMatch(/only for missing keys/);
    expect(caption).toMatch(/flat for an O\(n\) chain/);
    expect(caption).toMatch(/hits in the mix/);
  });
});
