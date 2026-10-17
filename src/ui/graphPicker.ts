import { edgeListSize, parseEdgeList, type EdgeList, type EdgeListDelimiter } from '../data/edgeList';
import {
  EDGE_LIST_MIN_EDGES,
  GRAPH_DEFAULT_DEGREE,
  GRAPH_DEFAULT_SEED,
  type GraphSourceChoice,
} from '../compare/runGraphSweeps';

/**
 * The graph section's own data picker (docs/PLAN.md §4.3; docs/METHODOLOGY.md §2.7) — the
 * pure core, unit-testable without a DOM, as `DatasetPicker`'s `buildDataset` is. The graph
 * does **not** read the shared key dataset: a list of keys carries no edges, and inventing
 * some (key *i* → key *i+1*) would present a made-up structure as measured. So it has a
 * picker of its own: a synthetic family for the V-sweep, or the user's own edge list.
 */

export type GraphFamily = 'random' | 'path' | 'grid' | 'edge-list';

export interface GraphPickerState {
  readonly family: GraphFamily;
  /** Average degree for the random family's V-sweep. */
  readonly degree: number;
  readonly seed: number;
  /** Pasted (or loaded) edge-list text, for `family = 'edge-list'`. */
  readonly text: string;
  readonly delimiter: EdgeListDelimiter;
  readonly header: boolean;
  /** Skip `#` comment lines. */
  readonly comments: boolean;
}

/**
 * Highest average degree the V-sweep accepts. At the top of the ladder (50k vertices) a degree
 * of 64 is already 1.6 million edges, and the graph is built twice — once for the bench twin,
 * once for the TS twin that computes the reached component — so the cap keeps a run in seconds
 * and in memory. It matches the degree-sweep's own top rung.
 */
export const MAX_PICKER_DEGREE = 64;

export const DEFAULT_GRAPH_PICKER: GraphPickerState = {
  family: 'random',
  degree: GRAPH_DEFAULT_DEGREE,
  seed: GRAPH_DEFAULT_SEED,
  text: '',
  delimiter: 'comma',
  header: false,
  comments: true,
};

export const GRAPH_FAMILIES: ReadonlyArray<{ family: GraphFamily; label: string; hint: string }> = [
  {
    family: 'random',
    label: 'random connected graph',
    hint: 'a random tree plus random extra edges, at the average degree you choose',
  },
  { family: 'path', label: 'path', hint: 'one long chain — the input that would overflow a recursive DFS' },
  { family: 'grid', label: 'grid', hint: 'a square lattice — every vertex has up to four neighbours' },
  { family: 'edge-list', label: 'my own edge list', hint: 'paste or load u,v pairs — one edge per line' },
];

/** The parsed edge list for a picker state, or null when the family is synthetic. */
export function parsePickerEdgeList(state: GraphPickerState): EdgeList | null {
  if (state.family !== 'edge-list') return null;
  return parseEdgeList(state.text, {
    delimiter: state.delimiter,
    header: state.header,
    commentPrefix: state.comments ? '#' : null,
  });
}

/**
 * One-line summary of a parsed list, shown before the user runs it so they can see what the
 * tool understood: how many edges and vertices, which label is vertex 0, and anything dropped.
 */
export function describeEdgeList(list: EdgeList): string {
  const parts = [
    `${edgeListSize(list).toLocaleString()} edges between ${list.labels.length.toLocaleString()} vertices`,
  ];
  if (list.labels.length > 0) parts.push(`traversals start at “${list.labels[0]}” (the first label in the file)`);
  if (list.selfLoops > 0) parts.push(`${list.selfLoops} self-loop${list.selfLoops === 1 ? '' : 's'} kept`);
  if (list.skippedLines > 0) parts.push(`${list.skippedLines} line${list.skippedLines === 1 ? '' : 's'} without two labels skipped`);
  if (list.extraColumnLines > 0) parts.push(`extra columns ignored on ${list.extraColumnLines} line${list.extraColumnLines === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * Picker state → the V-sweep's source. Throws with a plain message when the state cannot
 * be measured (an edge list too small to sweep, a nonsense degree).
 */
export function buildGraphSource(state: GraphPickerState): GraphSourceChoice {
  switch (state.family) {
    case 'random':
      if (!Number.isFinite(state.degree) || state.degree < 0 || state.degree > MAX_PICKER_DEGREE) {
        throw new Error(`average degree must be between 0 and ${MAX_PICKER_DEGREE}`);
      }
      return { kind: 'random', degree: state.degree, seed: Math.trunc(state.seed) };
    case 'path':
      return { kind: 'path' };
    case 'grid':
      return { kind: 'grid' };
    case 'edge-list': {
      const list = parsePickerEdgeList(state);
      if (!list || edgeListSize(list) < EDGE_LIST_MIN_EDGES) {
        throw new Error(
          `paste at least ${EDGE_LIST_MIN_EDGES} edges (got ${list ? edgeListSize(list) : 0}) — one “u,v” pair per line`,
        );
      }
      return { kind: 'edge-list', list };
    }
  }
}
