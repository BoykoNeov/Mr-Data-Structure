import { useEffect, useState } from 'react';
import type { BenchEngine } from '../bench/BenchEngine';
import type { StructureId } from '../bench/measure';
import {
  MAX_OP_WORKLOAD,
  RBT_ROTATION_BOUND,
  ladderOf,
  maxOpCsv,
  maxOpFindings,
  maxOpJson,
  runMaxOp,
  topRows,
  type MaxOpResult,
  type MaxOpRow,
} from '../compare/maxOp';
import type { Dataset } from '../data';
import { REGISTRY } from '../registry';
import { Callout } from './Explain';
import { describeDataset } from './DatasetPicker';
import { download } from './export';

/**
 * The **worst single operation** section of Compare (docs/PLAN.md §13, docs/METHODOLOGY.md §4
 * hurdle 13): for every structure on the shared charts, the most expensive single insert and
 * single delete across the mutation size ladder, beside the mean an op-count chart point
 * would show. It exists because the red-black tree's defining guarantee — at most 2 rotations
 * per insert and 3 per delete — is a statement about one operation, and no average can show it.
 *
 * **Clock-free and on request.** One operation is far too short to time in a browser, so
 * every figure is counted, and the section says so on screen and in its exports. It never runs
 * on page load: the mount-time auto-run is what the browser gate measures first and must stay
 * exactly as it was, and a profile queued behind it would also race the gate's later passes.
 * Its own button, enabled after a numeric run; it profiles that run's dataset on that run's
 * mutation ladder (`result.mutationSizes`, ≤ 4 000 — the BST on sorted input is Θ(n²) to build).
 */

interface MaxOpSectionProps {
  /** The shared bench engine (null until the Compare section has created it). */
  readonly engineOf: () => BenchEngine | null;
  /** A key-dataset run is in progress. */
  readonly busy: boolean;
  /** The dataset of the numeric run on screen, or null (no run yet, or a text-key run). */
  readonly dataset: Dataset | null;
  /** That run's mutation ladder. */
  readonly sizes: readonly number[] | null;
}

const h3: React.CSSProperties = { fontSize: 16, marginTop: 28, marginBottom: 4 };
const h4: React.CSSProperties = { fontSize: 15, marginTop: 20, marginBottom: 4 };
const small: React.CSSProperties = { fontSize: 13, color: '#666' };
const cell: React.CSSProperties = { padding: '2px 8px', textAlign: 'right', whiteSpace: 'nowrap' };
const head: React.CSSProperties = { ...cell, fontWeight: 600 };
const nameCell: React.CSSProperties = { ...cell, textAlign: 'left' };

const nameOf = (s: StructureId) => REGISTRY[s]?.label ?? s;
const colorOf = (s: StructureId) => REGISTRY[s]?.color ?? '#888';
const fmt = (x: number | null) => (x === null ? '—' : x.toLocaleString());
const mean = (x: number) => x.toFixed(1);
const at = (x: number | null) => (x === null ? '' : ` (#${x.toLocaleString()})`);

function StructureName({ s }: { readonly s: StructureId }) {
  return <strong style={{ color: colorOf(s) }}>{nameOf(s)}</strong>;
}

