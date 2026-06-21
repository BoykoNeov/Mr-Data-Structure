import type { ReactNode } from 'react';

/**
 * Reusable pedagogical UI (docs/PLAN.md §2.3, §7.2): the prose blocks that teach
 * the user how to *read* the tool — how a log-log slope encodes complexity, what
 * the two signals mean, which complexity classes look like what, and the honesty
 * caveats that keep the tool trustworthy (wall-clock is machine-specific; the
 * fitter only separates gross classes; op-counts compare shape, not magnitude).
 *
 * These are static, presentational, and dependency-free on purpose — App.tsx
 * composes them around the live charts. They carry the project's
 * non-negotiable measurement honesty (§2.3) in one place so it can't drift.
 */

type Tone = 'info' | 'tip' | 'caveat';

const TONE: Record<Tone, { border: string; bg: string; mark: string }> = {
  info: { border: '#4a90d9', bg: '#f0f6ff', mark: '💡' },
  tip: { border: '#2ca02c', bg: '#f1f9f1', mark: '👀' },
  caveat: { border: '#d9822b', bg: '#fff7ec', mark: '⚠️' },
};

/**
 * A titled callout box. `tone` picks the accent (info = how-it-works, tip =
 * what-to-watch, caveat = the honesty warnings) — purely visual framing so the
 * eye can tell "this is a caution" from "this is an explanation" at a glance.
 */
export function Callout({
  title,
  tone = 'info',
  children,
}: {
  readonly title: string;
  readonly tone?: Tone;
  readonly children: ReactNode;
}) {
  const t = TONE[tone];
  return (
    <div
      style={{
        borderLeft: `4px solid ${t.border}`,
        background: t.bg,
        borderRadius: 6,
        padding: '12px 16px',
        margin: '12px 0',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        <span style={{ marginRight: 6 }}>{t.mark}</span>
        {title}
      </div>
      <div style={{ fontSize: 14, color: '#333', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

/** One row of the complexity ladder: class, the log-log slope it draws as, how it
 * grows when n doubles, and an everyday feel. */
interface Rung {
  readonly cls: string;
  readonly slope: string;
  readonly grows: string;
  readonly feel: string;
}

// Ordered cheapest → steepest. The "slope" column is what the user reads off the
// log-log chart (§2.3): the headline signal. log n / n·log n are flagged as
// hard-to-separate by eye (R3, §7.2) — the ladder must not imply otherwise.
const RUNGS: readonly Rung[] = [
  { cls: 'O(1)', slope: '≈ 0 (flat)', grows: "doesn't grow at all", feel: 'hash lookup — same cost at 10 keys or 10 million' },
  { cls: 'O(log n)', slope: '≈ 0 (a gentle rise)', grows: 'adds one step each time n doubles', feel: 'binary search — a million items in ~20 compares' },
  { cls: 'O(n)', slope: '≈ 1', grows: 'doubles when n doubles', feel: 'scanning every element once' },
  { cls: 'O(n log n)', slope: '≈ 1 (slightly steeper)', grows: 'a little worse than doubling', feel: 'a good comparison sort' },
  { cls: 'O(n²)', slope: '≈ 2', grows: 'quadruples when n doubles', feel: 'comparing every pair of elements' },
];

const cell: React.CSSProperties = { padding: '5px 10px', borderBottom: '1px solid #eee', textAlign: 'left', verticalAlign: 'top' };
const head: React.CSSProperties = { ...cell, borderBottom: '2px solid #ddd', color: '#555', fontWeight: 600 };

/**
 * The complexity ladder — a plain-English reference from cheapest to steepest,
 * tying each class to the slope you read off the log-log chart and to an everyday
 * feel. It deliberately notes that O(log n) and O(n log n) are *gentle* rises that
 * look almost flat / almost linear (the §7.2 ambiguity), so the reader isn't
 * surprised when the auto-label hedges.
 */
export function ComplexityLadder() {
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 13, margin: '8px 0', width: '100%', maxWidth: 760 }}>
      <thead>
        <tr>
          <th style={head}>class</th>
          <th style={head}>slope on the chart</th>
          <th style={head}>cost when n doubles</th>
          <th style={head}>an everyday feel</th>
        </tr>
      </thead>
      <tbody>
        {RUNGS.map((r) => (
          <tr key={r.cls}>
            <td style={{ ...cell, fontFamily: 'monospace', fontWeight: 600 }}>{r.cls}</td>
            <td style={cell}>{r.slope}</td>
            <td style={cell}>{r.grows}</td>
            <td style={{ ...cell, color: '#555' }}>{r.feel}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * "How to read these charts" — the core reading instructions plus the honesty
 * caveats (docs/PLAN.md §2.3, §7.2, §6.5). This is the single most important block
 * for trust: it states that the slope is the headline and the auto-label only a
 * hint, that wall-clock is specific to *this* machine, and that op-counts compare
 * shape and not magnitude across structures.
 */
export function ChartGuide() {
  return (
    <Callout title="How to read these charts" tone="info">
      <ul style={{ margin: '0', paddingLeft: 20 }}>
        <li>
          <strong>The axes are log-log.</strong> Both n (across) and cost (up) use
          logarithmic scales. On log-log axes a cost that grows like n<sup>k</sup>{' '}
          draws as a <em>straight line whose slope is the exponent k</em> — so you
          read the complexity straight off the steepness: flat ⇒ O(1), slope ≈ 1 ⇒
          O(n), slope ≈ 2 ⇒ O(n²). A gentle sub-linear rise is O(log&nbsp;n).
        </li>
        <li>
          <strong>The slope is the headline; the label is only a hint.</strong> Each
          line is auto-labelled with a best-fit class and an R² (how cleanly it fits).
          Trust the slope you can see with your eyes. The fitter reliably separates the{' '}
          <em>gross</em> classes — constant vs linear vs quadratic — but{' '}
          <strong>O(log&nbsp;n), O(n), and O(n·log&nbsp;n) are genuinely ambiguous</strong>{' '}
          over any realistic size range (they differ by only a small factor and are
          easily swamped by noise). So a binary search may come back labelled “O(1)”
          even though it is really O(log&nbsp;n) — its rise is just too shallow to pin down.
        </li>
        <li>
          <strong>Two signals, one toggle.</strong>{' '}
          <em>Wall-clock (ns/op)</em> is the real time the operation took, measured here
          and now — it includes real costs like cache misses and memory traffic, and it
          is <strong>specific to this browser and CPU</strong>, not a universal fact about
          the algorithm. <em>Op-count (shape)</em> is the deterministic number of the
          structure’s cost-metric steps (comparisons, probes, …) — hardware-independent,
          the clean platonic curve. Flip between them to see where the messy real timing
          and the clean shape agree, and where machine constants distort the picture.
        </li>
        <li>
          <strong>Op-counts compare shape, not size.</strong> One structure’s “operation”
          (a comparison) is not the same amount of work as another’s (a hash probe, a
          pointer hop). On the op-count signal, compare the <em>slopes</em> across
          structures — never the absolute heights.
        </li>
        <li>
          <strong>The data is generated.</strong> These curves run on a synthetic dataset
          generated in-app (loading your own CSV/JSON is a later phase). The shapes are
          real measurements; the keys are not yours yet.
        </li>
      </ul>
    </Callout>
  );
}
