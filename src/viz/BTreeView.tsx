import type { BTreeEvent } from './events';
import type { BTreeModel, BTreeDisplayNode } from './model';

/**
 * B-tree renderer (docs/PLAN.md §5, §8; docs/METHODOLOGY.md §2.10). Each node is a row
 * of key cells; leaves are laid out left to right and every internal node is centred
 * over its children, so all leaves sit on one line — the B-tree's own invariant, visible.
 * An edge leaves its parent from the gap between the two keys that bound the child.
 *
 * The active event drives the highlight: a probe shades the live binary-search window
 * inside one node and marks the key it compares; a descend lights the edge taken; the
 * structural events (split, borrow, merge, the root growing or collapsing) ring the nodes
 * they rewrite. The footer carries what the op-count cannot see — **nodes visited**, the
 * B-tree's real saving over a binary tree — and the candidate the search is carrying down
 * to its single deferred equality test.
 */

const KEY_W = 30;
const NODE_H = 26;
const NODE_PAD = 4;
const GAP = 14;
const LEVEL = 70;
const PAD = 14;
const FOOT_H = 22;

const TONE = {
  window: '#f3f0e0',
  probe: '#fff3cd',
  match: '#d4edda',
  remove: '#f8d7da',
  edge: '#4a90d9',
  ring: '#7b4bc4',
} as const;

interface Laid {
  readonly node: BTreeDisplayNode;
  readonly path: readonly number[];
  readonly x: number; // left edge
  readonly y: number; // top
  readonly w: number;
}

const nodeWidth = (n: BTreeDisplayNode) => Math.max(1, n.keys.length) * KEY_W + NODE_PAD * 2;
const samePath = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Lay the tree out: leaves left to right, parents centred over their children. */
function layout(root: BTreeDisplayNode | null): { laid: Laid[]; width: number; depth: number } {
  const laid: Laid[] = [];
  let cursor = PAD;
  let depth = 0;
  const place = (n: BTreeDisplayNode, path: readonly number[], d: number): { x: number; w: number } => {
    depth = Math.max(depth, d);
    const w = nodeWidth(n);
    let x: number;
    if (n.kids === null || n.kids.length === 0) {
      x = cursor;
      cursor += w + GAP;
    } else {
      const spans = n.kids.map((k, i) => place(k, [...path, i], d + 1));
      const first = spans[0];
      const last = spans[spans.length - 1];
      const mid = (first.x + last.x + last.w) / 2;
      x = Math.max(PAD, mid - w / 2);
      cursor = Math.max(cursor, x + w + GAP);
    }
    laid.push({ node: n, path, x, y: PAD + d * LEVEL, w });
    return { x, w };
  };
  if (root !== null) place(root, [], 0);
  return { laid, width: cursor - GAP + PAD, depth };
}

/** Paths of the nodes a structural event rewrites (ringed), resolved after the fold. */
function ringed(active: BTreeEvent | undefined): (readonly number[])[] {
  if (!active) return [];
  switch (active.kind) {
    case 'btree.growRoot':
    case 'btree.collapseRoot':
      return [[]];
    case 'btree.split':
      return [active.path, [...active.path, active.index], [...active.path, active.index + 1]];
    case 'btree.borrow':
      return [active.path, [...active.path, active.child], [...active.path, active.from === 'left' ? active.child - 1 : active.child + 1]];
    case 'btree.merge':
      return [active.path, [...active.path, active.index]];
    case 'btree.replaceWithPred':
      return [active.path, active.leafPath];
    case 'btree.removeKey':
    case 'btree.insertKey':
    case 'btree.medianCompare':
      return [active.path];
    default:
      return [];
  }
}

/** The tint of key cell `i` of the node at `path`. */
function cellFill(active: BTreeEvent | undefined, path: readonly number[], i: number): string {
  if (!active) return '#fff';
  switch (active.kind) {
    case 'btree.probe':
      if (!samePath(active.path, path)) return '#fff';
      if (i === active.mid) return TONE.probe;
      return i >= active.lo && i < active.hi ? TONE.window : '#fff';
    case 'btree.descend':
      return samePath(active.path, path) && active.fresh && i === active.index ? TONE.match : '#fff';
    case 'btree.insertKey':
    case 'btree.replaceWithPred':
      return samePath(active.path, path) && i === active.index ? TONE.match : '#fff';
    case 'btree.medianCompare':
      return samePath(active.path, path) && i === active.index ? TONE.probe : '#fff';
    default:
      return '#fff';
  }
}

