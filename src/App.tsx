import { useEffect, useState } from 'react';
import { createBenchEngine } from './bench/wasmBenchEngine';
import type { BenchEngine } from './bench/BenchEngine';
import { geometricSweep } from './bench/sweep';
import { fitComplexity } from './bench/fit';
import { SweepChart, type SeriesView, type Signal } from './ui/SweepChart';
import { VizPanel } from './viz/VizPanel';
import { generateSorted, generateUniform, marshalKeys } from './data';

/**
 * Phase 2 thin slice (docs/PLAN.md §10): generate a dataset, run the search
 * measurement sweep on the unsorted array and the hash set through the real
 * WASM engine, and show the two cost curves side by side. The headline result —
 * **array search rises (O(n)) while hash-set search stays flat (O(1))** — is the
 * empirical proof that the whole pipeline (measurement → isolation → fitting →
 * charting) works on real wall-clock timings.
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
const MUT_OPTS = { minBatchMillis: 1, warmupReps: 0, reps: 3 };
const STRUCTURE_COLOR: Record<string, string> = {
  array: '#d62728',
  hashset: '#1f77b4',
  sarr: '#2ca02c',
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
  const [signal, setSignal] = useState<Signal>('nanos');

  useEffect(() => {
    let engine: BenchEngine | undefined;
    (async () => {
      try {
        engine = createBenchEngine();
        await engine.ready();
        setVersion(await engine.version());

        setStatus('running sweep…');
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

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, lineHeight: 1.6 }}>
      <h1>Mr Data Structure</h1>
      <p style={{ color: '#666' }}>
        Phase 3 — explore (step-through animation) · Phase 2 — empirical
        complexity (sweep below)
      </p>

      <ul>
        <li>
          status: <strong>{status}</strong>
        </li>
        <li>
          engine: <code>{version || '—'}</code>
        </li>
      </ul>

      <section style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: 18, marginBottom: 4 }}>Explore</h2>
        <p style={{ color: '#666', marginTop: 0 }}>
          Run <code>insert</code> / <code>search</code> / <code>delete</code> and
          step through the comparisons, probes, shifts, and rehashes — the same
          algorithm the benchmark measures (docs/PLAN.md §2.1, §5).
        </p>
        <VizPanel />
      </section>

      {views.length > 0 && (
        <section style={{ marginTop: 16 }}>
          <label style={{ color: '#666', fontSize: 14 }}>
            signal:{' '}
            <select value={signal} onChange={(e) => setSignal(e.target.value as Signal)}>
              <option value="nanos">wall-clock (ns/op)</option>
              <option value="opcount">op-count (shape)</option>
            </select>
          </label>

          <ul style={{ marginTop: 8 }}>
            {views.map((v) => (
              <li key={v.series.structure}>
                <strong style={{ color: v.color }}>{v.series.structure}</strong> search:{' '}
                <strong>{v.fit.best}</strong> (slope {v.fit.logLogSlope.toFixed(2)}, R²{' '}
                {v.fit.r2.toFixed(3)}) — <span style={{ color: '#666' }}>{v.fit.note}</span>
              </li>
            ))}
          </ul>

          <SweepChart views={views} signal={signal} />
        </section>
      )}

      {mutViews.length > 0 && (
        <section style={{ marginTop: 32 }}>
          <p style={{ color: '#666' }}>
            Phase 2 — size-mutating ops (§6.3): <code>churn</code> (combined
            insert+delete) plus the finite-difference <code>insert</code> /{' '}
            <code>delete</code> split. Fits follow the <strong>signal</strong>{' '}
            selector above — the deterministic <em>op-count</em> resolves what the
            wall-clock leaves ambiguous (e.g. insert is a clean O(1) by op-count).
          </p>
          <ul>
            {mutViews.map((v) => {
              // Fit the *selected* signal (§2.2): op-count is the clean curve,
              // wall-clock the real one — toggling shows where they disagree.
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

          <SweepChart
            views={mutViews.filter((v) => v.series.op === 'churn')}
            signal={signal}
          />
        </section>
      )}
    </main>
  );
}
