import { useMemo, useState } from 'react';
import type { BenchEngine } from '../bench/BenchEngine';
import {
  DEGREE_SWEEP_VERTICES,
  runGraphSweeps,
  toGraphView,
  type GraphCompareResult,
  type GraphSeriesView,
  type GraphSweepResult,
} from '../compare/runGraphSweeps';
import { GRAPH } from '../registry';
import { Callout } from './Explain';
import { GraphChart, graphClassLabel } from './GraphChart';
import type { Signal } from './SweepChart';
import {
  DEFAULT_GRAPH_PICKER,
  GRAPH_FAMILIES,
  MAX_PICKER_DEGREE,
  buildGraphSource,
  describeEdgeList,
  parsePickerEdgeList,
  type GraphFamily,
  type GraphPickerState,
} from './graphPicker';
import type { EdgeListDelimiter } from '../data/edgeList';

/**
 * The graph's Compare section (docs/PLAN.md §8 "Specialized", §10 Phase 6;
 * docs/METHODOLOGY.md §2.7). Its own data picker, its own run button, its own two charts —
 * because a graph shares nothing with the key runs above it: not the data (edges, not keys),
 * not the op set (traverse, not insert/search/delete), not even the x-axis (`V' + 2E'`, not
 * `n`). It shares the bench worker, so a graph run queues behind a key run instead of
 * competing with it for the clock, and the page's signal / overlay / spread controls.
 *
 * It does **not** run on page load. The key runs' default auto-run is what the browser gate
 * measures first, and it must stay exactly as it was; the graph is measured when asked
 * (`scripts/verify-browser.mjs` drives it in its own, final pass).
 */

interface GraphCompareSectionProps {
  /** The shared bench engine (null until the Compare section has created it). */
  readonly engineOf: () => BenchEngine | null;
  /** A key-dataset run is in progress. */
  readonly busy: boolean;
  readonly signal: Signal;
  readonly showTheory: boolean;
  readonly showSpread: boolean;
}

const h3: React.CSSProperties = { fontSize: 16, marginTop: 28, marginBottom: 4 };
const h4: React.CSSProperties = { fontSize: 15, marginTop: 20, marginBottom: 4 };
const small: React.CSSProperties = { fontSize: 13, color: '#666' };
const cell: React.CSSProperties = { padding: '2px 8px', textAlign: 'right' };

function FitLine({ v }: { readonly v: GraphSeriesView }) {
  const se = v.fit.slopeStderr > 0 ? ` ± ${v.fit.slopeStderr.toFixed(2)}` : '';
  return (
    <li>
      <strong style={{ color: v.color }}>{v.series.traversal === 'bfs' ? 'breadth-first (BFS)' : 'depth-first (DFS)'}</strong>:{' '}
      <strong>{graphClassLabel(v.fit.best)}</strong> (slope {v.fit.logLogSlope.toFixed(2)}
      {se} against V′ + 2E′, tail {v.fit.tailSlope.toFixed(2)}, R² {v.fit.r2.toFixed(3)}, {v.fit.trend})
    </li>
  );
}

