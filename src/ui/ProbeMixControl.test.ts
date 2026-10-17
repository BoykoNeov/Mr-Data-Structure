import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PROBE_MIX_CHOICES, summarizeMix } from '../bench/probeMix';
import { choiceLabel, mixNotes, ProbeMixControl, shareWord } from './ProbeMixControl';

describe('ProbeMixControl', () => {
  it('names each choice, marking the calibrated default', () => {
    expect(PROBE_MIX_CHOICES.map(choiceLabel)).toEqual([
      'misses only',
      '25% hits',
      '50% hits (default)',
      '75% hits',
      'hits only',
    ]);
  });

  it('says the absent share in words for the search callout', () => {
    // `1 − presentFraction` for each offered choice — what CompareSection passes.
    expect(PROBE_MIX_CHOICES.map((f) => shareWord(1 - f))).toEqual([
      'all', 'three quarters', 'half', 'a quarter', 'none',
    ]);
    expect(shareWord(0.4)).toBe('40%');
  });

  it('adds caption lines only for a non-default mix, and says the right thing per key type', () => {
    expect(mixNotes(summarizeMix({ presentFraction: 0.5 }, 1000), 'number')).toEqual([]);
    const [num] = mixNotes(summarizeMix({ presentFraction: 0 }, 1000), 'number');
    expect(num).toMatch(/0% hits \/ 100% misses/);
    expect(num).toMatch(/never its slope/);
    expect(num).toMatch(/skip list/);
    const [str] = mixNotes(summarizeMix({ presentFraction: 1 }, 1000), 'string');
    expect(str).toMatch(/trie/);
    expect(str).not.toMatch(/skip list/);
  });

  it('renders radios, never a <select> — the gate drives the first <select> on the page', () => {
    const html = renderToStaticMarkup(
      createElement(ProbeMixControl, { value: 0.5, onChange: () => {}, disabled: false }),
    );
    expect(html).not.toMatch(/<select/);
    expect(html.match(/type="radio"/g)).toHaveLength(PROBE_MIX_CHOICES.length);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });
});
