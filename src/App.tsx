import { Callout } from './ui/Explain';
import { CompareSection } from './ui/CompareSection';
import { VizPanel } from './viz/VizPanel';

/**
 * App shell (docs/PLAN.md §10): the two modes side by side — **Explore** (the
 * step-through animation, Phase 3) and **Compare** (the empirical sweep on a
 * user-chosen dataset, Phases 2/4/5). The page is written to *teach*: each
 * section frames what it shows and how to read it (§2.3, §7.2), with the
 * measurement-honesty caveats kept in `ui/Explain`. The sweep orchestration
 * lives in `compare/runSweeps.ts`; this file is layout only.
 */
export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.6, maxWidth: 880 }}>
      <h1 style={{ marginBottom: 4 }}>Mr Data Structure</h1>
      <p style={{ color: '#444', marginTop: 0, fontSize: 15 }}>
        An interactive way to <strong>see</strong> data structures work and{' '}
        <strong>measure</strong> how their cost grows — on the same algorithms, side by side, on your data.
      </p>
      <ol style={{ color: '#444', fontSize: 14, marginTop: 0 }}>
        <li>
          <strong>Explore</strong> — run one <code>insert</code> / <code>search</code> /{' '}
          <code>delete</code> on a small structure and step through it, watching every
          comparison, shift, pointer-hop, rehash, and rotation the algorithm performs.
        </li>
        <li>
          <strong>Compare</strong> — run those same operations across a sweep of input sizes on
          several structures at once and read their <em>measured</em> cost curves against each
          other. Nothing here is asserted from a textbook — the cost is measured and you read the
          growth off the chart, with the textbook class overlaid only as a dashed reference.
        </li>
      </ol>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        Each structure has two implementations kept in lock-step: a TypeScript{' '}
        <em>teaching twin</em> drives the animation, and a Rust→WASM <em>bench twin</em> drives
        the measurements (docs/PLAN.md §2.1). The measurement science — and its limits — is in
        docs/METHODOLOGY.md.
      </p>

      <section style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 20, marginBottom: 4, borderBottom: '2px solid #eee', paddingBottom: 4 }}>
          1 · Explore — watch one operation, step by step
        </h2>
        <p style={{ color: '#555', marginTop: 8 }}>
          Pick a structure, type a key, and run <code>insert</code> / <code>search</code> /{' '}
          <code>delete</code>. Then step through the comparisons, probes, shifts, rehashes, and
          rotations — the <em>same</em> work the benchmark counts below (docs/PLAN.md §2.1, §5).
        </p>
        <Callout title="What to watch while you step" tone="tip">
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              The <strong>highlighted</strong> cell or node is the element the algorithm is
              touching <em>right now</em> — comparing, moving, or probing it.
            </li>
            <li>
              The caption under the controls narrates each step in plain English; the line above
              the picture summarizes the whole operation and its cost.
            </li>
            <li>
              Use <code>▶</code>/<code>⏸</code>, <code>step&nbsp;▶</code> / <code>◀&nbsp;step</code>,
              and the speed slider to go at your own pace; <code>⏮</code>/<code>⏭</code> jump to the
              start / end.
            </li>
            <li>
              Each structure counts its own unit of work — its <em>cost metric</em>: comparisons
              (arrays, trees), probes (hash set), node-visits (lists), swaps (heap), rotations
              (AVL). These measure <strong>shape</strong>, so don’t compare their raw counts across
              structures (§2.3).
            </li>
            <li>
              This runs on a small seeded structure so every step is visible. The <em>same</em>{' '}
              algorithm at full scale is exactly what <strong>Compare</strong> measures below.
            </li>
          </ul>
        </Callout>
        <VizPanel />
      </section>

      <CompareSection />
    </main>
  );
}