/** Worst insert / worst delete per structure at every rung of the ladder (exported for the render test). */
export function MaxOpLadderTable({ result }: { readonly result: MaxOpResult }) {
  return (
    <table data-max-op="ladder" style={{ fontSize: 12, borderCollapse: 'collapse', margin: '8px 0' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #ddd' }}>
          <th style={nameCell}>structure (its op-count unit)</th>
          {result.sizes.map((n) => (
            <th key={n} style={head}>n = {n.toLocaleString()}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.structures.map((s) => (
          <tr key={s}>
            <td style={nameCell}>
              <StructureName s={s} /> <span style={{ color: '#888' }}>({REGISTRY[s]?.costMetric})</span>
            </td>
            {ladderOf(result, s).map((r) => (
              <td key={r.n} style={cell}>
                {fmt(r.insert.maxOps)} / {fmt(r.delete.maxOps)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Worst against average at the top of the ladder, plus the grow-and-copy column (exported for the render test). */
export function MaxOpTopTable({ result }: { readonly result: MaxOpResult }) {
  const rows = topRows(result);
  const deduped = rows.some((r) => r.delete.misses > 0);
  return (
    <table data-max-op="top" style={{ fontSize: 12, borderCollapse: 'collapse', margin: '8px 0' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #ddd' }}>
          {[
            'structure',
            'worst insert (#)',
            'mean insert',
            'worst delete (#)',
            'mean delete',
            'largest grow-and-copy: keys re-placed (#insert)',
            'grows',
            ...(deduped ? ['deletes that found nothing'] : []),
          ].map((h) => (
            <th key={h} style={h === 'structure' ? nameCell : head}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r: MaxOpRow) => (
          <tr key={r.structure}>
            <td style={nameCell}><StructureName s={r.structure} /></td>
            <td style={cell}>{fmt(r.insert.maxOps)}{at(r.insert.maxOpsAt)}</td>
            <td style={cell}>{mean(r.insert.meanOps)}</td>
            <td style={cell}>{fmt(r.delete.maxOps)}{at(r.delete.maxOpsAt)}</td>
            <td style={cell}>{mean(r.delete.meanOps)}</td>
            <td style={cell}>
              {r.insert.maxMoved === null ? 'no such step' : `${fmt(r.insert.maxMoved)}${at(r.insert.maxMovedAt)}`}
            </td>
            <td style={cell}>{fmt(r.insert.resizes)}</td>
            {deduped && <td style={cell}>{fmt(r.delete.misses)} of {fmt(r.delete.count)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The two balanced trees, rotation by rotation, across the ladder (exported for the render test). */
export function MaxOpTreeTable({ result }: { readonly result: MaxOpResult }) {
  const avl = ladderOf(result, 'avl');
  const rbt = ladderOf(result, 'rbt');
  if (avl.length === 0 || rbt.length === 0) return null;
  const line = (label: string, xs: readonly (number | null)[]) => (
    <tr key={label}>
      <td style={nameCell}>{label}</td>
      {xs.map((x, i) => (
        <td key={result.sizes[i]} style={cell}>{fmt(x)}</td>
      ))}
    </tr>
  );
  return (
    <table data-max-op="trees" style={{ fontSize: 12, borderCollapse: 'collapse', margin: '8px 0' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #ddd' }}>
          <th style={nameCell}>most in one operation</th>
          {result.sizes.map((n) => (
            <th key={n} style={head}>n = {n.toLocaleString()}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {line('AVL — rotations, one insert', avl.map((r) => r.insert.maxRotations))}
        {line('red-black — rotations, one insert (limit 2)', rbt.map((r) => r.insert.maxRotations))}
        {line('AVL — rotations, one delete', avl.map((r) => r.delete.maxRotations))}
        {line(`red-black — rotations, one delete (limit ${RBT_ROTATION_BOUND.delete})`, rbt.map((r) => r.delete.maxRotations))}
        {line('red-black — recolours, one insert (not in its op-count)', rbt.map((r) => r.insert.maxRecolours))}
        {line('red-black — recolours, one delete (not in its op-count)', rbt.map((r) => r.delete.maxRecolours))}
        {line('AVL — tree height', avl.map((r) => r.height))}
        {line('red-black — tree height', rbt.map((r) => r.height))}
      </tbody>
    </table>
  );
}

/** Everything a profile shows, given the result (exported so the render test can drive it without an engine). */
export function MaxOpResults({ result, description }: { readonly result: MaxOpResult; readonly description: string }) {
  const findings = maxOpFindings(result);
  return (
    <>
      <p style={small}>
        Counted on: {description}. <strong>Not timed</strong> — every number below is a count of steps.
      </p>
      <h4 style={h4}>The worst single insert / delete, at every size</h4>
      <p style={small}>
        Each cell is <em>worst insert / worst delete</em> in that structure’s own op-count unit — the unit its
        op-count line uses on the charts above, so compare structures here as loosely as you would there.
      </p>
      <MaxOpLadderTable result={result} />
      <h4 style={h4}>Worst against average, at n = {result.sizes[result.sizes.length - 1].toLocaleString()}</h4>
      <p style={small}>
        The mean is the figure an op-count chart point stands for; the worst is what one unlucky operation paid. The
        number after each worst case is which operation of its pass it was (the 1st insert, the 2,049th, …).
      </p>
      <MaxOpTopTable result={result} />
      <h4 style={h4}>The two balancing schemes, one operation at a time</h4>
      <MaxOpTreeTable result={result} />
      {findings.length > 0 && (
        <ul data-max-op="findings" style={{ fontSize: 14, color: '#333' }}>
          {findings.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
      <MaxOpNotes />
    </>
  );
}

/** The fixed reading notes under the tables (exported for the render test). */
export function MaxOpNotes() {
  return (
    <>
      <Callout title="What this view is for" tone="tip">
        The red-black tree’s whole promise is about <em>one</em> operation: however the keys arrive, a single insert
        rotates at most {RBT_ROTATION_BOUND.insert} times and a single delete at most {RBT_ROTATION_BOUND.delete}. The
        AVL keeps the same limit on inserts, so on inserts the two schemes promise the same. A single AVL delete, though, may have
        to rebalance at every level on its way back to the root, so its worst case grows with the height of the tree. A
        chart of averages cannot show any of this: a structure that is usually cheap and occasionally very expensive
        and one that is never expensive can draw the same line. The “rotations” rows above are the place to look — and
        they say nothing about how many rotations either tree does <em>in total</em>, which is a different question
        with a much closer answer (docs/METHODOLOGY.md §2.9). The red-black tree’s colour changes are listed on their
        own rows and are never added to its op-count, because the AVL has no colours to pay for.
      </Callout>
      <Callout title="Why the arrays and hash sets have a huge worst case that their op-count says is 0" tone="caveat">
        Appending to an array is free on its op-count (nothing is compared or shifted), and a hash set’s insert costs a
        hash and a short chain. But every so often the array’s block of memory is full, so a bigger one is taken and
        every key moves across; and every so often the hash set’s table is too crowded, so it doubles and every key is
        placed again. That one insert does work in proportion to <em>all</em> the keys stored so far. It is real, and
        it is outside the op-count on purpose — it happens rarely enough that, spread over all the inserts, it adds
        only a constant to each, which is what “amortised O(1)” means. The grow-and-copy column counts it on its own.
        (“Re-placed” rather than “copied”: the memory system can sometimes extend a block where it is, and this count
        cannot see that.) The linked structures have no such step — each key gets its own node — so their column says
        so.
      </Callout>
      <Callout title="How to read the numbers honestly" tone="caveat">
        {MAX_OP_WORKLOAD} The worst insert can only rise as n grows, because a bigger n replays the same inserts and
        then some. A worst case is a property of this one sequence of keys: a different order of the same keys can move
        it. Three things are left out: the min-heap (its operations are insert and remove-the-smallest, not insert and
        delete, so it has its own section), the graph (it has no keys to insert) and text keys (a different run).
      </Callout>
    </>
  );
}

export function MaxOpSection({ engineOf, busy, dataset, sizes }: MaxOpSectionProps) {
  const [result, setResult] = useState<MaxOpResult | null>(null);
  const [status, setStatus] = useState('not run yet');
  const [running, setRunning] = useState(false);

  // A profile belongs to the dataset it counted; a new run on screen retires it.
  useEffect(() => {
    setResult(null);
    setStatus('not run yet');
  }, [dataset]);

  const description = dataset ? describeDataset(dataset) : '';

  const run = async () => {
    const engine = engineOf();
    if (!engine || !dataset || !sizes) return;
    setRunning(true);
    try {
      await engine.ready();
      setResult(await runMaxOp(engine, dataset, sizes, setStatus));
      setStatus('ready');
    } catch (err) {
      setStatus('error: ' + (err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const exportAs = (kind: 'csv' | 'json') => {
    if (!result) return;
    if (kind === 'csv') download('mr-data-structure-worst-op.csv', maxOpCsv(result), 'text/csv');
    else
      download(
        'mr-data-structure-worst-op.json',
        maxOpJson(result, { dataset: description, order: dataset?.order }),
        'application/json',
      );
  };

  const ready = dataset !== null && sizes !== null && sizes.length > 0;
  return (
    <>
      <h3 style={h3}>The worst single operation — what an average hides</h3>
      <p style={{ color: '#555', marginTop: 0 }}>
        Every chart above plots an <em>average</em> cost per operation. Some structures make a promise about their{' '}
        <em>worst</em> operation instead, and some hide a rare, very expensive one inside a cheap average. This view
        replays one fixed sequence of inserts and deletes on the dataset above, one operation at a time, and keeps the
        most expensive one. It is <strong>clock-free</strong>: a single operation takes a few billionths of a second, far
        too short for the browser’s clock, so every figure here is counted, never timed.
      </p>
      <div style={{ border: '1px solid #e5e5e5', borderRadius: 6, padding: '8px 12px', fontSize: 14, background: '#fafafa' }}>
        <button onClick={() => void run()} disabled={running || busy || !ready} style={{ fontSize: 14 }}>
          count the worst single operations
        </button>{' '}
        <span style={small}>
          status:{' '}
          <strong>
            {running ? status : busy ? 'waiting for the key sweeps above' : ready ? status : 'needs a run on numeric keys first'}
          </strong>
        </span>
        {result && (
          <>
            {' '}
            <button onClick={() => exportAs('csv')} style={{ marginLeft: 12, fontSize: 12 }}>export counts CSV</button>{' '}
            <button onClick={() => exportAs('json')} style={{ fontSize: 12 }}>export counts JSON</button>
          </>
        )}
      </div>
      {result && <MaxOpResults result={result} description={description} />}
    </>
  );
}
