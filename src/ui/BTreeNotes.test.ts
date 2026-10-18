import { describe, it, expect } from 'vitest';
import { btreeSheetNote } from './BTreeNotes';

describe('btreeSheetNote', () => {
  it('is absent unless the B-tree’s line is on an exported chart', () => {
    expect(btreeSheetNote(['array', 'avl', 'bst'])).toBeNull();
    expect(btreeSheetNote([])).toBeNull();
  });

  it('carries the locality caveat onto the PNG without claiming the B-tree is faster', () => {
    const note = btreeSheetNote(['array', 'btree', 'avl']);
    expect(note).toMatch(/node hops/);
    expect(note).toMatch(/op-count does not count/);
    expect(note).toMatch(/memory, not extra or less work/);
    // The gate only logs the clock comparison (`btree hypothesis (info only)`), so the caption
    // must not turn it into a claim.
    expect(note).not.toMatch(/faster|quicker|beats|outperform/i);
  });
});
