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

/** Shape mirrored onto `window` for the headless runtime check (scripts/verify-browser.mjs). */
export interface SweepProof {
  structure: string;
  best: string;
  slope: number;
  r2: number;
  firstNanos: number;
  lastNanos: number;
}

export function App() {
  const [status, setStatus] = useState('initializing…');
  const [version, setVersion] = useState('');
  const [views, setViews] = useState<SeriesView[]>([]);
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
    </main>
  );
}
