import { useEffect, useState } from 'react';
import { createBenchEngine } from './bench/wasmBenchEngine';
import type { BenchEngine } from './bench/BenchEngine';
import { geometricSweep } from './bench/sweep';
import { fitComplexity } from './bench/fit';
import { SweepChart, type SeriesView, type Signal } from './ui/SweepChart';
import { Callout, ChartGuide, ComplexityLadder } from './ui/Explain';
import { VizPanel } from './viz/VizPanel';
import { generateSorted, generateUniform, marshalKeys } from './data';

/**
 * App shell (docs/PLAN.md §10): the two modes side by side — **Explore** (the
 * step-through animation, Phase 3) and **Compare** (the empirical sweep, Phase 2).
 * The headline empirical result — **array search rises (O(n)) while hash-set
 * search stays flat (O(1))** — is the proof that the whole pipeline (measurement →
 * isolation → fitting → charting) works on real wall-clock timings. The page is
 * written to *teach*: each section frames what it shows and how to read it (§2.3,
 * §7.2), with the measurement-honesty caveats kept in `ui/Explain`.
 */

const SWEEP_MAX = 100_000;
const SWEEP_MIN = 10;
// array (red, O(n) scan), linked list (orange, O(n) pointer-walk), sorted array
// (green, O(log n)), hashset (blue, flat O(1)) — the order runSweep returns them: the
// spread of search cost, two O(n) mechanisms then the "missing middle" then flat.
const COLORS = ['#d62728', '#ff7f0e', '#2ca02c', '#1f77b4'];

// The mutation sweep is bounded much lower than search: the array's ordered
// delete makes a full teardown O(n²), so even a few thousand keys is plenty to
// read the slope (docs/PLAN.md §6.3). Light options keep the page snappy.
const MUT_MAX = 4_000;
const MUT_MIN = 250;
// baseBatch: 1 — the build/teardown FD runners do a *full* O(n²) build+teardown per
// run(1), so the default baseBatch of 1024 would fire ~1024 of them just to clear the
// clamp on the first probe. Start at 1 and let auto-grow climb only where a single op is
// sub-clamp (the cheap churn runners); accuracy is unchanged, wall time drops sharply.
const MUT_OPTS = { minBatchMillis: 1, warmupReps: 0, reps: 3, baseBatch: 1 };
// Mutation-chart colors (tab10): array red, hashset blue, sorted green (unused in
// the churn chart), and the two balanced trees — bst purple, avl brown — now that
// their measured churn is charted (it was previously published to `window` only).
const STRUCTURE_COLOR: Record<string, string> = {
  array: '#d62728',
  hashset: '#1f77b4',
  sarr: '#2ca02c',
  bst: '#9467bd',
  avl: '#8c564b',
};

/** Shape mirrored onto `window` for the headless runtime check (scripts/verify-browser.mjs). */
export interface SweepProof {
  structure: string;
  best: string;
  slope: number;
  r2: number;
  firstNanos: number;
  lastNanos: number;
}

/** Per-(structure, op) mutation result mirrored onto `window` for the runtime check. */
export interface MutationProof extends SweepProof {
  op: string;
}

