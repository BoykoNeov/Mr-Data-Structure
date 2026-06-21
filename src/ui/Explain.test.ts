import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Callout, ChartGuide, ComplexityLadder } from './Explain';

/**
 * Render-smoke + honesty guard for the pedagogical blocks. App.tsx has no unit
 * test (it's covered by the browser gate), so this is the one place that pins the
 * non-negotiable measurement caveats (docs/PLAN.md §2.3, §7.2) in the rendered
 * copy — if a future "tighten the wording" edit drops "this machine" or the
 * slope-is-headline framing, this fails rather than silently shipping an
 * over-claim.
 */
describe('Explain', () => {
  it('renders the callout, ladder, and chart guide to markup', () => {
    expect(
      renderToStaticMarkup(createElement(Callout, { title: 'T', children: 'body' })),
    ).toContain('body');
    expect(renderToStaticMarkup(createElement(ComplexityLadder))).toContain('O(1)');
    expect(renderToStaticMarkup(createElement(ChartGuide))).toContain('log-log');
  });

  it('keeps the measurement-honesty caveats in the chart guide', () => {
    const html = renderToStaticMarkup(createElement(ChartGuide));
    // wall-clock is machine-specific, not a universal truth (§2.3, §6.5)
    expect(html).toMatch(/this browser and CPU/i);
    // slope is the headline; the auto-label is only a hint (§7.2)
    expect(html).toMatch(/slope is the headline/i);
    // log n / n / n log n are empirically ambiguous (R3, §7.2)
    expect(html).toMatch(/ambiguous/i);
    // op-counts compare shape, not magnitude across structures (§2.3)
    expect(html).toMatch(/shape, not size/i);
    // the data is generated, not user-loaded (Phase 5)
    expect(html).toMatch(/generated/i);
  });
});
