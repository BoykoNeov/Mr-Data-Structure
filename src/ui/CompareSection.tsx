import { useEffect, useMemo, useRef, useState } from 'react';
import { createBenchEngine } from '../bench/wasmBenchEngine';
import type { BenchEngine } from '../bench/BenchEngine';
import {
  runAllSweeps,
  runStringSweeps,
  toView,
  canonicalSearch,
  heapSearch,
  type CompareResult,
  type StringCompareResult,
} from '../compare/runSweeps';
import type { Dataset } from '../data';
import { REGISTRY } from '../registry';
import { Callout, ChartGuide, ComplexityLadder } from './Explain';
import { DatasetPicker, DEFAULT_PICKER, buildDataset, describeDataset } from './DatasetPicker';
import { SweepChart, seriesLabel, type SeriesView, type Signal } from './SweepChart';
import { SlopeChart } from './SlopeChart';
import { download, downloadBlob, toCsv, toJson } from './export';
import { plotCanvasOf, renderSheet, type ChartShot } from './png';

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
  // The PNG export reads the charts back out of this subtree (see `exportPng`).
  const sectionRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState('initializing…');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(true);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  // A run measures one key type or the other, never both (docs/METHODOLOGY.md §2.5), so
  // exactly one of these two is non-null at any time.
  const [stringResult, setStringResult] = useState<StringCompareResult | null>(null);
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
      if (d.keyType === 'string') {
        setResult(null);
        setStringResult(await runStringSweeps(engine, d, setStatus));
      } else {
        setStringResult(null);
        setResult(await runAllSweeps(engine, d, setStatus));
      }
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

  // The string run (docs/METHODOLOGY.md §2.5): its own two structures, its own section.
  const stringSearch = useMemo(
    () => (stringResult?.search ?? []).map((v) => toView(v.series, signal)),
    [stringResult, signal],
  );
  const stringChurn = useMemo(
    () =>
      (stringResult?.mutation ?? [])
        .filter((v) => v.series.op === 'churn')
        .map((v) => toView(v.series, signal)),
    [stringResult, signal],
  );
  const stringSplit = useMemo(
    () =>
      (stringResult?.mutation ?? [])
        .filter((v) => v.series.op !== 'churn')
        .map((v) => toView(v.series, signal)),
    [stringResult, signal],
  );

  const shape = result?.shape ?? 'random';
  const sortedNote = shape === 'sorted';
  const reverse = dataset?.order.kind === 'reverse-sorted';

  /**
   * Every chart currently on screen, in the order the page shows them, each paired with
   * the views that name its lines. This is the PNG sheet's contents: the charts the user
   * is actually looking at, not a fixed list, so a string run exports its two and a
   * numeric run exports its four.
   */
  const deleteRows = (vs: readonly SeriesView[]) => vs.filter((v) => v.series.op === 'delete');
  const chartsOnScreen: ReadonlyArray<{
    name: string;
    title: string;
    views: readonly SeriesView[];
    /**
     * Extra legend rows with no line on the chart. The churn charts carry the
     * finite-difference **delete-by-value** figures here, because a churn line read alone
     * can be true and misleading at once — the linked list's flat O(1) most of all
     * (docs/METHODOLOGY.md §2.3 regime 7). On the page that pairing is made by a caveat
     * box; in an exported image the box does not travel, so the number has to.
     */
    extra?: readonly SeriesView[];
  }> = [
    { name: 'search', title: 'Search — the cost of finding a key', views: search },
    { name: 'churn', title: 'Add / remove (churn)', views: churn, extra: deleteRows(split) },
    { name: 'heap-churn', title: 'Min-heap — insert + extract-min', views: heapChurn, extra: deleteRows(heapSplit) },
    { name: 'heap-scan', title: 'Min-heap vs array — the linear scan', views: [...heapScan, ...arrayScan] },
    { name: 'string-search', title: 'Text keys — search', views: stringSearch },
    { name: 'string-churn', title: 'Text keys — add / remove (churn)', views: stringChurn, extra: deleteRows(stringSplit) },
  ].filter((c) => c.views.length > 0);

  /**
   * The qualifiers the page prints beside its charts, reduced to caption lines so they
   * leave the page with the picture. A PNG is the artifact most likely to be read with no
   * page attached, so every claim on it that the project does *not* stand behind unqualified
   * has to say so here.
   */
  const sheetNotes = (): string[] => {
    const notes: string[] = [];
    if (churn.some((v) => v.series.structure === 'll')) {
      notes.push(
        'Read the linked list’s flat add/remove with its delete row above it: the O(1) holds only for the key the ' +
          'list just put at its own head. Removing a key already stored is the O(n) delete-by-value (METHODOLOGY §2.3).',
      );
    }
    if (stringSearch.some((v) => v.series.structure === 'triestr')) {
      notes.push(
        'The trie’s flat line is a pessimistic constant: every structure here is asked the same questions, and the ' +
          'shared absent probes (a stored key with its last character changed) are the deepest miss a trie can have — ' +
          'an unrelated string would stop at the first byte (METHODOLOGY §2.5).',
      );
    }
    if (stringSearch.some((v) => v.series.structure === 'arraystr')) {
      notes.push(
        'The string array’s fitted label is not a claim this tool makes: its scan is linear in the number of keys, ' +
          'and the tail bends up because the array holds pointers to text, not the text (METHODOLOGY §2.5).',
      );
    }
    if (signal === 'nanos') {
      notes.push(
        'Wall-clock costs are specific to this machine and this run — compare the shapes, not the absolute nanoseconds.',
      );
    }
    return notes;
  };

  const exportPng = () => {
    const root = sectionRef.current;
    if (!root) return;
    const shots: ChartShot[] = [];
    for (const c of chartsOnScreen) {
      const canvas = plotCanvasOf(root.querySelector<HTMLElement>(`[data-chart="${c.name}"]`));
      if (canvas) {
        shots.push({
          title: c.title,
          canvas,
          legend: [
            ...c.views.map((v) => ({ text: seriesLabel(v), color: v.color })),
            // Cross-check rows: no line on the chart, but the number the chart must be
            // read against (see `chartsOnScreen.extra`).
            ...(c.extra ?? []).map((v) => ({
              text: `cross-check — ${seriesLabel(v)}`,
              color: v.color,
            })),
          ],
        });
      }
    }
    if (shots.length === 0) return;
    // The provenance travels with the picture: a chart without its dataset, signal and
    // machine is a shape with no claim attached (docs/PLAN.md §6.2 — results are
    // machine-specific and relative).
    const caption = [
      `Mr Data Structure — ${dataset ? describeDataset(dataset) : 'no dataset'}`,
      `signal: ${signal === 'nanos' ? 'wall-clock ns/op (this machine)' : 'op-count (hardware-free)'}` +
        ` · engine: ${version || '—'} · ${new Date().toISOString()}`,
      ...sheetNotes(),
    ];
    renderSheet(shots, caption).toBlob((blob) => {
      if (blob) downloadBlob('mr-data-structure-charts.png', blob);
    });
  };

  const exportAll = (kind: 'csv' | 'json') => {
    const views = [
      ...search,
      ...churn,
      ...split,
      ...heapScan,
      ...heapChurn,
      ...heapSplit,
      ...stringSearch,
      ...stringChurn,
      ...stringSplit,
    ];
    const meta = {
      dataset: dataset ? describeDataset(dataset) : null,
      order: dataset?.order,
      signal,
      engine: version,
      ...(stringResult ? { meanKeyBytes: stringResult.meanKeyBytes } : {}),
    };
    if (kind === 'csv') download('mr-data-structure-sweep.csv', toCsv(views), 'text/csv');
    else download('mr-data-structure-sweep.json', toJson(views, meta), 'application/json');
  };

  return (
    <section ref={sectionRef} style={{ marginTop: 40 }}>
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

      {/* Either kind of run gets the controls. The signal selector especially: the string
          section's whole argument is "switch to op-count and the key length drops out". */}
      {result || stringResult ? (
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
          <button onClick={() => exportAll('json')} style={{ fontSize: 12 }}>export JSON</button>{' '}
          <button onClick={exportPng} style={{ fontSize: 12 }} title="every chart below, stacked into one image with its legend and this run's provenance">
            export PNG
          </button>
        </p>
      ) : (
        <Callout title="Measuring…" tone="info">
          The sweeps run real timed work in a background worker, so this takes a few seconds. Current step:{' '}
          <strong>{status}</strong>. The charts appear below as each sweep finishes.
        </Callout>
      )}

      {/* A numeric run and a string run are mutually exclusive, so each set of sections —
          headings included — is gated on its own result rather than on its series list. */}
      {result && (
        <>
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
          <SweepChart name="search" views={search} signal={signal} showTheory={showTheory} showSpread={showSpread} shape={shape} />
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
          <SweepChart name="churn" views={churn} signal={signal} showTheory={showTheory} showSpread={showSpread} shape={shape} />
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
          <SweepChart name="heap-churn" views={heapChurn} signal={signal} showTheory={showTheory} showSpread={showSpread} shape={shape} />
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
            name="heap-scan"
            views={[...heapScan, ...arrayScan]}
            signal={signal}
            showTheory={showTheory}
            showSpread={showSpread}
            shape={shape}
          />
        </>
      )}
        </>
      )}

      {stringResult && (
        <>
          <h3 style={h3}>Text keys — the same structures, a second cost axis</h3>
          <p style={{ color: '#555', marginTop: 0 }}>
            Your keys are text, so this run measured the three structures built to store text: the
            same unsorted array and the same hash set, comparing and hashing <em>strings</em> instead
            of numbers, plus a <strong>trie</strong> — a tree of shared prefixes that stores a key as
            a path, one node per byte. The shapes below are the ones you would expect — the array
            scans, the hash set jumps, the trie walks the key — but a number is one machine word and
            a key of{' '}
            <strong>{stringResult.meanKeyBytes.toFixed(1)} bytes</strong> (this corpus’s average) is
            not. Everything here costs what the textbook says <em>in the number of keys</em>, and
            something extra per byte of the key on top.
          </p>
          {stringSearch.length > 0 && (
            <>
              <ul style={{ marginTop: 8 }}>
                {stringSearch.map((v) => <FitRow key={v.series.structure} v={v} />)}
              </ul>
              <SweepChart name="string-search" views={stringSearch} signal={signal} showTheory={showTheory} showSpread={showSpread} shape="random" />
              <SlopeChart views={stringSearch} />
              <Callout title="What to notice" tone="tip">
                The array (red) still rises in step with the number of keys, and <em>two</em> lines
                are flat — the hash set (blue) and the trie (cyan) — for completely unrelated
                reasons. The hash set reads the whole key once, turns it into a bucket number and
                jumps. The trie never hashes anything: it takes one branch per byte and stops the
                moment a byte has no child, which is why a key sharing nothing with your data is its
                cheapest miss and one differing in its last letter is its dearest. Both are constant
                in the <em>number</em> of keys, so which of the two sits lower on your screen is a
                fact about your key lengths and this machine’s memory, not about complexity. Switch
                the <strong>Signal</strong> selector to op-count: the hash set’s curve there is
                exactly its numeric twin’s, one hash and a short chain walk, flat. Switch back to
                wall-clock and the same flat line sits higher, because that one hash reads every byte
                of the key. Then re-run with the key-length boxes set to 30–40 characters: both flat
                lines lift without tilting. That is the honest reading of “O(1)” — constant in the
                number of keys, linear in the size of one.
              </Callout>
              <Callout title="Why the array’s label may say n·log n" tone="caveat">
                The array’s scan is linear in the number of keys — the slope above sits at about 1,
                with a very tight fit. Its label still comes out as the next class up about as often
                as not, and that is the wall clock telling the truth about memory rather than the
                fitter failing. An array of numbers holds its keys inline; an array of text holds
                <em>pointers</em> to text stored elsewhere, so a scan of 20,000 keys jumps around
                memory and each element costs a little more than the last. That gentle upward bend is
                what the label is reacting to. Switch to op-count and the curve is exactly straight:
                one comparison per element, no memory in it (docs/PLAN.md risk R3).
              </Callout>
            </>
          )}

          {stringChurn.length > 0 && (
            <>
              <p style={{ color: '#555', marginBottom: 4 }}>
                <strong>Add and remove, on text keys.</strong> Same churn method as above: at a fixed
                size, insert one key and remove it again, so n stays put. The key we cycle is taken
                from your own data with its last character changed — not a long sentinel — so the
                array pays the same byte-by-byte comparison it would pay on a real key. (A sentinel
                longer than every stored key would be rejected on the length check alone, which would
                have made the array look cheaper and the hash set dearer at the same time.) For the
                trie that same key means one insert adds exactly one node and the matching removal
                takes it back again, so what you are seeing is the walk down the key, not the cost of
                asking the allocator for a whole new branch.
              </p>
              <ul style={{ marginTop: 4 }}>
                {stringChurn.map((v) => <FitRow key={`${v.series.structure}-${v.series.op}`} v={v} />)}
              </ul>
              <SweepChart name="string-churn" views={stringChurn} signal={signal} showTheory={showTheory} showSpread={showSpread} shape="random" />
              <SlopeChart views={stringChurn} />
              {stringSplit.length > 0 && (
                <>
                  <p style={{ color: '#555', marginBottom: 4 }}>
                    <strong>Cross-check — the per-operation split</strong> (the same finite-difference
                    method as the numeric run: difference the cumulative build and teardown times).
                  </p>
                  <ul style={{ marginTop: 4 }}>
                    {stringSplit.map((v) => <FitRow key={`${v.series.structure}-${v.series.op}`} v={v} />)}
                  </ul>
                </>
              )}
              <Callout title="Why the trie’s label may say log n" tone="caveat">
                The trie’s line is flat and its label sometimes is not, and the gap is worth a
                minute. Count the work instead of timing it — switch <strong>Signal</strong> to
                op-count — and the curve is exactly, provably flat: looking up the same key takes
                the same number of steps in a trie holding a hundred keys and one holding a
                hundred thousand, because the walk only ever reads the key. What the wall clock
                adds is <em>memory</em>. Each byte of the key is one hop to a node stored somewhere
                else, and a trie over twenty thousand keys is tens of thousands of little nodes
                scattered across far more memory than a small one, so each hop is likelier to be a
                trip the processor has to wait for. Six hops per lookup means six chances to wait;
                the hash set, which makes one jump, drifts about six times less over the same
                sweep. The fitter sees that gentle upward bend and reaches for the next class up.
                It is reporting something real about this machine — just not about the algorithm.
              </Callout>
              <Callout title="What the trie’s number is, and is not" tone="caveat">
                All three structures are asked the <em>same</em> questions — the same present keys and
                the same absent ones — because a chart where each line got a workload tuned to suit it
                would not be a comparison. That shared workload builds its absent keys by taking one
                of yours and changing its last character, and for a trie that is the <em>worst</em>
                miss there is: the walk goes all the way down the key before discovering the key is
                not there. A miss on an unrelated string would stop at the first letter and cost
                almost nothing. So read the trie’s height as a pessimistic constant. What it is not is
                a slope: no choice of probe makes the line tilt, because nothing the trie does depends
                on how many keys are stored.
              </Callout>
              <Callout title="Why these three and not the other five" tone="caveat">
                Only the array, the hash set and the trie have string-key bench twins in the engine,
                so a text dataset measures three structures rather than seven. And these curves are
                read against each other only — never against the numeric charts, even though the
                operations have the same names. One run’s comparison is a byte-wise walk over a key;
                the other’s is a single instruction on a double. Putting them on one chart would be
                reading two different units off one axis. The op-count signal is per-structure too —
                “char-steps” for the trie, “hashes + chain probes” for the hash set — so on that
                signal compare the <em>shapes</em> of the curves and not their heights.
              </Callout>
            </>
          )}
        </>
      )}

    </section>
  );
}
