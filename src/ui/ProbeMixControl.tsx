import {
  DEFAULT_PRESENT_FRACTION,
  PROBE_MIX_CHOICES,
  PROBES_PER_POINT,
  type ProbeMixSummary,
} from '../bench/probeMix';

/**
 * The **probe-mix** control (docs/PLAN.md §6.3 "Mix of present/absent keys is configurable"):
 * what share of the search sweep's lookups ask for keys the structures hold. It sits after
 * the dataset panel and applies to the *next* run — the charts on screen keep the mix they
 * were measured at, which the captions and exports report from the result, not from here.
 *
 * Radio buttons rather than a `<select>`, deliberately: the browser gate drives the dataset
 * picker with `page.locator('select').first()`, so a new `<select>` placed above it in the DOM
 * would silently steal that call. Radios cannot.
 *
 * The text helpers are pure so the wording is tested without a DOM.
 */

/** A spoken share: `half`, `a quarter`, … — falling back to a percentage. */
export function shareWord(fraction: number): string {
  const words: Record<string, string> = {
    '0': 'none',
    '0.25': 'a quarter',
    '0.5': 'half',
    '0.75': 'three quarters',
    '1': 'all',
  };
  return words[String(fraction)] ?? `${Math.round(fraction * 100)}%`;
}

/** The radio label for one mix choice. */
export function choiceLabel(presentFraction: number): string {
  if (presentFraction === 0) return 'misses only';
  if (presentFraction === 1) return 'hits only';
  const pct = Math.round(presentFraction * 100);
  const base = `${pct}% hits`;
  return presentFraction === DEFAULT_PRESENT_FRACTION ? `${base} (default)` : base;
}

/**
 * What a non-default mix does to the search chart, as caption lines that travel with an
 * exported image (CLAUDE.md: prose in the DOM does not). Empty at the default — the default
 * is the workload every other note on the page already describes.
 *
 * The claims, each a property of the algorithms rather than of this run:
 * - a scan (unsorted array, linked list, min-heap) stops at a hit, so its constant moves
 *   between ≈ n/2 per probe (hits) and exactly n (misses) — the slope does not;
 * - the hash sets' cost is flat at every mix — a miss walks a whole chain, a hit part of one;
 * - numeric absent keys sit past the largest stored key, which is the skip list's *cheapest*
 *   question, so more misses pull its line down against the sorted array's (§4 hurdle 9);
 * - for the trie, a derived string miss (a stored key with its last byte changed) and a hit
 *   both walk the whole key, so its count barely moves with the mix (§2.5) — pinned on the
 *   TS twin by `probeMix.test.ts`.
 */
export function mixNotes(s: ProbeMixSummary, keyType: 'number' | 'string'): string[] {
  if (s.presentFraction === DEFAULT_PRESENT_FRACTION) return [];
  const pct = Math.round(s.presentFraction * 100);
  const lead =
    `Search was measured at ${pct}% hits / ${100 - pct}% misses, not the 50/50 default the runtime ` +
    'checks are calibrated on. A mix moves a line up or down, never its slope: a scan stops at a hit ' +
    '(about n/2 steps) but must read all n for a miss, and a hash set stays flat either way. ';
  const tail =
    keyType === 'number'
      ? 'The misses sit just past the largest stored key, which is the skip list’s cheapest question, so ' +
        'more misses pull its line down against the sorted array’s (METHODOLOGY §4.9).'
      : 'Each miss is a stored key with its last character changed, so a trie walks the whole key for a ' +
        'miss as for a hit and its line barely moves with the mix (METHODOLOGY §2.5, §4.9).';
  return [lead + tail];
}

const box: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 6,
  padding: '8px 14px',
  margin: '8px 0',
  background: '#fafafa',
  fontSize: 13,
};

export function ProbeMixControl({
  value,
  onChange,
  disabled,
}: {
  readonly value: number;
  readonly onChange: (presentFraction: number) => void;
  readonly disabled: boolean;
}) {
  return (
    <div style={box} data-probe-mix>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>Search workload — hits vs misses</div>
      <div role="radiogroup" aria-label="share of search probes that are stored keys">
        {PROBE_MIX_CHOICES.map((f) => (
          <label key={f} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="probe-mix"
              checked={value === f}
              disabled={disabled}
              onChange={() => onChange(f)}
            />{' '}
            {choiceLabel(f)}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        Every structure is asked the <em>same</em> {PROBES_PER_POINT} questions at each size; this sets how many
        are for keys it holds. It applies to the next run. The mix moves each search line up or down and never
        tilts it: a scan finds a stored key about halfway through on average but has to read everything to rule a
        key out, the hash sets stay flat either way, numeric misses sit just past your largest key — the cheapest
        thing to ask a skip list — and a trie pays about the same for a hit as for a text miss, which is one of
        your keys with its last letter changed. The default 50/50 is the workload the built-in checks were tuned
        on.
      </div>
    </div>
  );
}
