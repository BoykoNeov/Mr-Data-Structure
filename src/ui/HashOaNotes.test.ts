import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OA_MAX_LOAD_CHOICES } from '../bench/oaLoad';
import { OaLoadControl, OaLoadNote, describeOaLoad, oaLoadChoiceLabel, oaLoadSheetNote } from './HashOaNotes';

/**
 * Honesty guard for the open-addressing load-factor control (docs/PLAN.md §13). At any
 * threshold but 0.75 the two hash sets stop being like for like, and the copy saying so must
 * appear exactly then — beside both charts and on the exported image — and never at the default.
 */
const REACH = { min: 0.31, max: 0.49, atN: 1000, resized: 5, points: 13 };
const note = (maxLoad: number, chart: 'search' | 'churn', reach = REACH) =>
  renderToStaticMarkup(createElement(OaLoadNote, { maxLoad, reach: chart === 'search' ? reach : null, chart }));

describe('open-addressing load-factor notes', () => {
  it('labels each choice, marking the default as the chaining set’s', () => {
    expect(OA_MAX_LOAD_CHOICES.map(oaLoadChoiceLabel)).toEqual([
      '0.5 — roomier, linear probing’s usual ceiling',
      '0.75 (default — the chaining set’s)',
      '0.9 — fuller',
    ]);
    expect(describeOaLoad(0.5)).toBe('open-addressing hash set max load 0.5 (chaining hash set: 0.75)');
  });

  it('says nothing at the default — on the page or on the PNG', () => {
    expect(note(0.75, 'search')).toBe('');
    expect(note(0.75, 'churn')).toBe('');
    expect(oaLoadSheetNote(0.75, { ...REACH, resized: 0 })).toBeNull();
  });

  it('flags every non-default run as not like for like, beside both charts', () => {
    for (const l of [0.5, 0.9]) {
      for (const chart of ['search', 'churn'] as const) {
        const html = note(l, chart);
        expect(html).toMatch(new RegExp(`Not like for like: the light-blue hash set ran at max load ${l}`));
        expect(html).toMatch(/always rehashes at 0\.75/);
      }
    }
    expect(note(0.5, 'search')).toMatch(/emptier/);
    expect(note(0.9, 'search')).toMatch(/roughly 50 at 90% full/);
    // The churn note says what the pinned order-independence test says, not "the tables differ".
    expect(note(0.9, 'churn')).toMatch(/the add\/remove line and the delete half of the split are the 0\.75 ones exactly/);
    expect(note(0.9, 'churn')).toMatch(/count toward the ceiling too/);
    expect(note(0.9, 'search')).toMatch(/a different size from the 0\.75 one at 5 of this run’s 13 search sizes/);
    expect(note(0.9, 'search', { ...REACH, resized: 0 })).toMatch(/At all 13 of this run’s search sizes/);
  });

  it('puts the same warning, and the load factors actually reached, on the PNG caption', () => {
    const line = oaLoadSheetNote(0.9, { min: 0.49, max: 0.78125, atN: 100, resized: 5, points: 13 });
    expect(line).toMatch(/max load 0\.9, not the chaining set’s 0\.75/);
    expect(line).toMatch(/not like for like/);
    expect(line).toMatch(/from 0\.49 to 0\.78 \(the fullest at n = 100\)/);
    // The default ladder never catches a 0.9 table near its ceiling, and the caption says so.
    expect(line).toMatch(/none of them near the 0\.9 ceiling/);
    expect(line).toMatch(/at 5 of this run’s 13 search sizes/);
    expect(line).toMatch(/add\/remove line and the delete half of the split are the 0\.75 ones exactly/);
    // A run that did reach its ceiling is not told it missed it.
    expect(oaLoadSheetNote(0.5, REACH)).not.toMatch(/none of them near/);
  });

  it('is radio buttons, never a <select> (the gate drives the first <select> on the page)', () => {
    const html = renderToStaticMarkup(createElement(OaLoadControl, { value: 0.75, onChange: () => {}, disabled: false }));
    expect(html).not.toMatch(/<select/);
    expect(html.match(/type="radio"/g)).toHaveLength(OA_MAX_LOAD_CHOICES.length);
    expect(html).toMatch(/name="oa-max-load"/);
  });
});
