import type { SkipListEvent, SkipOutcome } from './events';
import type { SkipModel } from './model';

/**
 * Skip-list renderer (docs/PLAN.md §5, "Specialized" — the Phase 6 structure). The
 * list is drawn as a grid: nodes left→right in ascending order, each a **tower** of
 * stacked cells whose height is the number of express lanes it occupies. The head
 * sentinel is the tallest tower on the left; level 0 (the plain sorted linked list)
 * is the bottom lane and the express lanes rise above it.
 *
 * **The express lanes are the whole point, so they are drawn as the real skips they
 * are.** A horizontal link on lane `i` jumps from one occupant straight to the next,
 * over every shorter tower in between — that visible skipping is why a search is
 * O(log n). Level 0 alone is a sorted linked list, so a list whose upper lanes were
 * mis-linked would still answer every query correctly while being O(n); the lanes
 * here are derived from the folded heights + order ({@link skipLevelKeys}), the same
 * shape the conformance corpus pins (docs/PLAN.md §12).
 *
 * The active event drives the highlight, and a walk has **two** things to show: where
 * it *stands* (the node it dropped a level at — a blue outline) and the node it is
 * *comparing* (a fill: amber to move right, blue-grey to drop a level, green on a
 * hit, red on a miss). A hit compares the level-0 node twice — the descent's `< key?`
 * then the membership `= key?` — and both are shown; that second comparison is a real
 * node-visit, not a bookkeeping artefact (see `events.ts`). Insert tints the new tower
 * green; the delete target red; a removed node is simply gone.
 */

const PAD = 16;
const HEAD_W = 34;
const NODE_W = 34;
const HGAP = 22; // horizontal gap between towers (the express-lane skip shows here)
const CELL_H = 24; // one lane's height
const LEGEND_H = 24;
/** Outline of the node the walk currently stands on (where it drops a level). */
const STAND_STROKE = '#4a90d9';

const TONE = {
  advance: { fill: '#fff3cd', stroke: '#e0a800' }, // move right along this lane
  drop: { fill: '#d1ecf1', stroke: '#17a2b8' }, // too big → drop a level
  hit: { fill: '#d4edda', stroke: '#28a745' }, // found / newly inserted
  miss: { fill: '#f8d7da', stroke: '#dc3545' }, // not found / delete target
} as const;

type Tone = keyof typeof TONE;

/** What the active event highlights: a compared cell (fill), the node the walk stands
 * on (blue outline), and/or a whole tower (insert/delete). Columns are level-0 indices;
 * `-1` is the head sentinel. */
interface Highlight {
  readonly compare?: { readonly col: number; readonly level: number; readonly tone: Tone };
  readonly stand?: { readonly col: number; readonly level: number };
  readonly tower?: { readonly col: number; readonly tone: Tone };
}

const OUTCOME_TONE: Record<SkipOutcome, Tone> = {
  advance: 'advance',
  stop: 'drop',
  found: 'hit',
  notFound: 'miss',
};

function highlight(active: SkipListEvent | undefined): Highlight {
  if (!active) return {};
  switch (active.kind) {
    case 'skip.enter':
      // Stand at the head on the top lane (nothing to stand on for an empty list).
      return active.topLevel < 0 ? {} : { stand: { col: -1, level: active.topLevel } };
    case 'skip.inspect':
      return {
        compare: { col: active.index, level: active.level, tone: OUTCOME_TONE[active.outcome] },
        stand: { col: active.at, level: active.level },
      };
    case 'skip.laneEnd':
      // The lane ran out from where the walk stands — it drops without comparing.
      return { stand: { col: active.at, level: active.level } };
    case 'skip.insert':
      return { tower: { col: active.index, tone: 'hit' } };
    case 'skip.removeTarget':
      return { tower: { col: active.index, tone: 'miss' } };
    default:
      return {}; // skip.remove (the node is gone), skip.result
  }
}

interface SkipListViewProps {
  readonly model: SkipModel;
  readonly active: SkipListEvent | undefined;
}