export function App() {
  const [status, setStatus] = useState('initializing…');
  const [version, setVersion] = useState('');
  const [views, setViews] = useState<SeriesView[]>([]);
  const [mutViews, setMutViews] = useState<SeriesView[]>([]);
  // BST + AVL churn series — measured all along (published to `window` for the gate)
  // but now also charted, so the mutation comparison shows the O(log n) trees beside
  // the array's O(n) and the hash set's O(1).
  const [treeChurnViews, setTreeChurnViews] = useState<SeriesView[]>([]);
  const [signal, setSignal] = useState<Signal>('nanos');

  useEffect(() => {
    let engine: BenchEngine | undefined;
    (async () => {
      try {
        engine = createBenchEngine();
        await engine.ready();
        setVersion(await engine.version());

        setStatus('running search sweep…');
        const dataset = generateSorted(SWEEP_MAX);
        const marshalled = marshalKeys(dataset);
        if (marshalled.keyType !== 'number') throw new Error('expected numeric keys');
        const sizes = geometricSweep(SWEEP_MIN, SWEEP_MAX);

        // runSweep transfers (consumes) the key buffer — fine, we use it once.
        const series = await engine.runSweep(marshalled.values, sizes);

        const built: SeriesView[] = series.map((s, i) => ({
          series: s,
          fit: fitComplexity(
            s.points.map((p) => p.n),
            s.points.map((p) => p.nanosPerOp),
          ),
          color: COLORS[i % COLORS.length],
        }));
        setViews(built);

        const proof: SweepProof[] = built.map((v) => ({
          structure: v.series.structure,
          best: v.fit.best,
          slope: v.fit.logLogSlope,
          r2: v.fit.r2,
          firstNanos: v.series.points[0].nanosPerOp,
          lastNanos: v.series.points[v.series.points.length - 1].nanosPerOp,
        }));
        (window as unknown as { __sweepProof?: SweepProof[] }).__sweepProof = proof;

        // Mutation sweep (docs/PLAN.md §6.3): churn (combined) + finite-difference
        // insert/delete, on a separate (smaller) dataset since runMutationSweep
        // also transfers its key buffer.
        setStatus('running mutation sweep…');
        const mutDataset = generateSorted(MUT_MAX);
        const mutMarshalled = marshalKeys(mutDataset);
        if (mutMarshalled.keyType !== 'number') throw new Error('expected numeric keys');
        const mutSizes = geometricSweep(MUT_MIN, MUT_MAX);
        const mutSeries = await engine.runMutationSweep(mutMarshalled.values, mutSizes, MUT_OPTS);

        const mutBuilt: SeriesView[] = mutSeries.map((s) => ({
          series: s,
          fit: fitComplexity(
            s.points.map((p) => p.n),
            s.points.map((p) => p.nanosPerOp),
          ),
          color: STRUCTURE_COLOR[s.structure] ?? '#888',
        }));
        setMutViews(mutBuilt);

        const mutProof: MutationProof[] = mutBuilt.map((v) => ({
          structure: v.series.structure,
          op: v.series.op,
          best: v.fit.best,
          slope: v.fit.logLogSlope,
          r2: v.fit.r2,
          firstNanos: v.series.points[0].nanosPerOp,
          lastNanos: v.series.points[v.series.points.length - 1].nanosPerOp,
        }));
        (window as unknown as { __mutationProof?: MutationProof[] }).__mutationProof = mutProof;

        // BST mutation sweep (docs/PLAN.md §6.3, §8 trees): the first *tree* bench
        // twin through the same churn + finite-difference machinery, on a **balanced
        // (uniform)** dataset — sorted input would degenerate to an O(n) chain with an
        // O(n²) build (the headline demo, but not what we time here). On the real clock
        // this confirms the worker→WASM BST path resolves and that balanced-tree
        // mutation is sub-linear (O(log n)) — the contrast to array O(n) / hashset O(1).
        // The precise finding this slice owns — that `insert_fd + delete_fd` *overshoots*
        // churn for a tree (it holds tight only for the chain) — is proven clock-free in
        // Rust (`structures::methodology`), the home for a numeric op-count claim.
        setStatus('running BST mutation sweep…');
        const bstDataset = generateUniform(MUT_MAX, 0, MUT_MAX, false, 7);
        const bstMarshalled = marshalKeys(bstDataset);
        if (bstMarshalled.keyType !== 'number') throw new Error('expected numeric keys');
        const bstSizes = geometricSweep(MUT_MIN, MUT_MAX);
        const bstSeries = await engine.runBstMutationSweep(bstMarshalled.values, bstSizes, MUT_OPTS);

        const bstProof: MutationProof[] = bstSeries.map((s) => {
          const fit = fitComplexity(
            s.points.map((p) => p.n),
            s.points.map((p) => p.nanosPerOp),
          );
          return {
            structure: s.structure,
            op: s.op,
            best: fit.best,
            slope: fit.logLogSlope,
            r2: fit.r2,
            firstNanos: s.points[0].nanosPerOp,
            lastNanos: s.points[s.points.length - 1].nanosPerOp,
          };
        });
        (window as unknown as { __bstMutationProof?: MutationProof[] }).__bstMutationProof =
          bstProof;

        // AVL mutation sweep (docs/PLAN.md §6.3, §8 trees): the *balanced* tree bench twin
        // through the same churn + finite-difference machinery. Fed the **same shuffled
        // (uniform)** dataset as the BST — apples-to-apples — because for the churn sweep
        // sorted vs shuffled is identical (the AVL balances at build time either way), so
        // sorted buys nothing the sweep measures. On the real clock this confirms the
        // worker→WASM AVL path resolves and that balanced-tree mutation is sub-linear
        // (O(log n)). The deterministic contrast that motivates the AVL — it stays O(log n)
        // on the exact sorted input that degenerates the BST to an O(n) chain — is a numeric
        // op-count claim, proven clock-free in Rust (`structures::methodology`).
        setStatus('running AVL mutation sweep…');
        const avlDataset = generateUniform(MUT_MAX, 0, MUT_MAX, false, 11);
        const avlMarshalled = marshalKeys(avlDataset);
        if (avlMarshalled.keyType !== 'number') throw new Error('expected numeric keys');
        const avlSizes = geometricSweep(MUT_MIN, MUT_MAX);
        const avlSeries = await engine.runAvlMutationSweep(avlMarshalled.values, avlSizes, MUT_OPTS);

        const avlProof: MutationProof[] = avlSeries.map((s) => {
          const fit = fitComplexity(
            s.points.map((p) => p.n),
            s.points.map((p) => p.nanosPerOp),
          );
          return {
            structure: s.structure,
            op: s.op,
            best: fit.best,
            slope: fit.logLogSlope,
            r2: fit.r2,
            firstNanos: s.points[0].nanosPerOp,
            lastNanos: s.points[s.points.length - 1].nanosPerOp,
          };
        });
        (window as unknown as { __avlMutationProof?: MutationProof[] }).__avlMutationProof =
          avlProof;

        // Surface the (already-measured) balanced-tree churn on the mutation chart: bst
        // (purple) + avl (brown) churn beside the array's O(n) and the hash set's O(1).
        // Read for shape, not cross-structure ns — the trees ran on a shuffled dataset,
        // the array/hash set on a sorted one (§2.3).
        setTreeChurnViews(
          [...bstSeries, ...avlSeries]
            .filter((s) => s.op === 'churn')
            .map((s) => ({
              series: s,
              fit: fitComplexity(
                s.points.map((p) => p.n),
                s.points.map((p) => p.nanosPerOp),
              ),
              color: STRUCTURE_COLOR[s.structure] ?? '#888',
            })),
        );

        // Sorted array — search only here (its O(log n) "missing middle" is in __sweepProof
        // above). Its *mutation* twin is the Rust `#[wasm_bindgen]` timed surface on
        // `SortedArrayF64` (front-churn, build/teardown), proven by the deterministic
        // `structures::methodology` self-test: front churn overshoots the finite-difference sum
        // (both O(n)), and the same structure is O(log n) to search but O(n) to mutate. Like the
        // string structures, the TS sweep + chart wiring is deferred to Phase 5 — and a browser
        // mutation curve would be slow (build *and* teardown are O(n²)) and overhead-dominated at
        // the small n that stays affordable, so the rigorous home for that numeric claim is Rust.

        setStatus('ready');
      } catch (err) {
        setStatus('error: ' + (err as Error).message);
      }
    })();
    return () => engine?.dispose();
  }, []);

  const searchReady = views.length > 0;
  const churnChartViews = [...mutViews.filter((v) => v.series.op === 'churn'), ...treeChurnViews];
  const mutationReady = churnChartViews.length > 0;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.6, maxWidth: 880 }}>
      <h1 style={{ marginBottom: 4 }}>Mr Data Structure</h1>
      <p style={{ color: '#444', marginTop: 0, fontSize: 15 }}>
        An interactive way to <strong>see</strong> data structures work and{' '}
        <strong>measure</strong> how their cost grows — on the same algorithms, side by side.
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
          growth off the chart.
        </li>
      </ol>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        Each structure has two implementations kept in lock-step: a TypeScript{' '}
        <em>teaching twin</em> drives the animation, and a Rust→WASM <em>bench twin</em> drives
        the measurements (docs/PLAN.md §2.1).
      </p>

      <ul style={{ fontSize: 13, color: '#666' }}>
        <li>
          status: <strong>{status}</strong>
        </li>
        <li>
          engine: <code>{version || '—'}</code>
        </li>
      </ul>

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

      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 20, marginBottom: 4, borderBottom: '2px solid #eee', paddingBottom: 4 }}>
          2 · Compare — measured cost curves
        </h2>
        <p style={{ color: '#555', marginTop: 8 }}>
          The same <code>search</code> and <code>insert</code>/<code>delete</code> operations, now
          run across a geometric sweep of input sizes (≈10 up to ≈100,000 keys) on a generated
          dataset, with each structure’s <em>per-operation</em> cost plotted against the size n.
          This is where the different growth rates separate: an O(n) scan visibly pulls away from
          an O(1) lookup as n grows.
        </p>

        <ChartGuide />
        <p style={{ color: '#555', marginBottom: 0 }}>
          Quick reference for the shapes you’ll read off the charts:
        </p>
        <ComplexityLadder />

        {searchReady ? (
          <p style={{ fontSize: 14, color: '#444', margin: '16px 0 0' }}>
            <label>
              <strong>Signal</strong> (applies to both charts):{' '}
              <select
                value={signal}
                onChange={(e) => setSignal(e.target.value as Signal)}
                style={{ fontSize: 14 }}
              >
                <option value="nanos">wall-clock (ns/op) — the real time on this machine</option>
                <option value="opcount">op-count (shape) — the clean, hardware-free curve</option>
              </select>
            </label>
          </p>
        ) : (
          <Callout title="Measuring…" tone="info">
            The sweeps run real timed work in a background worker, so this takes a few seconds.
            Current step: <strong>{status}</strong>. The charts will appear below as each sweep
            finishes.
          </Callout>
        )}

        <h3 style={{ fontSize: 16, marginTop: 28, marginBottom: 4 }}>
          Search — the cost of finding a key
        </h3>
        <p style={{ color: '#555', marginTop: 0 }}>
          Four structures look up a key four different ways: the unsorted array scans from the
          front, the linked list walks node by node, the sorted array binary-searches, and the
          hash set jumps straight to a bucket.
        </p>
        {searchReady && (
          <>
            <ul style={{ marginTop: 8 }}>
              {views.map((v) => {
                // Re-fit the *selected* signal for display (§2.2) — op-count is the clean
                // curve, wall-clock the real one. (The `__sweepProof` mirror above stays on
                // the wall-clock fit, which the browser gate asserts.)
                const fit = fitComplexity(
                  v.series.points.map((p) => p.n),
                  v.series.points.map((p) => (signal === 'nanos' ? p.nanosPerOp : p.opCount)),
                );
                return (
                  <li key={v.series.structure}>
                    <strong style={{ color: v.color }}>{v.series.structure}</strong> search:{' '}
                    <strong>{fit.best}</strong> (slope {fit.logLogSlope.toFixed(2)}, R²{' '}
                    {fit.r2.toFixed(3)}) — <span style={{ color: '#666' }}>{fit.note}</span>
                  </li>
                );
              })}
            </ul>
            <SweepChart views={views} signal={signal} />
            <Callout title="What to notice" tone="tip">
              The array (red) and the linked list (orange) both touch every element, so their
              cost rises ~linearly (<strong>O(n)</strong>, slope ≈ 1) — the <em>same shape by a
              different mechanism</em> (a contiguous scan vs following pointers), which shows up as
              different absolute speed. The sorted array (green) halves the search space each step,
              so it barely rises (sub-linear, <strong>O(log n)</strong> — the fitter may even call
              it O(1), since a shallow rise is hard to distinguish from flat). The hash set (blue)
              goes straight to the right bucket and stays flat (<strong>O(1)</strong>).
            </Callout>
          </>
        )}

        <h3 style={{ fontSize: 16, marginTop: 28, marginBottom: 4 }}>
          Mutation — the cost of changing the structure (churn)
        </h3>
        <p style={{ color: '#555', marginTop: 0 }}>
          You can’t cleanly time “inserts at size n” — each insert changes n. So we <em>churn</em>:
          at a fixed size n, repeatedly insert one key and delete one, so the size stays put and the
          per-operation cost is isolated (docs/PLAN.md §6.3).
        </p>
        {mutationReady && (
          <>
            <ul style={{ marginTop: 8 }}>
              {churnChartViews.map((v) => {
                const fit = fitComplexity(
                  v.series.points.map((p) => p.n),
                  v.series.points.map((p) => (signal === 'nanos' ? p.nanosPerOp : p.opCount)),
                );
                return (
                  <li key={`${v.series.structure}-${v.series.op}`}>
                    <strong style={{ color: v.color }}>{v.series.structure}</strong> churn:{' '}
                    <strong>{fit.best}</strong> (slope {fit.logLogSlope.toFixed(2)}, R²{' '}
                    {fit.r2.toFixed(3)})
                  </li>
                );
              })}
            </ul>
            <SweepChart views={churnChartViews} signal={signal} />
            <Callout title="What to notice" tone="tip">
              The unsorted array (red) shifts elements to keep its order, so its churn rises{' '}
              <strong>O(n)</strong>. The hash set (blue) stays <strong>O(1)</strong>. The balanced
              trees — BST (purple) and AVL (brown) — stay sub-linear (<strong>O(log n)</strong>),
              nearly flat. The trees are measured on a <em>shuffled</em> dataset (so the BST stays
              balanced) and the array / hash set on a sorted one — that’s fine, because each curve
              is read for its <strong>shape</strong>, not for cross-structure absolute ns (§2.3).
            </Callout>

            {mutViews.some((v) => v.series.op !== 'churn' && v.series.structure === 'array') && (
              <>
                <p style={{ color: '#555', marginBottom: 4 }}>
                  <strong>Cross-check — the per-operation split.</strong> Churn measures the{' '}
                  <em>combined</em> insert+delete cost. A second method differences the cumulative
                  build and teardown times to recover each operation separately (§6.3) — for the
                  array it exposes the asymmetry churn hides: delete is O(n) (shift to close the
                  gap), while insert is an O(1) append. That O(1) is clean on the{' '}
                  <em>op-count</em> signal; on <em>wall-clock</em> a single append is so cheap the
                  timing is mostly noise (watch the low R²) — a live reminder of <em>why</em> there
                  are two signals.
                </p>
                <ul style={{ marginTop: 4 }}>
                  {mutViews
                    .filter((v) => v.series.op !== 'churn' && v.series.structure === 'array')
                    .map((v) => {
                      const fit = fitComplexity(
                        v.series.points.map((p) => p.n),
                        v.series.points.map((p) => (signal === 'nanos' ? p.nanosPerOp : p.opCount)),
                      );
                      return (
                        <li key={`${v.series.structure}-${v.series.op}`}>
                          <strong style={{ color: v.color }}>{v.series.structure}</strong>{' '}
                          {v.series.op}: <strong>{fit.best}</strong> (slope{' '}
                          {fit.logLogSlope.toFixed(2)}, R² {fit.r2.toFixed(3)})
                        </li>
                      );
                    })}
                </ul>
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}
