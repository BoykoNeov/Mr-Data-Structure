import type { BenchEngine } from '../bench/BenchEngine';
import { MAX_OP_STRUCTURES, type RawMaxOpProfile } from '../bench/maxOp';
import type { StructureId } from '../bench/measure';
import { marshalKeys, type Dataset } from '../data';
import { REGISTRY } from '../registry';

/**
 * The **worst single operation** view's orchestration and data shaping (docs/PLAN.md §13,
 * docs/METHODOLOGY.md §4 hurdle 13). Pure over the {@link BenchEngine} boundary, so it is
 * tested against a fake engine; the UI (`src/ui/MaxOpSection.tsx`) only renders what comes back.
 *
 * Every Compare curve is a mean over a batch, so a guarantee about the *worst* operation —
 * the red-black tree's ≤ 2 rotations per insert and ≤ 3 per delete — is invisible on it, and
 * so is the rare dear operation an average hides (an array's or a hash set's grow-and-copy).
 * This view keeps the maximum instead of the mean. It is **clock-free** by necessity: one
 * operation is far too short to time in a browser (METHODOLOGY §2.1), so every figure is a
 * count from the twins' counted paths.
 */

/** What the profile does, said once — on screen, in the CSV and in the JSON alike. */
export const MAX_OP_WORKLOAD =
  'Clock-free (counted, not timed). At each size n: insert the first n keys of the dataset one at a time, ' +
  'in the dataset’s order, into an empty structure; then delete those n keys largest-then-smallest in turn. ' +
  'Each figure is the largest count any single operation of that pass reached; each column is maximised on ' +
  'its own, so two maxima can come from different operations. A hash set keeps one copy of a repeated key, so ' +
  'its delete of the second copy finds nothing — that delete is still counted.';

/** The signal tag every exported row carries, so a figure never leaves without saying what it is. */
export const MAX_OP_SIGNAL = 'op-count (clock-free; largest single operation)';

/** One pass's figures. `null` = the counter does not apply to this structure. */
export interface MaxOpPass {
  /** Largest single-operation op-count, in the structure's own metric (its op-count chart's unit). */
  readonly maxOps: number;
  /** 1-based position in the pass of the first operation that reached {@link maxOps}. */
  readonly maxOpsAt: number | null;
  /** Mean op-count per operation over the same pass — the figure a chart point averages. */
  readonly meanOps: number;
  /** Largest rotations in one operation — the AVL and the red-black tree only. */
  readonly maxRotations: number | null;
  /** Largest recolours in one operation — the red-black tree only; never part of `maxOps`. */
  readonly maxRecolours: number | null;
}

/** One structure at one size. */
export interface MaxOpRow {
  readonly structure: StructureId;
  readonly n: number;
  /** Keys held after the build — below `n` for a hash set fed repeated keys. */
  readonly stored: number;
  /** Tree height after the build (AVL and red-black only). */
  readonly height: number | null;
  readonly insert: MaxOpPass & {
    /**
     * Keys re-placed by the largest single grow-and-copy (the arrays' block, the hash sets'
     * table) — work **outside** the op-count metric, which is why no average shows it. `null`
     * for a structure with no grow-and-copy step; 0 if it had one but never grew with keys in it.
     */
    readonly maxMoved: number | null;
    readonly maxMovedAt: number | null;
    /** Grow-and-copy events in the build that re-placed at least one key. */
    readonly resizes: number | null;
  };
  readonly delete: MaxOpPass & {
    readonly count: number;
    /** Deletes that found nothing (a hash set's second copy of a repeated key). */
    readonly misses: number;
  };
}

export interface MaxOpResult {
  /** Always `true`: the marker exports carry so a reader cannot mistake these for timings. */
  readonly clockFree: true;
  readonly workload: string;
  readonly sizes: readonly number[];
  readonly structures: readonly StructureId[];
  /** Structure-major: every size of the first structure, then the next. */
  readonly rows: readonly MaxOpRow[];
}

const nullable = (x: number): number | null => (Number.isFinite(x) ? x : null);

/** Wire record → view row (`NaN` → `null`). */
export function shapeMaxOp(r: RawMaxOpProfile): MaxOpRow {
  return {
    structure: r.structure,
    n: r.n,
    stored: r.stored,
    height: nullable(r.height),
    insert: {
      maxOps: r.insert_max_ops,
      maxOpsAt: nullable(r.insert_max_ops_at),
      meanOps: r.insert_mean_ops,
      maxRotations: nullable(r.insert_max_rotations),
      maxRecolours: nullable(r.insert_max_recolours),
      maxMoved: nullable(r.insert_max_moved),
      maxMovedAt: nullable(r.insert_max_moved_at),
      resizes: nullable(r.resizes),
    },
    delete: {
      maxOps: r.delete_max_ops,
      maxOpsAt: nullable(r.delete_max_ops_at),
      meanOps: r.delete_mean_ops,
      maxRotations: nullable(r.delete_max_rotations),
      maxRecolours: nullable(r.delete_max_recolours),
      count: r.deletes,
      misses: r.delete_misses,
    },
  };
}

