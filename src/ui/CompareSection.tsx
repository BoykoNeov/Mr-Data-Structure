import { useEffect, useMemo, useRef, useState } from 'react';
import { createBenchEngine } from '../bench/wasmBenchEngine';
import type { BenchEngine } from '../bench/BenchEngine';
import {
  runAllSweeps,
  toView,
  canonicalSearch,
  heapSearch,
  type CompareResult,
} from '../compare/runSweeps';
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
  // Risk R6: the shared charts show only the canonical insert/search/delete structures.
  // The min-heap's op set is different, so its series are split out into their own section
  // below rather than being lined up against structures it cannot fairly be compared to.
  const search = useMemo(
    () => canonicalSearch(result).map((v) => toView(v.series, signal)),
    [result, signal],
  );
  const heapScan = useMemo(
    () => heapSearch(result).map((v) => toView(v.series, signal)),
    [result, signal],
  );
  const heapChurn = useMemo(
    () => (result?.heap ?? []).filter((v) => v.series.op === 'churn').map((v) => toView(v.series, signal)),
    [result, signal],
  );
  const heapSplit = useMemo(
    () => (result?.heap ?? []).filter((v) => v.series.op !== 'churn').map((v) => toView(v.series, signal)),
    [result, signal],
  );
  /** The array's scan, reused (not re-measured) as the reference line for the heap's. */
  const arrayScan = useMemo(() => search.filter((v) => v.series.structure === 'array'), [search]);
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
    const views = [...search, ...churn, ...split, ...heapScan, ...heapChurn, ...heapSplit];
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
        a bucket. (The min-heap is measured too, but it answers a different question and gets its own
        section below.)
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
            The sorted array (green) rises the same way for a different reason — it shifts to keep the order it
            binary-searches on, so it pays <strong>O(n)</strong> on every change to buy the sub-linear search you
            saw above: <em>the same structure, cheap to read and expensive to write</em>. The hash set (blue)
            stays <strong>O(1)</strong>. The linked list (orange) is flat too, but not for the hash set's reason —
            see the note below the chart before you read anything into it. On shuffled data both trees — BST
            (purple) and AVL (brown) — stay sub-linear (<strong>O(log n)</strong>), nearly flat.{' '}
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

          <Callout title="The flat orange line is a trap — read it with the split below" tone="caveat">
            The linked list’s add/remove line sits flat at <strong>O(1)</strong>, right down with the hash set.
            That number is <em>true</em>, and it is <em>not</em> what it looks like. Every measurement here
            adds one key and removes the same key, and a list adds at the front — so the key we then remove is
            the very first one it looks at. We are timing the one position on a list where removal is free.
            There is no way to fix this by choosing a different key: on a list that adds at the front, a
            same-key add-and-remove pair is <em>always</em> cheap, which is why this structure is the one place
            the two measurement methods land in <strong>different complexity classes</strong> rather than
            merely different constants.
            <br />
            The cost you actually care about is removing a key that is already <em>in</em> the list, and that
            is what the orange <em>delete</em> row in the split below reports: <strong>O(n)</strong>, because
            the list has to walk to it. Same structure, same run, both numbers honest — flat and linear at
            once. The hash set’s flat line, by contrast, holds for <em>any</em> key. That is the difference
            the chart alone cannot show you (docs/METHODOLOGY.md §2.3, regime 7).
            <br />
            One caveat on the wall-clock version of that flat line, in the spirit of the rest of this page:
            at roughly nine nanoseconds an operation it is sitting on the <em>timer’s</em> resolution, not
            the list’s. Runs have come back with the first and last points identical to sixteen digits — the
            clock, not the structure, choosing the number. Read it as “too cheap to grow”, which is the
            honest reading, rather than as a precise measurement; the O(1) class itself is carried by the
            exact operation counts, where a churn pair is literally one node visit at every size. Switch the
            <strong>Signal</strong> selector above to op-count to see that curve without the clock in it.
          </Callout>

          {split.length > 0 && (
            <>
              <p style={{ color: '#555', marginBottom: 4 }}>
                <strong>Cross-check — the per-operation split.</strong> Churn measures the <em>combined</em>{' '}
                insert+delete cost. A second method differences the cumulative build and teardown times to
                recover each operation separately (§6.3) — for the array it exposes the asymmetry churn hides:
                delete is O(n) (shift to close the gap), while insert is an O(1) append. For the{' '}
                <strong>linked list</strong> it is the only place the real cost of removing a stored key shows
                up at all, for the reason in the box above. That O(1) is clean on
                the <em>op-count</em> signal; on <em>wall-clock</em> a single append is so cheap the timing is
                mostly noise (watch the low R² and the wide error bars) — a live reminder of <em>why</em> there
                are two signals. The two methods agree only in complexity class, and not always even then —
                the eight regimes are tabulated in docs/METHODOLOGY.md §2.
              </p>
              <ul style={{ marginTop: 4 }}>
                {split.map((v) => <FitRow key={`${v.series.structure}-${v.series.op}`} v={v} />)}
              </ul>
            </>
          )}
        </>
      )}

      <h3 style={h3}>The min-heap — a different job, so a different scoreboard</h3>
      <p style={{ color: '#555', marginTop: 0 }}>
        Every structure above answers the same three questions: add a key, find a key, remove a key. A heap
        answers a different one — <em>what is the smallest key right now?</em> — so it is measured on its own
        operations (insert, peek, extract-min) and shown here rather than on the charts above. Comparing its
        “delete” to an array’s would be comparing two different things.
      </p>
      {heapChurn.length > 0 && (
        <>
          <ul style={{ marginTop: 8 }}>
            {heapChurn.map((v) => (
              <FitRow key={`${v.series.structure}-${v.series.op}`} v={v} what="insert + extract-min" />
            ))}
            {heapSplit.map((v) => (
              <FitRow
                key={`${v.series.structure}-${v.series.op}`}
                v={v}
                what={v.series.op === 'delete' ? 'extract-min' : 'insert'}
              />
            ))}
          </ul>
          <SweepChart views={heapChurn} signal={signal} showTheory={showTheory} showSpread={showSpread} shape={shape} />
          <SlopeChart views={heapChurn} />
          <Callout title="What to notice" tone="tip">
            One add-and-remove pair costs <strong>O(log n)</strong> — the pink line stays nearly flat,
            because each operation walks a single root-to-leaf path of a tree that doubles in width every
            level. Read this curve for its <em>shape</em>, not its height. The key we add is deliberately
            smaller than everything already stored, and that is the most expensive key a heap can take, so
            the line sits above what an average workload would pay. It has to be that key: a heap can only
            remove its <em>smallest</em> item, so anything larger would take a real key out and slowly empty
            the structure. That bias runs the opposite way to the two trees above, whose add/remove probe is
            <em>cheaper</em> than average (docs/METHODOLOGY.md §4.1, §4.2). The two half-operations listed
            above the chart show where the cost actually sits: an ordinary insert usually stops after a step
            or two, since most of a heap is leaves, while every extract-min must sift the refill all the way
            back down. Compare those two on their <em>per-operation cost</em>, not on their fitted labels:
            each is reconstructed by subtracting one timing from another, which for operations this cheap
            leaves mostly noise — wide enough here that the label on either half can come out wrong from one
            run to the next. The pair cost above, which is timed directly, is the reliable curve.
          </Callout>
        </>
      )}

      {heapScan.length > 0 && (
        <>
          <p style={{ color: '#555', marginBottom: 4 }}>
            <strong>And the contrast that makes the point.</strong> A heap keeps only its <em>minimum</em>{' '}
            findable. Ask it for any other key and it has no shortcut at all — it checks every slot, exactly
            like the unsorted array. Both lines below are <strong>O(n)</strong>, which is the honest answer to
            “can I just use a heap for everything?”: not if you need lookups.
          </p>
          <ul style={{ marginTop: 4 }}>
            {[...heapScan, ...arrayScan].map((v) => (
              <FitRow key={`scan-${v.series.structure}`} v={v} what="search (linear scan)" />
            ))}
          </ul>
          <SweepChart
            views={[...heapScan, ...arrayScan]}
            signal={signal}
            showTheory={showTheory}
            showSpread={showSpread}
            shape={shape}
          />
        </>
      )}

    </section>
  );
}
