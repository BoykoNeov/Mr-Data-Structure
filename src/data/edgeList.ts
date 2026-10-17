import { parseCsv } from './csv';
import type { GraphData } from './graphs';

/**
 * Edge-list import for the graph (docs/PLAN.md §4.3, §10 Phase 6; docs/METHODOLOGY.md §2.7):
 * a CSV / paste of `u,v` pairs, one undirected edge per line — a user's **own** graph, so
 * measured as their data rather than as a synthetic stand-in.
 *
 * Two rules here are correctness, not convenience, and each is a PLAN §10 trap:
 *
 * - **Labels map to dense ids in first-seen order** (trap 2). Both twins traverse from
 *   vertex 0. Keeping a file's raw ids would let 0 be an id the file never mentions — an
 *   isolated vertex — and the "traversal" would cost one vertex-visit at every sweep point:
 *   a flat O(1) line charted from a graph that is nothing of the sort. Numbering labels as
 *   they are first seen makes vertex 0 the first endpoint of the first edge, always real.
 *   First-seen order is also **prefix-stable**: the first `m` edges use exactly the ids
 *   `0..k−1` for some `k`, so a swept prefix is itself a dense graph (see {@link edgePrefix}).
 * - **Labels are strings, never `Number()`** (trap 3, the `02134` gotcha). `02134` and
 *   `2134` are two different vertices, as are `1` and `1.0`; a label is compared as the text
 *   it is. Only surrounding whitespace is trimmed.
 *
 * And the project's standing rule: **nothing is deduplicated**. A repeated line is a parallel
 * edge and `a,a` is a self-loop; both are kept, as the multigraph twins keep them.
 */

/** How fields on a line are separated. Never guessed — the caller (the UI) says. */
export type EdgeListDelimiter = 'comma' | 'tab' | 'whitespace';

export interface EdgeListOptions {
  /** Field separator. Default `'comma'`. `'whitespace'` splits on any run of spaces/tabs. */
  readonly delimiter?: EdgeListDelimiter;
  /** Skip the first data line as a header. Default `false` — explicit, never guessed. */
  readonly header?: boolean;
  /**
   * Skip lines whose first field starts with this prefix (`#` is the SNAP / networks
   * convention). Default `'#'`; `null` keeps every line, for a graph with a vertex whose
   * label really starts with `#`.
   */
  readonly commentPrefix?: string | null;
}

/** A parsed edge list: the dense-id graph, the id → label map, and what was dropped and why. */
export interface EdgeList {
  /** Flat `[u0, v0, …]` dense ids, in file order. */
  readonly edges: Uint32Array;
  /** `labels[id]` is vertex `id`'s label as written in the file — first-seen order. */
  readonly labels: readonly string[];
  /** Lines with fewer than two non-empty labels (not counting blanks and comments). */
  readonly skippedLines: number;
  /** Lines that carried a third non-empty field (a weight, say) — ignored, counted. */
  readonly extraColumnLines: number;
  /** Edges whose two endpoints are the same label — kept. */
  readonly selfLoops: number;
}

/** Number of edges in a parsed list. */
export function edgeListSize(list: EdgeList): number {
  return list.edges.length >> 1;
}

/** Raw records (arrays of fields) for the chosen delimiter, BOM stripped. */
function recordsOf(text: string, delimiter: EdgeListDelimiter): string[][] {
  if (delimiter === 'whitespace') {
    const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return src.split(/\r\n|\n|\r/).map((line) => {
      const t = line.trim();
      return t === '' ? [] : t.split(/\s+/);
    });
  }
  // CSV / TSV: reuse the data layer's RFC-4180-ish parser (quoting, CRLF, BOM). Header
  // handling is done below so comment lines can precede it.
  return parseCsv(text, { header: false, delimiter: delimiter === 'tab' ? '\t' : ',' }).rows;
}

/**
 * Parse an edge list into a dense-id multigraph (see the module doc for the two rules that
 * matter). Each non-blank, non-comment line contributes one edge from its first two fields.
 */
export function parseEdgeList(text: string, options: EdgeListOptions = {}): EdgeList {
  const { delimiter = 'comma', header = false, commentPrefix = '#' } = options;
  const ids = new Map<string, number>();
  const labels: string[] = [];
  const idOf = (label: string): number => {
    let id = ids.get(label);
    if (id === undefined) {
      id = labels.length;
      ids.set(label, id);
      labels.push(label);
    }
    return id;
  };

  const out: number[] = [];
  let skippedLines = 0;
  let extraColumnLines = 0;
  let selfLoops = 0;
  let headerPending = header;

  for (const record of recordsOf(text, delimiter)) {
    const fields = record.map((f) => f.trim());
    if (fields.every((f) => f === '')) continue; // blank line
    if (commentPrefix !== null && commentPrefix !== '' && fields[0].startsWith(commentPrefix)) continue;
    if (headerPending) {
      headerPending = false;
      continue;
    }
    const [u, v] = fields;
    if (u === undefined || v === undefined || u === '' || v === '') {
      skippedLines += 1;
      continue;
    }
    if (fields.slice(2).some((f) => f !== '')) extraColumnLines += 1;
    if (u === v) selfLoops += 1;
    out.push(idOf(u), idOf(v));
  }

  return { edges: Uint32Array.from(out), labels, skippedLines, extraColumnLines, selfLoops };
}

/**
 * The graph made of the **first `m` edges** of `list` — one point of the edge-prefix sweep
 * (the imported graph's V-sweep: both `V` and `E` grow as more of the file is taken).
 *
 * Because ids were assigned in first-seen order, the prefix uses exactly the ids `0..k−1`,
 * where `k − 1` is the largest id in it — so `numVertices = k` with no relabelling, and
 * vertex 0 is still the first endpoint of the first edge. A prefix can be **disconnected**
 * (the file's first edges need not touch each other), which is why the chart's x-axis is the
 * reached component's `V' + 2E'`, not this graph's nominal size (PLAN §10 trap 4).
 *
 * The edges are **copied** (`slice`, not `subarray`): each engine call transfers its buffers,
 * and two views of one buffer in one transfer list is a `DataCloneError`.
 */
export function edgePrefix(list: EdgeList, m: number): GraphData {
  const total = edgeListSize(list);
  const take = Math.max(0, Math.min(total, Math.floor(m)));
  const edges = list.edges.slice(0, 2 * take);
  let maxId = -1;
  for (let i = 0; i < edges.length; i++) if (edges[i] > maxId) maxId = edges[i];
  return {
    edges,
    numVertices: maxId + 1,
    origin: { kind: 'edge-list', edges: take, totalEdges: total },
  };
}
