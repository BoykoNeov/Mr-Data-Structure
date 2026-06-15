import type { HeapEvent } from './events';
import { isHole, type HeapModel } from './model';

/**
 * Binary min-heap renderer (docs/PLAN.md §5, "heap as array *and* tree view"). The
 * single backing array is drawn twice: as a row of indexed cells, and as the
 * implicit complete tree it encodes (the children of position `i` are `2i+1` /
 * `2i+2`). Each cell keeps a stable id, so a sift swap or the extract-min refill
 * animates the *same* chip moving in both pictures at once.
 *
 * The active event tints the positions it touches — the two cells being compared
 * (the smaller one green), a scanned cell, a swapped pair (blue), the root being
 * extracted (red), the value moved up to refill it (green), or a peeked root — and
 * the highlight is shared across the array and the tree so the eye connects them.
 */

const CELL_W = 40;
const CELL_H = 34;
const GAP = 6;
const PAD = 14;
const A_STRIDE = CELL_W + GAP;

const NODE_R = 16;
const T_LEVEL = 54; // vertical gap between tree depths
const SLOT = 44; // horizontal slot per bottom-level node

const TONE = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  swap: { fill: '#cfe2ff', stroke: '#4a90d9' },
  remove: { fill: '#f8d7da', stroke: '#dc3545' },
} as const;

type Tone = keyof typeof TONE;

/** Map each touched position to its tone for the active event (shared by both
 * views). Highlight-only events still resolve here; structural ones reflect the
 * already-folded model (a swap shows the cells in their new slots). */
function highlights(active: HeapEvent | undefined, count: number): Map<number, Tone> {
  const m = new Map<number, Tone>();
  if (!active) return m;
  switch (active.kind) {
    case 'heap.append':
      if (count > 0) m.set(count - 1, 'match');
      break;
    case 'heap.compare':
      m.set(active.a, active.winner === active.a ? 'match' : 'compare');
      m.set(active.b, active.winner === active.b ? 'match' : 'compare');
      break;
    case 'heap.scan':
      m.set(active.index, active.matched ? 'match' : 'compare');
      break;
    case 'heap.swap':
      m.set(active.i, 'swap');
      m.set(active.j, 'swap');
      break;
    case 'heap.extractRoot':
      m.set(0, 'remove');
      break;
    case 'heap.replaceRoot':
      if (count > 0) m.set(0, 'match');
      break;
    case 'heap.peek':
      m.set(0, 'swap');
      break;
    default:
      break; // heap.result — nothing
  }
  return m;
}

const styleFor = (tone: Tone | undefined) => (tone ? TONE[tone] : { fill: '#fff', stroke: '#bbb' });

interface HeapViewProps {
  readonly model: HeapModel;
  readonly active: HeapEvent | undefined;
}

export function HeapView({ model, active }: HeapViewProps) {
  const { cells } = model;
  const count = cells.length;
  const hl = highlights(active, count);

  // Tree geometry: a node's depth is ⌊log₂(i+1)⌋; the bottom level sets the width.
  const maxDepth = count > 0 ? Math.floor(Math.log2(count)) : 0;
  const bottomCount = 2 ** maxDepth;
  const treeWidth = bottomCount * SLOT;
  const arrayWidth = PAD * 2 + Math.max(1, count) * A_STRIDE - GAP;
  const width = Math.max(arrayWidth, treeWidth + PAD * 2, 200);

  const arrayTop = PAD + 12; // leave a line for the "array" label
  const treeTop = arrayTop + CELL_H + 26; // index labels + "tree" label
  const treeHeight = (maxDepth + 1) * T_LEVEL;
  const height = treeTop + treeHeight + PAD;

  const nodePos = (i: number) => {
    const depth = Math.floor(Math.log2(i + 1));
    const levelStart = 2 ** depth - 1;
    const j = i - levelStart;
    const levelCount = 2 ** depth;
    const cx = PAD + ((j + 0.5) / levelCount) * treeWidth;
    const cy = treeTop + NODE_R + depth * T_LEVEL;
    return { cx, cy };
  };

  // Tree edges parent → child, keyed by the child's stable id so they move with it.
  const edges: { key: number; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let i = 0; i < count; i++) {
    const p = nodePos(i);
    for (const c of [2 * i + 1, 2 * i + 2]) {
      if (c < count) {
        const cp = nodePos(c);
        edges.push({ key: cells[c].id, x1: p.cx, y1: p.cy, x2: cp.cx, y2: cp.cy });
      }
    }
  }

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="binary min-heap (array and tree)"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      <text x={PAD} y={PAD + 2} fontSize={11} fontFamily="monospace" fill="#999">
        array
      </text>

      {/* ── Array view ── */}
      {cells.map((cell, i) => {
        const tone = styleFor(hl.get(i));
        const v = isHole(cell) ? '' : cell.value;
        return (
          <g
            key={`arr-${cell.id}`}
            transform={`translate(${PAD + i * A_STRIDE}, ${arrayTop})`}
            style={{ transition: 'transform 200ms ease' }}
          >
            <rect width={CELL_W} height={CELL_H} rx={5} fill={tone.fill} stroke={tone.stroke} strokeWidth={2} />
            <text x={CELL_W / 2} y={CELL_H / 2} textAnchor="middle" dominantBaseline="central" fontSize={13} fontFamily="system-ui, sans-serif" fill="#222">
              {v}
            </text>
            <text x={CELL_W / 2} y={CELL_H + 12} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#aaa">
              {i}
            </text>
          </g>
        );
      })}

      {count > 0 && (
        <text x={PAD} y={treeTop - 8} fontSize={11} fontFamily="monospace" fill="#999">
          tree (i → 2i+1, 2i+2)
        </text>
      )}

      {/* ── Tree view ── edges under the nodes */}
      {edges.map((e) => (
        <line key={`edge-${e.key}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#bbb" strokeWidth={1.5} style={{ transition: 'all 200ms ease' }} />
      ))}
      {cells.map((cell, i) => {
        const { cx, cy } = nodePos(i);
        const tone = styleFor(hl.get(i));
        const v = isHole(cell) ? '' : cell.value;
        return (
          <g key={`node-${cell.id}`} transform={`translate(${cx}, ${cy})`} style={{ transition: 'transform 200ms ease' }}>
            <circle r={NODE_R} fill={tone.fill} stroke={tone.stroke} strokeWidth={2} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="system-ui, sans-serif" fill="#222">
              {v}
            </text>
          </g>
        );
      })}

      {count === 0 && (
        <text x={PAD} y={arrayTop + CELL_H / 2} fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}
    </svg>
  );
}
