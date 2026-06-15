import type { LinkedListEvent } from './events';
import type { LinkedListModel } from './model';

/**
 * Linked-list renderer (docs/PLAN.md §5, "lists as node+pointer chains"). Nodes
 * are drawn head→tail; each keeps a stable id so a head insert slides the rest
 * right and an unlink slides the survivors together (CSS transform transition).
 * `next` arrows point forward to the successor (and to a `∅` terminator at the
 * tail); when `doubly` is set, `prev` arrows point back — the only visual
 * difference between the singly and doubly lists, which share one algorithm.
 *
 * The active event drives the highlight: the visited node (amber, green on a
 * match) or the freshly inserted head (green). An unlink needs no highlight — the
 * node is already gone and the survivors slide together.
 */

const NODE_W = 50;
const NODE_H = 40;
const GAP = 34; // room for the arrow between nodes
const PAD = 12;
const HEAD_W = 40; // "head →" label column
const STRIDE = NODE_W + GAP;

const TONE = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
} as const;

type Tone = keyof typeof TONE | 'none';

/** Which node (if any) the active event highlights, and how. */
function nodeTone(active: LinkedListEvent | undefined, i: number): Tone {
  if (!active) return 'none';
  switch (active.kind) {
    case 'll.visit':
      return active.index === i ? (active.matched ? 'match' : 'compare') : 'none';
    case 'll.insertHead':
      return i === 0 ? 'match' : 'none'; // freshly inserted node is the new head
    default:
      return 'none';
  }
}

interface LinkedListViewProps {
  readonly model: LinkedListModel;
  readonly active: LinkedListEvent | undefined;
  /** Draw backward (`prev`) pointers — the doubly-linked list. */
  readonly doubly: boolean;
}

export function LinkedListView({ model, active, doubly }: LinkedListViewProps) {
  const { nodes } = model;
  const nodeX = (i: number) => PAD + HEAD_W + i * STRIDE;
  const width = PAD * 2 + HEAD_W + Math.max(1, nodes.length) * STRIDE + 24; // tail ∅
  const height = PAD * 2 + NODE_H + (doubly ? 14 : 0);
  const midY = PAD + NODE_H / 2;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={doubly ? 'doubly linked list nodes' : 'singly linked list nodes'}
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      <defs>
        <marker id="ll-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#888" />
        </marker>
      </defs>

      <text x={PAD} y={midY} dominantBaseline="central" fontSize={12} fontFamily="monospace" fill="#888">
        head
      </text>

      {/* pointer arrows: drawn from the model so they animate with the nodes */}
      {nodes.map((node, i) => {
        const fromRight = nodeX(i) + NODE_W;
        const toNext = i + 1 < nodes.length ? nodeX(i + 1) : nodeX(i) + NODE_W + 24;
        return (
          <g key={`edge-${node.id}`} style={{ transition: 'all 200ms ease' }}>
            {/* next pointer (forward) */}
            <line
              x1={fromRight}
              y1={doubly ? midY - 6 : midY}
              x2={toNext - 4}
              y2={doubly ? midY - 6 : midY}
              stroke="#888"
              strokeWidth={1.5}
              markerEnd="url(#ll-arrow)"
            />
            {/* prev pointer (backward) — doubly only, skipped for the head */}
            {doubly && i > 0 && (
              <line
                x1={nodeX(i)}
                y1={midY + 6}
                x2={nodeX(i - 1) + NODE_W + 4}
                y2={midY + 6}
                stroke="#bbb"
                strokeWidth={1.5}
                markerEnd="url(#ll-arrow)"
              />
            )}
          </g>
        );
      })}

      {/* null terminator after the tail */}
      <text
        x={nodes.length > 0 ? nodeX(nodes.length - 1) + NODE_W + 16 : PAD + HEAD_W + 8}
        y={midY}
        dominantBaseline="central"
        fontSize={15}
        fontFamily="monospace"
        fill="#aaa"
      >
        ∅
      </text>

      {nodes.map((node, i) => {
        const tone = nodeTone(active, i);
        const style = tone === 'none' ? { fill: '#fff', stroke: '#bbb' } : TONE[tone];
        return (
          <g
            key={node.id}
            transform={`translate(${nodeX(i)}, ${PAD})`}
            style={{ transition: 'transform 200ms ease' }}
          >
            <rect width={NODE_W} height={NODE_H} rx={6} fill={style.fill} stroke={style.stroke} strokeWidth={2} />
            <text
              x={NODE_W / 2}
              y={NODE_H / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={14}
              fontFamily="system-ui, sans-serif"
              fill="#222"
            >
              {node.value}
            </text>
          </g>
        );
      })}

      {nodes.length === 0 && (
        <text x={PAD + HEAD_W} y={midY} dominantBaseline="central" fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}
    </svg>
  );
}