/** The row for `structure` at size `n`, if profiled. */
export function rowAt(r: MaxOpResult, structure: StructureId, n: number): MaxOpRow | undefined {
  return r.rows.find((x) => x.structure === structure && x.n === n);
}

/** Every structure's row at the largest profiled size, in the result's structure order. */
export function topRows(r: MaxOpResult): MaxOpRow[] {
  const top = r.sizes[r.sizes.length - 1];
  return r.structures.flatMap((s) => rowAt(r, s, top) ?? []);
}

/** One structure's rows across the size ladder, smallest n first. */
export function ladderOf(r: MaxOpResult, structure: StructureId): MaxOpRow[] {
  return r.sizes.flatMap((n) => rowAt(r, structure, n) ?? []);
}

/** The red-black tree's per-operation rotation bound (CLRS): insert, delete. */
export const RBT_ROTATION_BOUND = { insert: 2, delete: 3 } as const;

const label = (s: StructureId) => REGISTRY[s]?.label ?? s;

/**
 * The sentences the data supports, computed from this run rather than written in advance —
 * so the page never states a red-black/AVL contrast the dataset did not produce. Shared by the
 * section's caption and the exports. Never a claim about rotation *totals*: the bound is per
 * operation, and totals are a different question (METHODOLOGY §2.9).
 */
export function maxOpFindings(r: MaxOpResult): string[] {
  const out: string[] = [];
  const top = r.sizes[r.sizes.length - 1];
  const rb = rowAt(r, 'rbt', top);
  const avl = rowAt(r, 'avl', top);
  if (rb && rb.insert.maxRotations !== null && rb.delete.maxRotations !== null) {
    const held =
      rb.insert.maxRotations <= RBT_ROTATION_BOUND.insert && rb.delete.maxRotations <= RBT_ROTATION_BOUND.delete;
    out.push(
      `Red-black tree at n = ${top}: its worst single insert rotated ${rb.insert.maxRotations} time(s) and its worst ` +
        `single delete ${rb.delete.maxRotations} — ` +
        (held
          ? `inside its guaranteed limit of ${RBT_ROTATION_BOUND.insert} per insert and ${RBT_ROTATION_BOUND.delete} per delete.`
          : `PAST its guaranteed limit of ${RBT_ROTATION_BOUND.insert} / ${RBT_ROTATION_BOUND.delete}: treat this run as a bug.`),
    );
  }
  if (avl && avl.insert.maxRotations !== null && avl.delete.maxRotations !== null) {
    out.push(
      `AVL tree at n = ${top}: worst insert ${avl.insert.maxRotations} rotation(s) — an AVL insert never needs more ` +
        `than 2 either, so on inserts the two schemes promise the same — and worst delete ${avl.delete.maxRotations}` +
        (avl.height !== null ? ` (tree height ${avl.height}).` : '.'),
    );
    if (rb && rb.delete.maxRotations !== null) {
      out.push(
        avl.delete.maxRotations > RBT_ROTATION_BOUND.delete
          ? `On this data one AVL delete needed ${avl.delete.maxRotations} rotations, more than a red-black delete is ` +
              `ever allowed (${RBT_ROTATION_BOUND.delete}): an AVL delete may rebalance at every level on the way back ` +
              `up, and that per-operation bound is the real difference between the two schemes. It says nothing about ` +
              `rotation totals, which are close (METHODOLOGY §2.9).`
          : `On this data the AVL’s worst delete stayed within the red-black limit too. Its expensive deletes need a ` +
              `tree that is already lopsided somewhere; sorted input builds a near-perfect one, so the two schemes ` +
              `come out level here.`,
      );
    }
  }
  if (rb && avl && rb.delete.maxOps > avl.delete.maxOps && rb.height !== null && avl.height !== null && rb.height > avl.height) {
    out.push(
      `Counted in the shared unit (comparisons + rotations), the red-black tree’s worst delete (${rb.delete.maxOps}) ` +
        `costs more than the AVL’s (${avl.delete.maxOps}): its looser balance left it deeper (height ${rb.height} ` +
        `against ${avl.height}), and a walk down a deeper tree costs comparisons.`,
    );
  }
  for (const s of ['array', 'hashset'] as const) {
    const x = rowAt(r, s, top);
    if (x && x.insert.maxMoved !== null && x.insert.maxMoved > 0) {
      out.push(
        `The ${label(s)} at n = ${top}: its worst insert is ${x.insert.maxOps} on its own op-count, yet its largest ` +
          `grow-and-copy re-placed ${x.insert.maxMoved} keys at insert #${x.insert.maxMovedAt}. That copy is real ` +
          `work that the op-count leaves out and an average spreads thin — the meaning of “amortised O(1)”.`,
      );
    }
  }
  return out;
}

