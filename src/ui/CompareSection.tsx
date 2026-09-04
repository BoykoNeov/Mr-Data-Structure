import { useEffect, useMemo, useRef, useState } from 'react';
import { createBenchEngine } from '../bench/wasmBenchEngine';
import type { BenchEngine } from '../bench/BenchEngine';
import { runAllSweeps, toView, type CompareResult } from '../compare/runSweeps';
import type { Dataset } from '../data';
import { REGISTRY } from '../registry';
import { Callout, ChartGuide, ComplexityLadder } from './Explain';
import { DatasetPicker, DEFAULT_PICKER, buildDataset, describeDataset } from './DatasetPicker';
import { SweepChart, type SeriesView, type Signal } from './SweepChart';
import { SlopeChart } from './SlopeChart';
import { download, toCsv, toJson } from './export';

/**
 * The Compare mode (docs/PLAN.md §7, §10 Phase 5): a dataset panel, the sweeps
 * run on *that* dataset in the WASM worker, and the results read three ways —
 * the log-log cost chart with its rep spread and dashed theoretical twin, the
 * fit table (class, slope ± stderr, R², trend), and the local-slope panel that
 * shows where a curve changes regime. Runs once on mount with the default
 * dataset (the headless runtime gate reads that run's `window.__*Proof`
 * mirrors), and again whenever the user picks a new dataset.
 */

const h3: React.CSSProperties = { fontSize: 16, marginTop: 28, marginBottom: 4 };
const small: React.CSSProperties = { fontSize: 13, color: '#666' };

function FitRow({ v, what }: { readonly v: SeriesView; readonly what?: string }) {
  const name = REGISTRY[v.series.structure]?.label ?? v.series.structure;
  const se = v.fit.slopeStderr > 0 ? ` ± ${v.fit.slopeStderr.toFixed(2)}` : '';
  return (
    <li>
      <strong style={{ color: v.color }}>{name}</strong> {what ?? v.series.op}:{' '}
      <strong>{v.fit.best}</strong> (slope {v.fit.logLogSlope.toFixed(2)}{se}, tail{' '}
      {v.fit.tailSlope.toFixed(2)}, R² {v.fit.r2.toFixed(3)}, {v.fit.trend}) —{' '}
      <span style={{ color: '#666' }}>{v.fit.note}</span>
    </li>
  );
}

