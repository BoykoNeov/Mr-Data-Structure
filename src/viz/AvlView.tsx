import type { AvlEvent } from './events';
import { avlNodeAtPath, type AvlModel, type AvlDisplayNode } from './model';

/**
 * AVL-tree renderer (docs/PLAN.md §5, "trees with rotation animations"). It reuses
 * the BST layout — `x = in-order rank`, `y = depth`, edges drawn from the folded
 * model so they move with the nodes — and adds the two things that make balancing
 * legible:
 *
 *  - **Balance factors, derived from the drawn shape.** Each node shows
 *    `height(right) − height(left)`, computed straight from the folded display tree
 *    (height is a pure function of shape, so no extra model state). Stepping through
 *    an insert, you watch the new leaf push an ancestor's factor to ±2…
 *  - **…then a rotation fix it.** A node whose |factor| ≥ 2 is tinted as
 *    *imbalanced* (the frame right before its `avl.rotate`); after the rotation it
 *    settles back into {-1, 0, +1}. The node ids are stable across the rotation, so
 *    each node slides to its new place rather than snapping.
 *
 * The active event drives the per-node op highlight (compared node amber / green on
 * a match; inserted or value-replaced node green; delete target red; rotation pivot
 * amber), which takes precedence over the imbalance tint.
 */

const NODE_R = 18;
const STRIDE = 46; // horizontal gap between adjacent in-order ranks
const LEVEL = 64; // vertical gap between depths (a touch taller for the BF labels)
const PAD = 16;

const TONE = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  remove: { fill: '#f8d7da', stroke: '#dc3545' },
  imbalance: { fill: '#ffe5d0', stroke: '#fd7e14' },
} as const;

type Tone = keyof typeof TONE;

/** Which node the active event highlights, and how — resolved by path against the
 * current folded model (`undefined` path target ⇒ no highlight, defensively). */
function highlight(active: AvlEvent | undefined, model: AvlModel): { id: number; tone: Tone } | null {
  if (!active) return null;
  const at = (path: readonly ('L' | 'R')[], tone: Tone) => {
    const n = avlNodeAtPath(model, path);
    return n ? { id: n.id, tone } : null;
  };
  switch (active.kind) {
    case 'avl.compare':
      return at(active.path, active.dir === 'match' ? 'match' : 'compare');
    case 'avl.descend':
    case 'avl.rotate':
      return at(active.path, 'compare');
    case 'avl.removeTarget':
      return at(active.path, 'remove');
    case 'avl.insert':
    case 'avl.replaceValue':
      return at(active.path, 'match');
    default:
      return null; // avl.remove, avl.result
  }
}

interface Laid {
  readonly node: AvlDisplayNode;
  readonly cx: number;
  readonly cy: number;
  readonly bf: number;
}

interface AvlViewProps {
  readonly model: AvlModel;
  readonly active: AvlEvent | undefined;
}

const heightOf = (n: AvlDisplayNode | null): number =>
  n === null ? 0 : 1 + Math.max(heightOf(n.left), heightOf(n.right));

export function AvlView({ model, active }: AvlViewProps) {
  // In-order pass: x from the running rank, y from depth; `bf` derived from the
  // subtree shape. `pos` lets the edge pass look up each child's centre.
  const laid: Laid[] = [];
  const pos = new Map<number, { cx: number; cy: number }>();
  let order = 0;
  let maxDepth = 0;
  const place = (node: AvlDisplayNode | null, depth: number): void => {
    if (node === null) return;
    place(node.left, depth + 1);
    const cx = PAD + NODE_R + order * STRIDE;
    const cy = PAD + NODE_R + depth * LEVEL;
    order += 1;
    maxDepth = Math.max(maxDepth, depth);
    pos.set(node.id, { cx, cy });
    laid.push({ node, cx, cy, bf: heightOf(node.right) - heightOf(node.left) });
    place(node.right, depth + 1);
  };
  place(model.root, 0);

  const count = laid.length;
  const width = PAD * 2 + NODE_R * 2 + Math.max(0, count - 1) * STRIDE;
  const height = PAD * 2 + NODE_R * 2 + maxDepth * LEVEL + 14; // room for BF labels
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
      height={Math.max(height, 90)}
      role="img"
      aria-label="AVL tree nodes"
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

      {laid.map(({ node, bf }) => {
        const p = pos.get(node.id)!;
        const imbalanced = Math.abs(bf) >= 2;
        const tone =
          hl && hl.id === node.id
            ? TONE[hl.tone]
            : imbalanced
              ? TONE.imbalance
              : { fill: '#fff', stroke: '#bbb' };
        const bfLabel = bf > 0 ? `+${bf}` : `${bf}`;
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
            {/* balance factor, just to the upper-right; bold + orange when imbalanced */}
            <text
              x={NODE_R + 2}
              y={-NODE_R + 2}
              fontSize={10}
              fontFamily="monospace"
              fill={imbalanced ? '#fd7e14' : '#aaa'}
              fontWeight={imbalanced ? 700 : 400}
            >
              {bfLabel}
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
