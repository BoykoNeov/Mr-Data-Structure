import { useEffect, useState } from 'react';
import { createBenchEngine } from './bench/wasmBenchEngine';
import type { BenchEngine } from './bench/BenchEngine';
import { geometricSweep } from './bench/sweep';
import { fitComplexity } from './bench/fit';
import { SweepChart, type SeriesView, type Signal } from './ui/SweepChart';
import { generateSorted, marshalKeys } from './data';

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
const COLORS = ['#d62728', '#1f77b4']; // array (red, rising), hashset (blue, flat)

// The mutation sweep is bounded much lower than search: the array's ordered
// delete makes a full teardown O(n²), so even a few thousand keys is plenty to
// read the slope (docs/PLAN.md §6.3). Light options keep the page snappy.
const MUT_MAX = 4_000;
const MUT_MIN = 250;
const MUT_OPTS = { minBatchMillis: 1, warmupReps: 0, reps: 3 };
const STRUCTURE_COLOR: Record<string, string> = { array: '#d62728', hashset: '#1f77b4' };

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
        Phase 2 — empirical complexity: array vs hash set, <code>search</code>
      </p>

      <ul>
        <li>
          status: <strong>{status}</strong>
        </li>
        <li>
          engine: <code>{version || '—'}</code>
        </li>
      </ul>

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