export function CompareSection() {
  const engineRef = useRef<BenchEngine | null>(null);
  const [status, setStatus] = useState('initializing…');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(true);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [signal, setSignal] = useState<Signal>('nanos');
  const [showTheory, setShowTheory] = useState(true);
  const [showSpread, setShowSpread] = useState(true);

  const run = async (d: Dataset) => {
    const engine = engineRef.current;
    if (!engine) return;
    setBusy(true);
    setDataset(d);
    try {
      await engine.ready();
      const r = await runAllSweeps(engine, d, setStatus);
      setResult(r);
      setStatus('ready');
    } catch (err) {
      setStatus('error: ' + (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const engine = createBenchEngine();
    engineRef.current = engine;
    (async () => {
      try {
        await engine.ready();
        setVersion(await engine.version());
        await run(buildDataset(DEFAULT_PICKER));
      } catch (err) {
        setStatus('error: ' + (err as Error).message);
        setBusy(false);
      }
    })();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fit on the selected signal (§2.2): op-count is the clean curve, wall-clock the real one.
  const search = useMemo(() => result?.search.map((v) => toView(v.series, signal)) ?? [], [result, signal]);
  const churn = useMemo(
    () =>
      [...(result?.mutation ?? []), ...(result?.trees ?? [])]
        .filter((v) => v.series.op === 'churn')
        .map((v) => toView(v.series, signal)),
    [result, signal],
  );
  const split = useMemo(
    () =>
      [...(result?.mutation ?? []), ...(result?.trees ?? [])]
        .filter((v) => v.series.op !== 'churn')
        .map((v) => toView(v.series, signal)),
    [result, signal],
  );

  const shape = result?.shape ?? 'random';
  const sortedNote = shape === 'sorted';
  const reverse = dataset?.order.kind === 'reverse-sorted';

  const exportAll = (kind: 'csv' | 'json') => {
    const views = [...search, ...churn, ...split];
    const meta = { dataset: dataset ? describeDataset(dataset) : null, order: dataset?.order, signal, engine: version };
    if (kind === 'csv') download('mr-data-structure-sweep.csv', toCsv(views), 'text/csv');
    else download('mr-data-structure-sweep.json', toJson(views, meta), 'application/json');
  };

  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: 20, marginBottom: 4, borderBottom: '2px solid #eee', paddingBottom: 4 }}>
        2 · Compare — measured cost curves on <em>your</em> data
      </h2>
      <p style={{ color: '#555', marginTop: 8 }}>
        The same <code>search</code> and <code>insert</code>/<code>delete</code> operations, run across a
        geometric sweep of input sizes on one dataset, with each structure’s <em>per-operation</em> cost
        plotted against the size n. Every sweep point is an order-preserving prefix of the dataset, so its
        real distribution and ordering reach every structure. This is where the growth rates separate — and
        where the <em>order</em> of your data can flip a structure’s class.
      </p>

      <ul style={small}>
        <li>status: <strong>{status}</strong></li>
        <li>engine: <code>{version || '—'}</code></li>
        {dataset && <li>dataset: {describeDataset(dataset)}</li>}
      </ul>

      <DatasetPicker busy={busy} onRun={(d) => void run(d)} />

      <ChartGuide />
      <p style={{ color: '#555', marginBottom: 0 }}>Quick reference for the shapes you’ll read off the charts:</p>
      <ComplexityLadder />

      {result ? (
        <p style={{ fontSize: 14, color: '#444', margin: '16px 0 0' }}>
          <label>
            <strong>Signal</strong>:{' '}
            <select value={signal} onChange={(e) => setSignal(e.target.value as Signal)} style={{ fontSize: 14 }}>
              <option value="nanos">wall-clock (ns/op) — the real time on this machine</option>
              <option value="opcount">op-count (shape) — the clean, hardware-free curve</option>
            </select>
          </label>{' '}
          <label style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={showTheory} onChange={(e) => setShowTheory(e.target.checked)} /> theoretical overlay (dashed)
          </label>{' '}
          <label style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={showSpread} onChange={(e) => setShowSpread(e.target.checked)} /> rep spread (error bars)
          </label>{' '}
          <button onClick={() => exportAll('csv')} style={{ marginLeft: 12, fontSize: 12 }}>export CSV</button>{' '}
          <button onClick={() => exportAll('json')} style={{ fontSize: 12 }}>export JSON</button>
        </p>
      ) : (
        <Callout title="Measuring…" tone="info">
          The sweeps run real timed work in a background worker, so this takes a few seconds. Current step:{' '}
          <strong>{status}</strong>. The charts appear below as each sweep finishes.
        </Callout>
      )}

      <h3 style={h3}>Search — the cost of finding a key</h3>
      <p style={{ color: '#555', marginTop: 0 }}>
        Four structures look up a key four different ways: the unsorted array scans from the front, the
        linked list walks node by node, the sorted array binary-searches, and the hash set jumps straight to
        a bucket.
      </p>
      {search.length > 0 && (
        <>
          <ul style={{ marginTop: 8 }}>{search.map((v) => <FitRow key={v.series.structure} v={v} />)}</ul>
          <SweepChart views={search} signal={signal} showTheory={showTheory} showSpread={showSpread} shape={shape} />
          <SlopeChart views={search} />
          <Callout title="What to notice" tone="tip">
            The array (red) and the linked list (orange) both touch every element, so their cost rises
            ~linearly (<strong>O(n)</strong>, slope ≈ 1) — the <em>same shape by a different mechanism</em>{' '}
            (a contiguous scan vs following pointers), which shows up as different absolute speed. The
            sorted array (green) halves the search space each step, so it barely rises (<strong>O(log n)</strong>{' '}
            — watch its <em>local</em> slope fall toward 0 in the panel above: that falling trend is the
            logarithm’s signature, which the fitter now uses to tell it from flat). The hash set (blue) goes
            straight to the right bucket and stays flat (<strong>O(1)</strong>). The dashed lines are each
            structure’s textbook class scaled onto its points — where a solid line peels away from its dashed
            twin, the machine (cache, memory traffic) or the data is doing something the textbook doesn’t say.
          </Callout>
        </>
      )}

      <h3 style={h3}>Mutation — the cost of changing the structure (churn)</h3>
      <p style={{ color: '#555', marginTop: 0 }}>
        You can’t cleanly time “inserts at size n” — each insert changes n. So we <em>churn</em>: at a fixed
        size n, repeatedly insert one key and delete one, so the size stays put and the per-operation cost is
        isolated (docs/PLAN.md §6.3, docs/METHODOLOGY.md §2).
      </p>
      {churn.length > 0 && (
        <>
          <ul style={{ marginTop: 8 }}>
            {churn.map((v) => <FitRow key={`${v.series.structure}-${v.series.op}`} v={v} />)}
          </ul>
          <SweepChart views={churn} signal={signal} showTheory={showTheory} showSpread={showSpread} shape={shape} />
          <SlopeChart views={churn} />
          <Callout title="What to notice" tone="tip">
            The unsorted array (red) shifts elements to keep its order, so its churn rises <strong>O(n)</strong>.
            The hash set (blue) stays <strong>O(1)</strong>. On shuffled data both trees — BST (purple) and AVL
            (brown) — stay sub-linear (<strong>O(log n)</strong>), nearly flat.{' '}
            {sortedNote ? (
              <>
                <strong>This dataset is sorted</strong>, so the naive BST built into a chain and its dashed
                twin is now the worst case, O(n): watch the purple line leave the brown AVL, which rotates to
                stay O(log n) on the same input — the headline demo.
                {reverse && (
                  <>
                    {' '}
                    (Reverse-sorted builds a <em>left</em> chain, so the tree leans the other way. The
                    add/remove probe alternates <em>both</em> ends of the key range — one below the smallest
                    key, one above the largest — so whichever way the chain leans, one of the two walks it:
                    the BST’s mutation still reads O(n) here, matching its search. Probing only the top end,
                    as this tool used to, would have reported a misleading flat O(1) line — docs/METHODOLOGY.md
                    §4.1.)
                  </>
                )}
              </>
            ) : (
              <>
                Pick the <em>sorted</em> generator above to watch the BST degenerate to O(n) while the AVL
                holds — the built-in demo of why order matters.
              </>
            )}
          </Callout>

          {split.length > 0 && (
            <>
              <p style={{ color: '#555', marginBottom: 4 }}>
                <strong>Cross-check — the per-operation split.</strong> Churn measures the <em>combined</em>{' '}
                insert+delete cost. A second method differences the cumulative build and teardown times to
                recover each operation separately (§6.3) — for the array it exposes the asymmetry churn hides:
                delete is O(n) (shift to close the gap), while insert is an O(1) append. That O(1) is clean on
                the <em>op-count</em> signal; on <em>wall-clock</em> a single append is so cheap the timing is
                mostly noise (watch the low R² and the wide error bars) — a live reminder of <em>why</em> there
                are two signals. The two methods agree only in complexity class, and not always even then —
                the five regimes are tabulated in docs/METHODOLOGY.md §2.
              </p>
              <ul style={{ marginTop: 4 }}>
                {split.map((v) => <FitRow key={`${v.series.structure}-${v.series.op}`} v={v} />)}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
