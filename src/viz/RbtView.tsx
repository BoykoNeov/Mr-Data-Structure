import type { RbtEvent, BstStep } from './events';
import { rbtNodeAtPath, rbtRedRedIds, type RbtModel, type RbtDisplayNode } from './model';

/**
 * Red-black-tree renderer (docs/PLAN.md §5, §8; docs/METHODOLOGY.md §2.9). The AVL's
 * layout — `x = in-order rank`, `y = depth`, edges from the folded model so they move
 * with the nodes — with one rule that decides the rest: **a node's fill is its colour**.
 * So every op highlight is a **ring** around the node, never a fill, or a node would
 * lose its colour on exactly the frame it is compared or repainted.
 *
 *  - The active op's node (compared, inserted, value-copied, rotation pivot, delete
 *    target) gets a solid ring; a recolour gets a ring in the colour it is painted.
 *  - A **fix-up case** rings the node being repaired and, dashed, the node whose colour
 *    decided the case (the uncle on insert, the sibling on delete). When the node being
 *    repaired is an empty child — the delete's "double black" NIL — a small NIL box is
 *    drawn where that child would hang, because no drawn node sits there.
 *  - A **red node under a red parent** — the insert's violation — is flagged from the
 *    drawn shape alone (as the AVL view derives imbalance), so stepping through an insert
 *    shows the new red leaf break the rule and the fix-up clear it.
 */

const NODE_R = 18;
const RING_R = NODE_R + 5;
const STRIDE = 46;
const LEVEL = 64;
const PAD = 16;

const RED = '#c9302c';
const BLACK = '#2b2b2b';

const RING = {
  compare: '#e0a800',
  match: '#28a745',
  remove: '#dc3545',
  pivot: '#7b4bc4',
  repair: '#7b4bc4',
  decider: '#4a90d9',
  violation: '#fd7e14',
} as const;

type RingTone = keyof typeof RING;

interface Ring {
  readonly id: number;
  readonly tone: RingTone | 'paintRed' | 'paintBlack';
  readonly dashed: boolean;
}

/** The rings the active event draws, resolved by path against the folded model. */
function rings(active: RbtEvent | undefined, model: RbtModel): Ring[] {
  if (!active) return [];
  const at = (path: readonly BstStep[] | null, tone: Ring['tone'], dashed = false): Ring[] => {
    if (path === null) return [];
    const n = rbtNodeAtPath(model, path);
    return n ? [{ id: n.id, tone, dashed }] : [];
  };
  switch (active.kind) {
    case 'rbt.compare':
      return at(active.path, active.dir === 'match' ? 'match' : 'compare');
    case 'rbt.descend':
      return at(active.path, 'compare');
    case 'rbt.removeTarget':
      return at(active.path, 'remove');
    case 'rbt.insert':
    case 'rbt.replaceValue':
      return at(active.path, 'match');
    case 'rbt.rotate':
      return at(active.path, 'pivot');
    case 'rbt.recolour':
      return at(active.path, active.red ? 'paintRed' : 'paintBlack');
    case 'rbt.fixCase':
      return [...at(active.nil ? null : active.at, 'repair'), ...at(active.other, 'decider', true)];
    default:
      return []; // rbt.remove, rbt.result
  }
}

const ringStroke = (tone: Ring['tone']) => (tone === 'paintRed' ? RED : tone === 'paintBlack' ? BLACK : RING[tone]);

interface Laid {
  readonly node: RbtDisplayNode;
  readonly cx: number;
  readonly cy: number;
}

interface RbtViewProps {
  readonly model: RbtModel;
  readonly active: RbtEvent | undefined;
}

export function RbtView({ model, active }: RbtViewProps) {
  const laid: Laid[] = [];
  const pos = new Map<number, { cx: number; cy: number }>();
  let order = 0;
  let maxDepth = 0;
  const place = (node: RbtDisplayNode | null, depth: number): void => {
    if (node === null) return;
    place(node.left, depth + 1);
    const cx = PAD + RING_R + order * STRIDE;
    const cy = PAD + RING_R + depth * LEVEL;
    order += 1;
    maxDepth = Math.max(maxDepth, depth);
    pos.set(node.id, { cx, cy });
    laid.push({ node, cx, cy });
    place(node.right, depth + 1);
  };
  place(model.root, 0);

  const count = laid.length;
  const width = PAD * 2 + RING_R * 2 + Math.max(0, count - 1) * STRIDE;
  // one extra level of room below the deepest node, for a NIL box
  const height = PAD * 2 + RING_R * 2 + (maxDepth + 1) * LEVEL;
  const ringList = rings(active, model);
  const redRed = rbtRedRedIds(model);

  // The delete's NIL "double black": drawn under its parent, on its side.
  let nilBox: { x: number; y: number } | null = null;
  if (active?.kind === 'rbt.fixCase' && active.nil && active.at.length > 0) {
    const parent = rbtNodeAtPath(model, active.at.slice(0, -1));
    const p = parent ? pos.get(parent.id) : undefined;
    if (p) nilBox = { x: p.cx + (active.at[active.at.length - 1] === 'L' ? -STRIDE / 2 : STRIDE / 2), y: p.cy + LEVEL * 0.7 };
  }

  const edges: { key: number; x1: number; y1: number; x2: number; y2: number; bad: boolean }[] = [];
  for (const { node, cx, cy } of laid) {
    for (const child of [node.left, node.right]) {
      if (child) {
        const p = pos.get(child.id)!;
        edges.push({ key: child.id, x1: cx, y1: cy, x2: p.cx, y2: p.cy, bad: redRed.has(child.id) });
      }
    }
  }

  return (
    <svg
      width={Math.max(width, 160)}
      height={Math.max(height, 90)}
      role="img"
      aria-label="red-black tree nodes"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {edges.map((e) => (
        <line
          key={`edge-${e.key}`}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke={e.bad ? RING.violation : '#bbb'}
          strokeWidth={e.bad ? 3 : 1.5}
          style={{ transition: 'all 200ms ease' }}
        />
      ))}

      {nilBox && (
        <g>
          <rect x={nilBox.x - 14} y={nilBox.y - 9} width={28} height={18} rx={3} fill={BLACK} stroke={RING.repair} strokeWidth={3} />
          <text x={nilBox.x} y={nilBox.y} textAnchor="middle" dominantBaseline="central" fontSize={9} fontFamily="monospace" fill="#fff">
            NIL
          </text>
        </g>
      )}

      {laid.map(({ node }) => {
        const p = pos.get(node.id)!;
        const mine = ringList.filter((r) => r.id === node.id);
        const violation = redRed.has(node.id);
        return (
          <g key={node.id} transform={`translate(${p.cx}, ${p.cy})`} style={{ transition: 'transform 200ms ease' }}>
            {violation && mine.length === 0 && (
              <circle r={RING_R} fill="none" stroke={RING.violation} strokeWidth={2} strokeDasharray="3 2" />
            )}
            {mine.map((r, i) => (
              <circle
                key={i}
                r={RING_R + i * 4}
                fill="none"
                stroke={ringStroke(r.tone)}
                strokeWidth={3}
                strokeDasharray={r.dashed ? '5 3' : undefined}
              />
            ))}
            <circle r={NODE_R} fill={node.red ? RED : BLACK} stroke="#fff" strokeWidth={1.5} style={{ transition: 'fill 200ms ease' }} />
            <text textAnchor="middle" dominantBaseline="central" fontSize={13} fontFamily="system-ui, sans-serif" fill="#fff">
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
