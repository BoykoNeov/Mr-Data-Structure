import type { TrieEvent } from './events';
import { trieNodeAtPath, type TrieModel, type TrieDisplayNode } from './model';

/**
 * Trie renderer (docs/PLAN.md §5, "trees" — the Phase 6 structure). An n-ary tree
 * laid out with `y = depth` and `x` from a tidy pass: leaves take successive slots
 * and every internal node centres over its children, so siblings never overlap and
 * the drawing reads left→right in the trie's own lexicographic byte order.
 *
 * **One node per UTF-8 byte, not per character.** That is the trie's actual
 * mechanism (both twins walk `key.as_bytes()`, docs/PLAN.md §4.2), and drawing it
 * any other way would animate a structure the benchmark does not measure: a key
 * like `café` occupies *five* levels, and the two bytes of `é` are drawn as two
 * nodes labelled `C3` / `A9`. Every byte outside printable ASCII is labelled by its
 * hex value for exactly this reason — it is a fact about the structure, not a
 * rendering defect.
 *
 * A **terminal** node (a stored key ends here) is outlined in accent blue and
 * carries a second ring; a legend in the corner says so, because that mark is the
 * trie's most important teaching detail and a screenshot travels without the prose
 * beside it. Reaching a node is not finding a key: a *proper prefix* of a stored key
 * walks the full depth and still reports absent. The active event drives the
 * highlight — the node just stepped onto
 * (amber), the parent whose child lookup missed (red — the walk stops there), a
 * freshly created node or a newly marked terminal (green), a cleared terminal
 * (red). `trie.prune` tints nothing: the node is already gone.
 */

const NODE_R = 15;
const STRIDE = 40; // horizontal gap between adjacent leaf slots
const LEVEL = 54; // vertical gap between depths
const PAD = 16;
const LEGEND_H = 26; // room under the tree for the terminal-ring legend
/** The default outline of a node where a stored key ends — a colour difference on
 * top of the second ring, so the mark survives a small screenshot. */
const TERMINAL_STROKE = '#4a90d9';

const TONE = {
  step: { fill: '#fff3cd', stroke: '#e0a800' },
  hit: { fill: '#d4edda', stroke: '#28a745' },
  miss: { fill: '#f8d7da', stroke: '#dc3545' },
} as const;

type Tone = keyof typeof TONE;

/**
 * The label for a byte on an edge into a node: the character itself when it is
 * printable ASCII, else its hex value. A multi-byte character therefore shows up as
 * its bytes (`C3`, `A9` for `é`) — see the header; this is the honest rendering of
 * what the structure walks. Exported for the render test.
 */
export function byteLabel(b: number): string {
  return b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : b.toString(16).toUpperCase().padStart(2, '0');
}

/** Which node the active event highlights, and how — resolved by byte path against
 * the current folded model (an unresolvable path ⇒ no highlight, defensively). */
function highlight(active: TrieEvent | undefined, model: TrieModel): { id: number; tone: Tone } | null {
  if (!active) return null;
  const at = (path: readonly number[], tone: Tone) => {
    const n = trieNodeAtPath(model, path);
    return n ? { id: n.id, tone } : null;
  };
  switch (active.kind) {
    case 'trie.enterRoot':
      return { id: model.root.id, tone: 'step' };
    case 'trie.step':
      // A hit lands on the child; a miss stops at the node we were leaving.
      return active.hit ? at([...active.path, active.byte], 'step') : at(active.path, 'miss');
    case 'trie.create':
    case 'trie.markTerminal':
      return at(active.path, 'hit');
    case 'trie.clearTerminal':
      return at(active.path, 'miss');
    default:
      return null; // trie.prune (the node is gone), trie.result
  }
}

interface Laid {
  readonly node: TrieDisplayNode;
  readonly cx: number;
  readonly cy: number;
}

interface TrieViewProps {
  readonly model: TrieModel;
  readonly active: TrieEvent | undefined;
}

export function TrieView({ model, active }: TrieViewProps) {
  // Tidy pass: a leaf takes the next slot; an internal node centres over the span
  // of its children. Post-order, so children are placed before their parent.
  const laid: Laid[] = [];
  const pos = new Map<number, { cx: number; cy: number }>();
  let slot = 0;
  let maxDepth = 0;
  const place = (node: TrieDisplayNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    const cy = PAD + NODE_R + depth * LEVEL;
    let cx: number;
    if (node.children.length === 0) {
      cx = PAD + NODE_R + slot * STRIDE;
      slot += 1;
    } else {
      const xs = node.children.map((c) => place(c, depth + 1));
      cx = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos.set(node.id, { cx, cy });
    laid.push({ node, cx, cy });
    return cx;
  };
  place(model.root, 0);

  // A narrow trie is still at least as wide as the legend line (see the `svg` below).
  const width = PAD * 2 + NODE_R * 2 + Math.max(0, slot - 1) * STRIDE;
  const height = PAD * 2 + NODE_R * 2 + maxDepth * LEVEL + LEGEND_H;
  const hl = highlight(active, model);

  // Edges carry no label of their own — the child node already shows the byte.
  const edges: { key: number; x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const { node, cx, cy } of laid) {
    for (const child of node.children) {
      const p = pos.get(child.id)!;
      edges.push({ key: child.id, x1: cx, y1: cy, x2: p.cx, y2: p.cy });
    }
  }

  return (
    <svg
      width={Math.max(width, 320)}
      height={Math.max(height, 90)}
      role="img"
      aria-label="trie nodes, one per UTF-8 byte"
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
        const tone =
          hl && hl.id === node.id
            ? TONE[hl.tone]
            : { fill: '#fff', stroke: node.terminal ? TERMINAL_STROKE : '#bbb' };
        const isRoot = node.byte === null;
        return (
          <g key={node.id} transform={`translate(${p.cx}, ${p.cy})`} style={{ transition: 'transform 200ms ease' }}>
            <circle r={NODE_R} fill={tone.fill} stroke={tone.stroke} strokeWidth={2} />
            {/* a second ring marks "a stored key ends here" — reaching a node is
                not finding a key (a proper prefix walks full depth and misses) */}
            {node.terminal && <circle r={NODE_R - 4} fill="none" stroke={tone.stroke} strokeWidth={2} />}
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={isRoot ? 9 : 12}
              fontFamily="ui-monospace, monospace"
              fill={isRoot ? '#888' : '#222'}
            >
              {isRoot ? 'root' : byteLabel(node.byte!)}
            </text>
          </g>
        );
      })}

      {model.root.children.length === 0 && !model.root.terminal && (
        <text
          x={PAD + NODE_R * 2 + 10}
          y={PAD + NODE_R}
          dominantBaseline="central"
          fontSize={13}
          fill="#999"
          fontFamily="system-ui"
        >
          (empty)
        </text>
      )}

      {/* The legend rides inside the SVG, not beside it: the double ring is the
          difference between "the walk reached this node" and "a key ends here",
          and a picture pasted elsewhere must still say which is which. */}
      <g transform={`translate(${PAD + 9}, ${Math.max(height, 90) - LEGEND_H + 8})`}>
        <circle r={8} fill="#fff" stroke={TERMINAL_STROKE} strokeWidth={2} />
        <circle r={4.5} fill="none" stroke={TERMINAL_STROKE} strokeWidth={1.5} />
        <text x={15} dominantBaseline="central" fontSize={11} fill="#777" fontFamily="system-ui">
          a stored key ends here (one node per UTF-8 byte)
        </text>
      </g>
    </svg>
  );
}
