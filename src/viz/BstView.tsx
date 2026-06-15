import type { BstEvent } from './events';
import { bstNodeAtPath, type BstModel, type BstDisplayNode } from './model';

/**
 * Binary-search-tree renderer (docs/PLAN.md §5, "trees"). Each node is laid out at
 * `x = in-order rank` (so siblings never overlap and the drawing reads left→right
 * in sorted order) and `y = depth`; its stable id lets it transition smoothly to a
 * new (x, y) as an insert/delete shifts the in-order ranks. Edges are drawn from
 * the folded model so they move with the nodes.
 *
 * The active event drives the highlight (only the active node is tinted, matching
 * the other views): a compared node (amber, green on a match), the successor
 * candidate during a two-child delete's descend (amber), the freshly inserted or
 * value-replaced node (green), or the delete target (red). `bst.remove` / result
 * tint nothing — the node is already gone / the op is done.
 */

const NODE_R = 18;
const STRIDE = 46; // horizontal gap between adjacent in-order ranks
const LEVEL = 62; // vertical gap between depths
const PAD = 16;

const TONE = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  remove: { fill: '#f8d7da', stroke: '#dc3545' },
} as const;

type Tone = keyof typeof TONE;

/** Which node the active event highlights, and how — resolved by path against the
 * current folded model (`undefined` path target ⇒ no highlight, defensively). */
function highlight(active: BstEvent | undefined, model: BstModel): { id: number; tone: Tone } | null {
  if (!active) return null;
  const at = (path: readonly ('L' | 'R')[], tone: Tone) => {
    const n = bstNodeAtPath(model, path);
    return n ? { id: n.id, tone } : null;
  };
  switch (active.kind) {
    case 'bst.compare':
      return at(active.path, active.dir === 'match' ? 'match' : 'compare');
    case 'bst.descend':
      return at(active.path, 'compare');
    case 'bst.removeTarget':
      return at(active.path, 'remove');
    case 'bst.insert':
    case 'bst.replaceValue':
      return at(active.path, 'match');
    default:
      return null; // bst.remove, bst.result
  }
}

interface Laid {
  readonly node: BstDisplayNode;
  readonly cx: number;
  readonly cy: number;
}

interface BstViewProps {
  readonly model: BstModel;
  readonly active: BstEvent | undefined;
}

export function BstView({ model, active }: BstViewProps) {
  // In-order pass: x from the running rank, y from depth. `pos` lets the edge pass
  // look up each child's centre once positions are known.
  const laid: Laid[] = [];
  const pos = new Map<number, { cx: number; cy: number }>();
  let order = 0;
  let maxDepth = 0;
  const place = (node: BstDisplayNode | null, depth: number): void => {
    if (node === null) return;
    place(node.left, depth + 1);
    const cx = PAD + NODE_R + order * STRIDE;
    const cy = PAD + NODE_R + depth * LEVEL;
    order += 1;
    maxDepth = Math.max(maxDepth, depth);
    pos.set(node.id, { cx, cy });
    laid.push({ node, cx, cy });
    place(node.right, depth + 1);
  };
  place(model.root, 0);

  const count = laid.length;
  const width = PAD * 2 + NODE_R * 2 + Math.max(0, count - 1) * STRIDE;
  const height = PAD * 2 + NODE_R * 2 + maxDepth * LEVEL;
  const hl = highlight(active, model);

  const edges: { key: number; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const { node, cx, cy } of laid) {
    for (const child of [node.left, node.right]) {
      if (child) {
        const p = pos.get(child.id)!;
        edges.push({ key: child.id, x1: cx, y1: cy, x2: p.cx, y2: p.cy });
      }
    }
  }

  return (
    <svg
      width={Math.max(width, 160)}
      height={Math.max(height, 80)}
      role="img"
      aria-label="binary search tree nodes"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {/* edges first, so the node circles sit on top */}
      {edges.map((e) => (
        <line
          key={`edge-${e.key}`}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke="#bbb"
          strokeWidth={1.5}
          style={{ transition: 'all 200ms ease' }}
        />
      ))}

      {laid.map(({ node }) => {
        const p = pos.get(node.id)!;
        const tone = hl && hl.id === node.id ? TONE[hl.tone] : { fill: '#fff', stroke: '#bbb' };
        return (
          <g key={node.id} transform={`translate(${p.cx}, ${p.cy})`} style={{ transition: 'transform 200ms ease' }}>
            <circle r={NODE_R} fill={tone.fill} stroke={tone.stroke} strokeWidth={2} />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontFamily="system-ui, sans-serif"
              fill="#222"
            >
              {node.value}
            </text>
          </g>
        );
      })}

      {count === 0 && (
        <text x={PAD} y={PAD + NODE_R} dominantBaseline="central" fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}
    </svg>
  );
}