/** The footer: nodes visited and the remembered candidate — the hop count stays visible. */
function footer(active: BTreeEvent | undefined): string {
  if (!active) return '';
  switch (active.kind) {
    case 'btree.probe':
      return `comparing inside node ${active.path.length + 1} of the walk · window [${active.lo}, ${active.hi})`;
    case 'btree.descend':
      return active.candidate === null
        ? `nodes visited: ${active.path.length + 1}`
        : `nodes visited: ${active.path.length + 1} · remembered candidate: ${active.candidate}`;
    case 'btree.check':
      return `one equality test: remembered ${active.candidate} vs ${active.target}`;
    case 'btree.result':
      return `nodes visited: ${active.nodeVisits} — the hops a binary tree would pay more of; not part of the op-count`;
    default:
      return '';
  }
}

interface BTreeViewProps {
  readonly model: BTreeModel;
  readonly active: BTreeEvent | undefined;
}

export function BTreeView({ model, active }: BTreeViewProps) {
  const { laid, width, depth } = layout(model.root);
  const height = PAD * 2 + depth * LEVEL + NODE_H + FOOT_H;
  const rings = ringed(active);
  const byPath = new Map(laid.map((l) => [l.path.join('.'), l] as const));
  const lit =
    active?.kind === 'btree.descend' && !active.leaf ? `${[...active.path, active.index].join('.')}` : null;

  const edges: { key: string; x1: number; y1: number; x2: number; y2: number; on: boolean }[] = [];
  for (const l of laid) {
    if (l.node.kids === null) continue;
    l.node.kids.forEach((_, i) => {
      const c = byPath.get([...l.path, i].join('.'));
      if (!c) return;
      edges.push({
        key: `${l.node.id}-${c.node.id}`,
        x1: l.x + NODE_PAD + i * KEY_W,
        y1: l.y + NODE_H,
        x2: c.x + c.w / 2,
        y2: c.y,
        on: lit === c.path.join('.'),
      });
    });
  }

  return (
    <svg
      width={Math.max(width, 320)}
      height={Math.max(height, 90)}
      role="img"
      aria-label="B-tree nodes"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {edges.map((e) => (
        <line
          key={e.key}
          x1={e.x1}
          y1={e.y1}
          x2={e.x2}
          y2={e.y2}
          stroke={e.on ? TONE.edge : '#bbb'}
          strokeWidth={e.on ? 3 : 1.5}
          style={{ transition: 'all 200ms ease' }}
        />
      ))}
      {laid.map((l) => {
        const ring = rings.some((p) => samePath(p, l.path));
        const removing = active?.kind === 'btree.removeKey' && samePath(active.path, l.path);
        return (
          <g key={l.node.id} transform={`translate(${l.x}, ${l.y})`} style={{ transition: 'transform 200ms ease' }}>
            <rect
              width={l.w}
              height={NODE_H}
              rx={5}
              fill={removing ? TONE.remove : '#fff'}
              stroke={ring ? TONE.ring : '#999'}
              strokeWidth={ring ? 3 : 1.5}
            />
            {l.node.keys.length === 0 && (
              <text x={l.w / 2} y={NODE_H / 2} textAnchor="middle" dominantBaseline="central" fontSize={10} fill="#999" fontFamily="system-ui">
                (no keys)
              </text>
            )}
            {l.node.keys.map((k, i) => (
              <g key={i} transform={`translate(${NODE_PAD + i * KEY_W}, 0)`}>
                <rect x={1} y={3} width={KEY_W - 2} height={NODE_H - 6} rx={3} fill={cellFill(active, l.path, i)} stroke="none" />
                {i > 0 && <line x1={0} y1={4} x2={0} y2={NODE_H - 4} stroke="#ddd" />}
                <text x={KEY_W / 2} y={NODE_H / 2} textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="system-ui, sans-serif" fill="#222">
                  {k}
                </text>
              </g>
            ))}
          </g>
        );
      })}
      {laid.length === 0 && (
        <text x={PAD} y={PAD + NODE_H / 2} dominantBaseline="central" fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}
      <text x={PAD} y={Math.max(height, 90) - PAD / 2} fontSize={11} fontFamily="system-ui, sans-serif" fill="#666">
        {footer(active)}
      </text>
    </svg>
  );
}
