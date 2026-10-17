import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DllChurnCaveat, DllSearchNote, dllSheetNote } from './DoublyListNotes';

/**
 * Honesty guard for the doubly linked list's copy (docs/METHODOLOGY.md §2.3 regime 7, §2.11).
 * The flat churn line is true and misleading at once, so the claims that keep it honest must
 * not be "tightened" away — the same reason `Explain.test.ts` pins the chart guide's caveats.
 */
describe('doubly-linked-list notes', () => {
  it('the churn caveat points at the O(n) delete-by-value and says no key fixes the flat line', () => {
    const html = renderToStaticMarkup(createElement(DllChurnCaveat));
    expect(html).toMatch(/same trap/);
    expect(html).toMatch(/O\(n\)/);
    expect(html).toMatch(/No choice of key changes that/);
    expect(html).toMatch(/delete/);
  });

  it('the churn caveat says the back pointer buys nothing here, and what it costs', () => {
    const html = renderToStaticMarkup(createElement(DllChurnCaveat));
    expect(html).toMatch(/exactly the same number of steps/);
    expect(html).toMatch(/you already hold/);
    expect(html).toMatch(/24 bytes/);
  });

  it('the search note explains why the two list lines coincide on op-count', () => {
    const html = renderToStaticMarkup(createElement(DllSearchNote));
    expect(html).toMatch(/exactly the same steps/);
    expect(html).toMatch(/op-count/);
  });

  it('the PNG caption travels only when the doubly list is on the sheet, and carries both claims', () => {
    expect(dllSheetNote(['array', 'll', 'hashset'])).toBeNull();
    const note = dllSheetNote(['ll', 'dll']);
    expect(note).not.toBeNull();
    // The flat line's qualifier — the same rule that binds the singly list's exported curve.
    expect(note).toMatch(/O\(n\) delete row/);
    expect(note).toMatch(/just put at its own head/);
    // And the finding: no count changes.
    expect(note).toMatch(/exactly the same steps/);
  });
});