/** The per-point table: what each graph was, how much of it was reached, what it cost. */
function PointTable({ bfs, dfs }: { readonly bfs: GraphSeriesView; readonly dfs: GraphSeriesView }) {
  const rows = bfs.series.points.map((p, i) => ({ p, d: dfs.series.points[i] }));
  return (
    <table style={{ fontSize: 12, borderCollapse: 'collapse', margin: '8px 0' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #ddd' }}>
          {['V', 'E', 'avg degree', 'reached', 'V′ + 2E′', 'BFS ops', 'DFS ops', 'BFS ns', 'DFS ns', 'BFS ns per visit'].map((h) => (
            <th key={h} style={cell}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ p, d }) => (
          <tr key={`${p.vertices}-${p.edges}`}>
            <td style={cell}>{p.vertices.toLocaleString()}</td>
            <td style={cell}>{p.edges.toLocaleString()}</td>
            <td style={cell}>{p.degree.toFixed(1)}</td>
            <td style={{ ...cell, color: p.reachedVertices < p.vertices ? '#b35900' : undefined }}>
              {p.reachedVertices.toLocaleString()} of {p.vertices.toLocaleString()}
            </td>
            <td style={cell}>{p.n.toLocaleString()}</td>
            <td style={cell}>{p.opCount.toLocaleString()}</td>
            <td style={cell}>{d.opCount.toLocaleString()}</td>
            <td style={cell}>{Math.round(p.nanosPerOp).toLocaleString()}</td>
            <td style={cell}>{Math.round(d.nanosPerOp).toLocaleString()}</td>
            <td style={cell}>{p.n > 0 ? (p.nanosPerOp / p.n).toFixed(2) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One sweep: what was measured, the identity checks, the fits, the chart and the table (exported for the render test). */
export function SweepBlock({
  title,
  result,
  views,
  name,
  signal,
  showTheory,
  showSpread,
}: {
  readonly title: string;
  readonly result: GraphSweepResult;
  readonly views: readonly GraphSeriesView[];
  readonly name: string;
  readonly signal: Signal;
  readonly showTheory: boolean;
  readonly showSpread: boolean;
}) {
  const [bfs, dfs] = views;
  return (
    <>
      <h4 style={h4}>{title}</h4>
      <p style={small}>
        Measured on: {result.description}.{' '}
        {result.synthetic ? <em>Generated graphs, not your data.</em> : <strong>Your data.</strong>}
      </p>
      <ul style={{ ...small, marginTop: 4 }}>
        <li>
          Work counted = vertices reached + 2 × edges reached, at every point:{' '}
          <strong>{result.countsMatchComponent ? 'yes, exactly' : 'NO — the op-count disagrees with the graph; treat this run as suspect'}</strong>
        </li>
        <li>
          BFS and DFS do the same amount of work:{' '}
          <strong>{result.bfsEqualsDfs ? 'yes, at every point (in different orders)' : 'NO'}</strong>
        </li>
        <li>
          {result.allReached ? (
            <>Every traversal reached the whole graph.</>
          ) : (
            <>
              <strong>Not every vertex was reached.</strong> A traversal from vertex 0 only visits the part of the graph
              connected to it, so each point is plotted at the size of <em>that</em> part (the “reached” column), not
              at the size of the whole graph.
            </>
          )}
        </li>
      </ul>
      <ul style={{ marginTop: 4 }}>
        <FitLine v={bfs} />
        <FitLine v={dfs} />
      </ul>
      <GraphChart name={name} views={views} signal={signal} showTheory={showTheory} showSpread={showSpread} />
      <PointTable bfs={bfs} dfs={dfs} />
    </>
  );
}

export function GraphCompareSection({ engineOf, busy, signal, showTheory, showSpread }: GraphCompareSectionProps) {
  const [picker, setPicker] = useState<GraphPickerState>(DEFAULT_GRAPH_PICKER);
  const [result, setResult] = useState<GraphCompareResult | null>(null);
  const [status, setStatus] = useState('not run yet');
  const [running, setRunning] = useState(false);
  const set = (patch: Partial<GraphPickerState>) => setPicker((s) => ({ ...s, ...patch }));

  const parsed = useMemo(() => parsePickerEdgeList(picker), [picker]);

  const run = async () => {
    const engine = engineOf();
    if (!engine) return;
    setRunning(true);
    try {
      const source = buildGraphSource(picker);
      await engine.ready();
      setResult(await runGraphSweeps(engine, source, setStatus));
      setStatus('ready');
    } catch (err) {
      setStatus('error: ' + (err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const vViews = useMemo(
    () => (result ? [toGraphView(result.vertexSweep.bfs.series, signal), toGraphView(result.vertexSweep.dfs.series, signal)] : []),
    [result, signal],
  );
  const dViews = useMemo(
    () => (result ? [toGraphView(result.degreeSweep.bfs.series, signal), toGraphView(result.degreeSweep.dfs.series, signal)] : []),
    [result, signal],
  );

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => set({ text, family: 'edge-list' }));
  };

  return (
    <>
      <h3 style={h3}>The graph — a structure with two sizes</h3>
      <p style={{ color: '#555', marginTop: 0 }}>
        Everything above stores <em>keys</em>. A graph stores <em>connections</em>: a set of points (vertices) and
        the links between them (edges), kept here as a list of neighbours for each point. It is not asked to add,
        find or remove a key — its job is to <strong>walk</strong> everything reachable from a starting point, either
        breadth-first (nearest points first, using a queue) or depth-first (one branch as far as it goes, using a
        stack). So it gets its own data, its own scoreboard, and its own picker below. It never touches the dataset
        you chose above: a list of keys has no edges in it, and inventing some would be measuring a made-up graph.
      </p>
      <p style={{ color: '#555' }}>
        A walk visits every reachable point once and reads every link from both ends, so its cost is{' '}
        <strong>points + 2 × links</strong> ({GRAPH.ops.traversal} in the textbook’s notation). That depends on{' '}
        <em>two</em> sizes, which is why there are two experiments: one grows the number of points while each keeps
        about the same number of links, the other keeps the points fixed and adds links. The charts plot cost against
        “points + 2 × links actually reached” (V′ + 2E′) rather than against a single n.
      </p>

      <div style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '8px 12px', fontSize: 14, background: '#fafafa' }}>
        <label>
          <strong>Graph for the first experiment</strong>:{' '}
          <select
            value={picker.family}
            onChange={(e) => set({ family: e.target.value as GraphFamily })}
            style={{ fontSize: 14 }}
            aria-label="graph family"
          >
            {GRAPH_FAMILIES.map((f) => (
              <option key={f.family} value={f.family}>
                {f.label}
              </option>
            ))}
          </select>
        </label>{' '}
        <span style={small}>{GRAPH_FAMILIES.find((f) => f.family === picker.family)?.hint}</span>
        {picker.family === 'random' && (
          <div style={{ marginTop: 6 }}>
            <label>
              average degree (links per point){' '}
              <input
                type="number"
                min={0}
                max={MAX_PICKER_DEGREE}
                step={1}
                value={picker.degree}
                onChange={(e) => set({ degree: Number(e.target.value) })}
                style={{ width: 64 }}
              />
            </label>{' '}
            <label style={{ marginLeft: 12 }}>
              seed{' '}
              <input type="number" value={picker.seed} onChange={(e) => set({ seed: Number(e.target.value) })} style={{ width: 64 }} />
            </label>
          </div>
        )}
        {picker.family === 'edge-list' && (
          <div style={{ marginTop: 6 }}>
            <textarea
              value={picker.text}
              onChange={(e) => set({ text: e.target.value })}
              rows={6}
              placeholder={'alice,bob\nbob,carol\ncarol,alice\n…  (one edge per line)'}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              aria-label="edge list"
            />
            <div style={{ marginTop: 4 }}>
              <input type="file" accept=".csv,.tsv,.txt,.edges,text/plain" onChange={(e) => onFile(e.target.files?.[0])} />{' '}
              <label style={{ marginLeft: 8 }}>
                separator{' '}
                <select
                  value={picker.delimiter}
                  onChange={(e) => set({ delimiter: e.target.value as EdgeListDelimiter })}
                  aria-label="edge list separator"
                >
                  <option value="comma">comma</option>
                  <option value="tab">tab</option>
                  <option value="whitespace">spaces / tabs</option>
                </select>
              </label>
              <label style={{ marginLeft: 8 }}>
                <input type="checkbox" checked={picker.header} onChange={(e) => set({ header: e.target.checked })} /> first line is a header
              </label>
              <label style={{ marginLeft: 8 }}>
                <input type="checkbox" checked={picker.comments} onChange={(e) => set({ comments: e.target.checked })} /> skip lines starting with #
              </label>
            </div>
            <p style={{ ...small, margin: '4px 0 0' }}>
              {parsed && parsed.labels.length > 0 ? describeEdgeList(parsed) : 'Nothing parsed yet.'} Labels are kept
              as text (so <code>02134</code> and <code>2134</code> are two different points) and numbered in the order
              they first appear. Repeated lines are kept as parallel links, and a line like <code>a,a</code> as a
              loop. The first experiment measures longer and longer opening stretches of your list.
            </p>
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <button onClick={() => void run()} disabled={running || busy} style={{ fontSize: 14 }}>
            measure the graph
          </button>{' '}
          <span style={small}>
            graph status: <strong>{running ? status : busy ? 'waiting for the key sweeps above' : status}</strong>
          </span>
        </div>
        <p style={{ ...small, margin: '4px 0 0' }}>
          The second experiment always uses a generated graph of {DEGREE_SWEEP_VERTICES.toLocaleString()} points,
          because keeping the points fixed while adding links is something only a generated graph can be made to do.
        </p>
      </div>

      {result && vViews.length === 2 && dViews.length === 2 && (
        <>
          <SweepBlock
            title="Experiment 1 — more points, about the same links per point"
            result={result.vertexSweep}
            views={vViews}
            name="graph-vertices"
            signal={signal}
            showTheory={showTheory}
            showSpread={showSpread}
          />
          <VertexSweepNote />
          <SweepBlock
            title="Experiment 2 — the same points, more and more links"
            result={result.degreeSweep}
            views={dViews}
            name="graph-degree"
            signal={signal}
            showTheory={showTheory}
            showSpread={showSpread}
          />
          <DegreeSweepNote />
          <WallClockCaveat />
        </>
      )}
    </>
  );
}

/** Under experiment 1: what the V-sweep shows, and what it cannot (exported for the render test). */
export function VertexSweepNote() {
  return (
    <Callout title="What to notice" tone="tip">
      Both walks rise roughly in step with the graph: double the graph, double the work. The solid line
      (breadth-first) and the dotted one (depth-first) visit the points in completely different orders, yet switch
      the <strong>Signal</strong> selector to op-count and they lie exactly on top of each other on a slope of exactly
      1 — the same amount of work, done in a different order. What this chart <em>cannot</em> tell you is whether the
      links cost anything: here the number of links grows in step with the number of points, so a walk that ignored
      the links entirely would draw the very same straight line. That is what the second experiment is for.
    </Callout>
  );
}

/** Under experiment 2: the +E term made visible (exported for the render test). */
export function DegreeSweepNote() {
  return (
    <Callout title="What to notice" tone="tip">
      The number of points never changes here — only links are added, and each point is the previous graph with more
      links on top. If a walk’s cost depended only on the points, this line would be flat. It rises, because every
      link is read twice (once from each end). That rise is the “+ E” in {GRAPH.ops.traversal}, made visible: each
      extra link adds exactly two units of counted work, which the op-count signal shows with no noise at all. On the
      wall clock the line can rise a little less steeply than 1, because handling a point costs more than reading one
      link, and the points’ share of the work shrinks as links are added.
    </Callout>
  );
}

/** The wall-clock caveat both experiments are read with (exported for the render test). */
export function WallClockCaveat() {
  return (
    <Callout title="Reading the wall-clock lines honestly" tone="caveat">
      The counted work is exact; the time is not, and it bends for reasons that are about memory rather than the
      algorithm. In the first experiment the graph grows from something that fits in the processor’s fast caches to
      something that does not, so each visit gets slower as the graph gets bigger — in a random graph a walk jumps to
      an unpredictable place in memory at almost every step — and the slope can sit well above 1. The fitted label may
      then say <em>n log n</em>: that is the fitter reacting to memory, not a claim this tool makes about the walk,
      whose counted work is exactly linear (switch to op-count). A path or a grid, whose neighbours sit next to each
      other in memory, shows much less of it. In the second experiment the points stay put and only the neighbour
      lists grow, so that effect is smaller. The “ns per visit” column shows it directly: a perfectly linear cost
      would keep that column constant. Breadth-first and depth-first can also differ in time by a constant factor — a
      queue and a stack touch memory in different patterns — even though their counted work is identical.
    </Callout>
  );
}