export function SkipListView({ model, active }: SkipListViewProps) {
  const { nodes } = model;
  const top = nodes.reduce((mx, n) => Math.max(mx, n.height), 0);
  const drawTop = Math.max(top, 1); // an empty list still draws a one-lane head
  const hl = highlight(active);

  const colX = (col: number): number => (col < 0 ? PAD : PAD + HEAD_W + HGAP + col * (NODE_W + HGAP));
  const cellW = (col: number): number => (col < 0 ? HEAD_W : NODE_W);
  const laneY = (level: number): number => PAD + (drawTop - 1 - level) * CELL_H;

  const lastRight = nodes.length > 0 ? colX(nodes.length - 1) + NODE_W : PAD + HEAD_W;
  const width = lastRight + PAD;
  const height = PAD + drawTop * CELL_H + LEGEND_H;

  // Express-lane links: on lane i, connect each occupant to the next (the head plus
  // every tower of height > i), so the line skips straight over the shorter towers.
  // The occupants per lane are exactly what {@link skipLevelKeys} lists — here by
  // index, since duplicate values need distinct columns.
  const links: { key: string; x1: number; x2: number; y: number }[] = [];
  for (let i = 0; i < top; i++) {
    const cols: number[] = [-1]; // the head is on every lane
    nodes.forEach((n, k) => {
      if (n.height > i) cols.push(k);
    });
    const y = laneY(i) + CELL_H / 2;
    for (let j = 0; j < cols.length - 1; j++) {
      links.push({ key: `lane-${i}-${j}`, x1: colX(cols[j]) + cellW(cols[j]), x2: colX(cols[j + 1]), y });
    }
  }

  const cellFill = (col: number, level: number): string => {
    if (hl.compare && hl.compare.col === col && hl.compare.level === level) return TONE[hl.compare.tone].fill;
    if (hl.tower && hl.tower.col === col) return TONE[hl.tower.tone].fill;
    return col < 0 ? '#f0f0f0' : '#fff';
  };
  const cellStroke = (col: number, level: number): string => {
    if (hl.stand && hl.stand.col === col && hl.stand.level === level) return STAND_STROKE;
    if (hl.compare && hl.compare.col === col && hl.compare.level === level) return TONE[hl.compare.tone].stroke;
    if (hl.tower && hl.tower.col === col) return TONE[hl.tower.tone].stroke;
    return col < 0 ? '#aaa' : '#ccc';
  };
  const cellStrokeW = (col: number, level: number): number =>
    hl.stand && hl.stand.col === col && hl.stand.level === level ? 3 : 1.5;

  // A tower is drawn in its own group translated to the column's x, so when an insert
  // or delete shifts its neighbours it slides sideways (the <g> transform transitions)
  // rather than jumping. Cells are laid out at local x = 0.
  const tower = (col: number, ht: number, label: string, keyBase: string) => {
    const w = cellW(col);
    const cells = [];
    for (let i = 0; i < ht; i++) {
      const y = laneY(i);
      cells.push(
        <g key={`${keyBase}-${i}`}>
          <rect
            x={0}
            y={y + 1}
            width={w}
            height={CELL_H - 2}
            rx={3}
            fill={cellFill(col, i)}
            stroke={cellStroke(col, i)}
            strokeWidth={cellStrokeW(col, i)}
          />
          {i === 0 && (
            <text
              x={w / 2}
              y={y + CELL_H / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={12}
              fontFamily="ui-monospace, monospace"
              fill={col < 0 ? '#888' : '#222'}
            >
              {label}
            </text>
          )}
        </g>,
      );
    }
    return (
      <g key={keyBase} transform={`translate(${colX(col)}, 0)`} style={{ transition: 'transform 200ms ease' }}>
        {cells}
      </g>
    );
  };

  return (
    <svg
      width={Math.max(width, 520)} // wide enough that the in-SVG legend never clips, even on an empty list
      height={Math.max(height, 90)}
      role="img"
      aria-label="skip list: express lanes over a sorted base list"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {/* express-lane links first, so the tower cells sit on top */}
      {links.map((l) => (
        <line key={l.key} x1={l.x1} y1={l.y} x2={l.x2} y2={l.y} stroke="#bbb" strokeWidth={1.5} style={{ transition: 'all 200ms ease' }} />
      ))}

      {/* head sentinel — as tall as the list, on every lane */}
      {tower(-1, drawTop, 'H', 'head')}

      {nodes.map((n, k) => tower(k, n.height, String(n.value), `n${n.id}`))}

      {nodes.length === 0 && (
        <text x={PAD + HEAD_W + 12} y={laneY(0) + CELL_H / 2} dominantBaseline="central" fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}

      {/* The legend rides inside the SVG so a screenshot still explains itself: the
          bottom lane is a plain sorted list; the taller a tower, the more it skips. */}
      <text
        x={PAD}
        y={height - LEGEND_H + 14}
        dominantBaseline="central"
        fontSize={11}
        fill="#777"
        fontFamily="system-ui"
      >
        level 0 is a sorted linked list; taller towers are express lanes that skip ahead (O(log n))
      </text>
    </svg>
  );
}
