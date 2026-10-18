import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MISS_FORM_CHOICES, summarizeMix, type MissForm } from '../bench/probeMix';
import { MissFormControl, missFormField, missFormLabel, missFormNotes } from './MissFormControl';
import { BstSearchNote, bstSheetNote } from './BstNotes';
import { BTreeSearchNote } from './BTreeNotes';
import { mixNotes } from './ProbeMixControl';
import { CSV_HEADER, toCsv } from './export';
import type { SeriesView } from './SweepChart';
import { fitComplexity } from '../bench/fit';
import type { SweepSeries } from '../bench/measure';

/**
 * The opt-in mid-range miss form (docs/PLAN.md §13 probe-mix item (a)) on every way a run
 * leaves the page: the control, the notes beside the search chart, the PNG caption lines and
 * the CSV. Two rules throughout: under the default form every string is what it was, and
 * under mid-range no copy may still claim the misses sit past the largest key.
 */

const control = (value: MissForm, textRun = false) =>
  renderToStaticMarkup(createElement(MissFormControl, { value, onChange: () => {}, disabled: false, textRun }));

describe('MissFormControl', () => {
  it('names both forms, default first and marked', () => {
    expect(MISS_FORM_CHOICES.map(missFormLabel)).toEqual(['just past the largest key (default)', 'between stored keys']);
  });

  it('renders radios, never a <select> — the gate drives the first <select> on the page', () => {
    const html = control('aboveMax');
    expect(html).not.toMatch(/<select/);
    expect(html.match(/type="radio"/g)).toHaveLength(MISS_FORM_CHOICES.length);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/name="miss-form"/); // its own group, not the probe mix's
  });

  it('says it applies to number keys only, and says so about a text run on screen', () => {
    expect(control('aboveMax')).toMatch(/Number keys only/);
    expect(control('aboveMax')).toMatch(/Text keys ignore this setting/);
    expect(control('midRange', true)).toMatch(/used text keys, so this setting did not apply to it/);
  });

  it('sends nothing at the default, so the run asks exactly what it asked before', () => {
    expect(missFormField('aboveMax')).toEqual({});
    expect(missFormField('midRange')).toEqual({ missForm: 'midRange' });
  });
});

describe('caption lines (the PNG)', () => {
  const def = summarizeMix({ presentFraction: 0 }, 1_000);
  const mid = summarizeMix({ presentFraction: 0, missForm: 'midRange' }, 1_000);

  it('the miss-form note travels only for a mid-range run that asked misses at all', () => {
    expect(missFormNotes(null)).toEqual([]);
    expect(missFormNotes(def)).toEqual([]);
    expect(missFormNotes(summarizeMix({ presentFraction: 1, missForm: 'midRange' }, 1_000))).toEqual([]);
    const [line] = missFormNotes(mid);
    expect(line).toMatch(/between stored keys/);
    expect(line).toMatch(/not the workload the built-in checks were calibrated on/);
  });

  it('a non-default mix drops the above-max allowances under mid-range, and keeps them otherwise', () => {
    const [d] = mixNotes(def, 'number');
    expect(d).toMatch(/just past the largest stored key/);
    expect(d).toMatch(/One exception to “never its slope”: the plain BST/);
    const [m] = mixNotes(mid, 'number');
    expect(m).toMatch(/between stored keys/);
    expect(m).not.toMatch(/past the largest/);
    expect(m).not.toMatch(/cheapest question/);
    // 50/50 mid-range is still the default *fraction*: the mix note stays quiet, the form note speaks.
    expect(mixNotes(summarizeMix({ presentFraction: 0.5, missForm: 'midRange' }, 1_000), 'number')).toEqual([]);
    expect(missFormNotes(summarizeMix({ presentFraction: 0.5, missForm: 'midRange' }, 1_000))).toHaveLength(1);
  });

  it('the BST’s hurdle-15 caption is dropped under mid-range misses, and unchanged under the default', () => {
    const shown = bstSheetNote(['array', 'bst'], 0);
    expect(shown).not.toBeNull();
    expect(bstSheetNote(['array', 'bst'], 0, 'aboveMax')).toBe(shown);
    expect(bstSheetNote(['array', 'bst'], 0, undefined)).toBe(shown);
    expect(bstSheetNote(['array', 'bst'], 0, 'midRange')).toBeNull();
  });
});

describe('the notes under the search chart', () => {
  const bst = (presentFraction: number, missForm?: MissForm, reverse = true) =>
    renderToStaticMarkup(
      createElement(BstSearchNote, { present: true, sorted: reverse, reverse, presentFraction, missForm }),
    );

  it('under the default form the BST note is byte-identical whether the form is named or not', () => {
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      for (const reverse of [false, true]) {
        expect(bst(f, 'aboveMax', reverse)).toBe(bst(f, undefined, reverse));
      }
    }
  });

  it('a misses-only reverse-sorted mid-range run is not warned about — the blind spot does not apply', () => {
    const html = bst(0, 'midRange');
    expect(html).not.toMatch(/Misses only: the purple line sees only one edge/);
    expect(html).not.toMatch(/reads flat/);
    expect(html).not.toMatch(/right-hand edge\. Found keys/);
    expect(html).toMatch(/fall <em>between<\/em> stored keys/);
    expect(html).toMatch(/does not apply/);
    // …and at the default fraction the quiet allowance gives way to the same line.
    const mixed = bst(0.5, 'midRange', false);
    expect(mixed).not.toMatch(/all above the largest stored key/);
    expect(mixed).toMatch(/does not apply/);
    // Hits only asks no misses at all: nothing about them, either form.
    expect(bst(1, 'midRange')).not.toMatch(/missing keys/);
  });

  it('the B-tree note names the above-max queries only when the run had them', () => {
    const plain = renderToStaticMarkup(createElement(BTreeSearchNote, { present: true }));
    expect(plain).toMatch(/just past the largest key/);
    expect(renderToStaticMarkup(createElement(BTreeSearchNote, { present: true, midRangeMisses: false }))).toBe(plain);
    const mid = renderToStaticMarkup(createElement(BTreeSearchNote, { present: true, midRangeMisses: true }));
    expect(mid).not.toMatch(/past the largest/);
    expect(mid).toMatch(/between stored keys/);
  });
});

describe('the CSV carries the form on its rows, and only when it is not the default', () => {
  const series: SweepSeries = {
    structure: 'bst',
    op: 'search',
    points: [{ n: 10, nanosPerOp: 1, minNanos: 1, maxNanos: 1, stddevNanos: 0, opCount: 5, batch: 1, reps: 1, storedN: 10 }],
  };
  const view: SeriesView = { series, fit: fitComplexity([10, 100], [1, 1]), color: '#000' };

  it('no run columns: the bytes it always exported', () => {
    expect(toCsv([view])).toBe(`${CSV_HEADER}\nbst,search,10,1,1,1,0,5,1,1,10,\n`);
    expect(toCsv([view], {})).toBe(toCsv([view]));
  });

  it('mid-range: one trailing column, on the header and every row', () => {
    const [head, row] = toCsv([view], { search_misses: 'mid-range' }).trim().split('\n');
    expect(head).toBe(`${CSV_HEADER},search_misses`);
    expect(row).toBe('bst,search,10,1,1,1,0,5,1,1,10,,mid-range');
  });
});
