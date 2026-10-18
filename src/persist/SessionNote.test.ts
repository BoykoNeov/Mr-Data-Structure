import { describe, it, expect } from 'vitest';
import { FORGET_LABEL, sessionNoteText } from './SessionNote';

const fmt = (iso: string) => `<${iso}>`;

describe('sessionNoteText', () => {
  it('a restored load says the charts are measured fresh and names when it was saved', () => {
    const { text, showForget } = sessionNoteText(
      { storageAvailable: true, restoredFrom: '2026-10-17T12:00:00.000Z', cleared: false },
      fmt,
    );
    // The browser gate keys on these two phrases (scripts/verify-browser.mjs, first pass).
    expect(text).toContain('Restored from this browser');
    expect(text).not.toContain('in this browser only');
    expect(text).toContain('saved <2026-10-17T12:00:00.000Z>');
    expect(text).toContain('measured fresh on this load');
    expect(text).toContain('machine- and moment-specific');
    expect(text).toContain('nothing measured is ever saved');
    expect(showForget).toBe(true);
  });

  it('says it is local only, and offers forget, on a default load', () => {
    const { text, showForget } = sessionNoteText({ storageAvailable: true, restoredFrom: null, cleared: false }, fmt);
    expect(text).toContain('in this browser only');
    expect(text).not.toContain('Restored from this browser');
    expect(text).toContain('nothing is uploaded');
    // The graph's edge list is stored too, so the note must say so — forget clears it as well.
    expect(text).toContain('a pasted edge list included');
    expect(showForget).toBe(true);
  });

  it('says plainly when the browser will not save, and offers nothing to forget', () => {
    const { text, showForget } = sessionNoteText({ storageAvailable: false, restoredFrom: null, cleared: false }, fmt);
    expect(text).toContain('reload starts from the defaults');
    expect(showForget).toBe(false);
  });

  it('confirms a forget, and that the next run saves again', () => {
    const { text } = sessionNoteText(
      { storageAvailable: true, restoredFrom: '2026-10-17T12:00:00.000Z', cleared: true },
      fmt,
    );
    expect(text).toContain('forgotten');
    expect(text).toContain('Running again, measuring the graph, or changing a chart or tab setting starts saving again');
  });

  it('cannot steal the browser gate’s click on the run button', () => {
    // scripts/verify-browser.mjs drives the run by getByRole('button', { name: /run the sweeps/i }).
    expect(FORGET_LABEL).not.toMatch(/run the sweeps/i);
  });
});