/** The figures the runtime gate could read (`scripts/verify-browser.mjs`), at the top size. */
export interface MaxOpProof {
  structure: string;
  n: number;
  insertMaxOps: number;
  deleteMaxOps: number;
  insertMaxRotations: number | null;
  deleteMaxRotations: number | null;
  insertMaxMoved: number | null;
}

export function toMaxOpProof(r: MaxOpResult): MaxOpProof[] {
  return topRows(r).map((x) => ({
    structure: x.structure,
    n: x.n,
    insertMaxOps: x.insert.maxOps,
    deleteMaxOps: x.delete.maxOps,
    insertMaxRotations: x.insert.maxRotations,
    deleteMaxRotations: x.delete.maxRotations,
    insertMaxMoved: x.insert.maxMoved,
  }));
}

interface MaxOpWindow {
  __maxOpProof?: MaxOpProof[];
}

/**
 * Profile every structure in {@link MAX_OP_STRUCTURES} on `dataset` at `sizes` — the caller
 * passes the Compare run's **mutation** ladder (≤ 4 000): the naive BST on sorted input is
 * Θ(n²) to build, so the 100 k search ladder would spend minutes on one line. Numeric keys only.
 */
export async function runMaxOp(
  engine: Pick<BenchEngine, 'runMaxOpProfile'>,
  dataset: Dataset,
  sizes: readonly number[],
  onStatus: (s: string) => void = () => {},
  win: MaxOpWindow | undefined = typeof window === 'undefined' ? undefined : (window as MaxOpWindow),
): Promise<MaxOpResult> {
  const m = marshalKeys(dataset);
  if (m.keyType !== 'number') throw new Error('the worst-single-operation view needs numeric keys');
  if (sizes.length === 0) throw new Error('no sizes to profile');
  onStatus('counting the most expensive single operations…');
  const raw = await engine.runMaxOpProfile(m.values, [...sizes], MAX_OP_STRUCTURES);
  const result: MaxOpResult = {
    clockFree: true,
    workload: MAX_OP_WORKLOAD,
    sizes: [...sizes],
    structures: MAX_OP_STRUCTURES,
    rows: raw.map(shapeMaxOp),
  };
  if (win) win.__maxOpProof = toMaxOpProof(result);
  return result;
}

/** CSV columns; every row carries {@link MAX_OP_SIGNAL} so a pasted row still says what it is. */
export const MAX_OP_CSV_HEADER =
  'structure,n,stored_n,height,signal,' +
  'insert_max_ops,insert_max_ops_at,insert_mean_ops,insert_max_rotations,insert_max_recolours,' +
  'insert_max_keys_replaced,insert_max_keys_replaced_at,resizes,' +
  'delete_max_ops,delete_max_ops_at,delete_mean_ops,delete_max_rotations,delete_max_recolours,deletes,delete_misses';

const cell = (x: number | null) => (x === null ? '' : String(x));

export function maxOpCsv(r: MaxOpResult): string {
  const lines = [MAX_OP_CSV_HEADER];
  for (const x of r.rows) {
    lines.push(
      [
        x.structure,
        x.n,
        x.stored,
        cell(x.height),
        `"${MAX_OP_SIGNAL}"`,
        x.insert.maxOps,
        cell(x.insert.maxOpsAt),
        x.insert.meanOps,
        cell(x.insert.maxRotations),
        cell(x.insert.maxRecolours),
        cell(x.insert.maxMoved),
        cell(x.insert.maxMovedAt),
        cell(x.insert.resizes),
        x.delete.maxOps,
        cell(x.delete.maxOpsAt),
        x.delete.meanOps,
        cell(x.delete.maxRotations),
        cell(x.delete.maxRecolours),
        x.delete.count,
        x.delete.misses,
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

export function maxOpJson(r: MaxOpResult, meta: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      ...meta,
      exportedAt: new Date().toISOString(),
      clockFree: r.clockFree,
      signal: MAX_OP_SIGNAL,
      workload: r.workload,
      findings: maxOpFindings(r),
      sizes: r.sizes,
      rows: r.rows,
    },
    null,
    2,
  );
}
