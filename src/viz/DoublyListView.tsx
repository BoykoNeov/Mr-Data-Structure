import type { DoublyListEvent } from './events';
import { doublyReachable, type DoublyListModel } from './model';

/**
 * Doubly-linked-list renderer (docs/PLAN.md §5). Unlike the singly view, which derives
 * its arrows from display order, this one draws **the links the model holds**: `next`
 * arrows along the upper line, `prev` arrows along the lower one, the `head` handle at
 * the left and the `tail` handle at the right. A link between neighbours is a short
 * straight arrow; any other link — the bypass a delete writes around the node it is
 * removing — arcs over (next) or under (prev) the nodes it skips. A `null` link is a
 * small ∅ beside its node.
 *
 * Highlights: the visited node (amber, green on a match), the freshly created head
 * (green), and the link the active `dll.relink` just wrote (blue). A drawn node no
 * longer reachable from `head` — a new node nothing points at yet, or a removed node
 * both neighbours already skip — is drawn dashed and faded: it is not in the list.
 */

const NODE_W = 50;
const NODE_H = 40;
const GAP = 34;
const ARC = 30; // vertical room above and below the nodes for bypass arcs
const PAD = 12;
const HEAD_W = 58; // "head" label + room for its arrow
const TAIL_W = 48;
const STRIDE = NODE_W + GAP;
const TOP = PAD + ARC;

const TONE = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
} as const;
const LINK = '#888';
const BACK = '#aaa';
const WRITE = '#1f6fd1';

type Tone = keyof typeof TONE | 'none';

function nodeTone(active: DoublyListEvent | undefined, i: number): Tone {
  if (!active) return 'none';
  switch (active.kind) {
    case 'll.visit':
      return active.index === i ? (active.matched ? 'match' : 'compare') : 'none';
    case 'll.insertHead':
      return i === 0 ? 'match' : 'none';
    default:
      return 'none';
  }
}

/** Whether the active event is the write of this link (`from` null = a handle). */
function isWrite(active: DoublyListEvent | undefined, link: 'next' | 'prev', from: number | null): boolean {
  return active?.kind === 'dll.relink' && active.link === link && active.from === from;
}

interface DoublyListViewProps {
  readonly model: DoublyListModel;
  readonly active: DoublyListEvent | undefined;
}

export function DoublyListView({ model, active }: DoublyListViewProps) {
  const { nodes } = model;
  const pos = new Map(nodes.map((n, p) => [n.id, p] as const));
  const inList = doublyReachable(model);
  const nodeX = (i: number) => PAD + HEAD_W + i * STRIDE;
  const tailX = nodeX(Math.max(1, nodes.length)) - GAP + 24; // the tail label's left edge
  const width = tailX + TAIL_W + PAD;
  const height = TOP + NODE_H + ARC + PAD;
  const upY = TOP + NODE_H / 2 - 7;
  const lowY = TOP + NODE_H / 2 + 7;

  const stroke = (written: boolean, base: string) =>
    written ? { stroke: WRITE, strokeWidth: 2.5, markerEnd: 'url(#dll-arrow-w)' } : { stroke: base, strokeWidth: 1.5, markerEnd: 'url(#dll-arrow)' };

  /** A `next` arrow from x (on the upper line) to node j: straight when j is the next
   * slot to the right, otherwise an arc over the nodes in between. */
  const nextPath = (x1: number, adjacentTo: number | null, j: number) => {
    const x2 = nodeX(j);
    if (adjacentTo === j) return `M${x1},${upY} L${x2 - 4},${upY}`;
    return `M${x1 - 8},${TOP} Q${(x1 - 8 + x2 + NODE_W / 2) / 2},${TOP - 2 * ARC} ${x2 + NODE_W / 2},${TOP - 3}`;
  };
  /** A `prev` arrow from x (on the lower line) back to node j: straight when j is the
   * slot just to the left, otherwise an arc under the nodes in between. */
  const prevPath = (x1: number, adjacentTo: number | null, j: number) => {
    const x2 = nodeX(j) + NODE_W;
    if (adjacentTo === j) return `M${x1},${lowY} L${x2 + 4},${lowY}`;
    const bottom = TOP + NODE_H;
    return `M${x1 + 8},${bottom} Q${(x1 + x2 - NODE_W / 2) / 2},${bottom + 2 * ARC} ${x2 - NODE_W / 2},${bottom + 3}`;
  };
  const nil = (x: number, y: number, key: string) => (
    <text key={key} x={x} y={y} dominantBaseline="central" textAnchor="middle" fontSize={12} fontFamily="monospace" fill="#aaa">
      ∅
    </text>
  );

  const arrows: React.ReactNode[] = [];
  nodes.forEach((n, i) => {
    const x = nodeX(i);
    if (n.next === null) arrows.push(nil(x + NODE_W + 9, upY, `nn-${n.id}`));
    else {
      const j = pos.get(n.next);
      if (j !== undefined) arrows.push(<path key={`n-${n.id}`} d={nextPath(x + NODE_W, i + 1, j)} fill="none" {...stroke(isWrite(active, 'next', i), LINK)} />);
    }
    if (n.prev === null) arrows.push(nil(x - 9, lowY, `pn-${n.id}`));
    else {
      const j = pos.get(n.prev);
      if (j !== undefined) arrows.push(<path key={`p-${n.id}`} d={prevPath(x, i - 1, j)} fill="none" {...stroke(isWrite(active, 'prev', i), BACK)} />);
    }
  });
  // the head handle points forward (a `next` from before the list), the tail handle back
  const headAt = model.head === null ? undefined : pos.get(model.head);
  if (headAt !== undefined) arrows.push(<path key="h" d={nextPath(PAD + 34, 0, headAt)} fill="none" {...stroke(isWrite(active, 'next', null), LINK)} />);
  const tailAt = model.tail === null ? undefined : pos.get(model.tail);
  if (tailAt !== undefined) arrows.push(<path key="t" d={prevPath(tailX - 4, nodes.length - 1, tailAt)} fill="none" {...stroke(isWrite(active, 'prev', null), BACK)} />);

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="doubly linked list nodes"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      <defs>
        {/* user-space markers: a written (thicker) link keeps the same arrowhead size */}
        <marker id="dll-arrow" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={LINK} />
        </marker>
        <marker id="dll-arrow-w" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill={WRITE} />
        </marker>
      </defs>

      <text x={PAD} y={upY} dominantBaseline="central" fontSize={12} fontFamily="monospace" fill={isWrite(active, 'next', null) ? WRITE : '#888'}>
        head{model.head === null ? ' ∅' : ''}
      </text>
      <text x={tailX} y={lowY} dominantBaseline="central" fontSize={12} fontFamily="monospace" fill={isWrite(active, 'prev', null) ? WRITE : '#888'}>
        {model.tail === null ? '∅ ' : ''}tail
      </text>

      {arrows}

      {nodes.map((node, i) => {
        const tone = nodeTone(active, i);
        const style = tone === 'none' ? { fill: '#fff', stroke: '#bbb' } : TONE[tone];
        const out = !inList.has(node.id);
        return (
          <g
            key={node.id}
            transform={`translate(${nodeX(i)}, ${TOP})`}
            opacity={out ? 0.55 : 1}
            style={{ transition: 'transform 200ms ease' }}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={6}
              fill={style.fill}
              stroke={style.stroke}
              strokeWidth={2}
              strokeDasharray={out ? '5 3' : undefined}
            />
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
        <text x={PAD + HEAD_W + 8} y={TOP + NODE_H / 2} dominantBaseline="central" fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}
    </svg>
  );
}
