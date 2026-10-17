import type { GraphEvent } from './events';
import { otherEnd, type GraphModel, type GraphVertexState } from './model';

/**
 * Graph renderer (docs/PLAN.md §5, "Specialized" — the Phase 6 structure). Three
 * panels in one SVG, because the graph's cost is only countable with all three in
 * view:
 *
 *  - **the drawing** — vertices and edges at a fixed, deterministic layout (the
 *    seed's hand-placed coordinates when given, else a circle; no layout library).
 *    A **parallel** edge is drawn as its own arc, and a **self-loop** as a loop on its
 *    vertex, because each is real cost: every copy is two adjacency entries, and a
 *    self-loop's two entries both sit in its own vertex's list (Σ deg = 2E). The edge
 *    copy being examined is lit, with an arrowhead pointing away from the vertex whose
 *    list is being read; the edges that discovered a vertex (the BFS / DFS tree) are
 *    drawn bold.
 *  - **the adjacency lists** — one row per vertex, one cell per entry. An edge-visit
 *    is *one cell*, so a whole traversal of a connected graph ticks every cell once:
 *    that grid *is* the `2E`.
 *  - **the frontier and the tally** — the queue (BFS, out at the front) or stack (DFS,
 *    out at the top), the visit order so far, and a running count of vertex-visits +
 *    edge-visits, which is exactly the cost events folded so far.
 *
 * Vertex fill is its traversal state: white = not yet seen, amber = **marked** (on
 * the frontier, not yet visited), green = visited; the vertex being processed has a
 * blue ring. In DFS a vertex turns amber when it is **pushed**, long before it is
 * popped — the mark-on-push rule both twins run, and the reason an edge to an amber
 * vertex is skipped even though that vertex has not been visited yet. Once the
 * traversal ends, a vertex it never reached is drawn dashed: it cost nothing.
 */

const GW = 460; // drawing panel width
const GH = 270; // drawing panel height
const R = 15; // vertex radius
const PAR_GAP = 26; // perpendicular spacing between parallel-edge copies
const LIST_X = GW + 16;
const ROW_H = 22;
const CELL = 20;
const STRIP_H = 30;

const TONE = {
  discover: '#28a745', // examine that discovers a new vertex
  seen: '#17a2b8', // examine of an entry whose vertex is already marked / visited
  tree: '#4a90d9',
} as const;

const VERTEX: Record<GraphVertexState, { fill: string; stroke: string }> = {
  unseen: { fill: '#fff', stroke: '#999' },
  marked: { fill: '#fff3cd', stroke: '#e0a800' },
  visited: { fill: '#d4edda', stroke: '#28a745' },
};

type Pt = readonly [number, number];

/** Deterministic positions: the caller's layout when it covers every vertex, else
 * evenly round a circle starting at the left (so vertex 0, the default source, sits
 * where a reader starts). */
export function graphLayout(n: number, given?: readonly Pt[]): Pt[] {
  if (given && given.length === n) return given.slice();
  const cx = GW / 2;
  const cy = GH / 2;
  const rad = Math.min(GW, GH) / 2 - R - 20;
  return Array.from({ length: n }, (_, i): Pt => {
    const a = Math.PI + (2 * Math.PI * i) / Math.max(n, 1);
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  });
}

/** For every edge, its index among the copies joining the same unordered pair and how
 * many copies there are — what spreads parallel edges into distinct arcs and nests a
 * vertex's self-loops. */
function copyIndex(m: GraphModel): { readonly j: number; readonly of: number }[] {
  const groups = new Map<string, number[]>();
  m.edges.forEach(([u, v], k) => {
    const key = `${Math.min(u, v)}-${Math.max(u, v)}`;
    const g = groups.get(key);
    if (g) g.push(k);
    else groups.set(key, [k]);
  });
  const out: { j: number; of: number }[] = m.edges.map(() => ({ j: 0, of: 1 }));
  for (const ks of groups.values()) ks.forEach((k, j) => (out[k] = { j, of: ks.length }));
  return out;
}

/** The SVG path for edge `k`, drawn starting at endpoint `from` (so an arrowhead at the
 * path's end points away from the list being read). */
function edgePath(m: GraphModel, pos: readonly Pt[], copies: readonly { j: number; of: number }[], k: number, from: number): string {
  const to = otherEnd(m, k, from);
  const [x1, y1] = pos[from];
  const { j, of } = copies[k];
  if (to === from) {
    // A self-loop: a teardrop pointing away from the drawing's centre, one size up
    // per extra loop so nested loops stay distinguishable.
    const atCentre = x1 === GW / 2 && y1 === GH / 2;
    const ang = atCentre ? -Math.PI / 2 : Math.atan2(y1 - GH / 2, x1 - GW / 2);
    const reach = R + 26 + j * 12;
    const spread = 0.55;
    const p = (a: number, d: number): Pt => [x1 + d * Math.cos(a), y1 + d * Math.sin(a)];
    const [sx, sy] = p(ang - spread, R);
    const [ex, ey] = p(ang + spread, R);
    const [c1x, c1y] = p(ang - spread * 1.2, reach + 8);
    const [c2x, c2y] = p(ang + spread * 1.2, reach + 8);
    return `M ${sx} ${sy} C ${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`;
  }
  const [x2, y2] = pos[to];
  // Offset measured in a frame fixed by the pair's lower id, so a copy bends the same
  // way whichever endpoint the path starts from.
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const dx = pos[hi][0] - pos[lo][0];
  const dy = pos[hi][1] - pos[lo][1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const off = (j - (of - 1) / 2) * PAR_GAP;
  // Trim to the circles so an arrowhead lands on the rim, not under the vertex.
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const sx = x1 + ux * R;
  const sy = y1 + uy * R;
  const ex = x2 - ux * (R + 2);
  const ey = y2 - uy * (R + 2);
  if (off === 0) return `M ${sx} ${sy} L ${ex} ${ey}`;
  const cx = (x1 + x2) / 2 + nx * off * 2; // a quadratic's apex sits halfway to its control
  const cy = (y1 + y2) / 2 + ny * off * 2;
  return `M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
}

interface GraphViewProps {
  readonly model: GraphModel;
  readonly active: GraphEvent | undefined;
  /** Hand-placed vertex coordinates (the seed's); a circle when absent or mismatched. */
  readonly layout?: readonly Pt[];
}

export function GraphView({ model, active, layout }: GraphViewProps) {
  const n = model.numVertices;
  const pos = graphLayout(n, layout);
  const copies = copyIndex(model);
  const isDfs = model.algo === 'dfs';

  const examining = active?.kind === 'graph.examine' ? active : undefined;
  const litEdge = examining ? model.incident[examining.from][examining.slot] : undefined;
  const litTone = examining ? (examining.discovers ? TONE.discover : TONE.seen) : undefined;
  const marking = active?.kind === 'graph.mark' ? active.vertex : undefined;

  const treeEdges = new Set<number>();
  for (const k of model.discoveredBy) if (k !== null) treeEdges.add(k);
  const orderIndex = new Map<number, number>();
  model.order.forEach((v, i) => orderIndex.set(v, i + 1));

  const maxDeg = model.incident.reduce((mx, ks) => Math.max(mx, ks.length), 0);
  const listW = 40 + Math.max(maxDeg, 1) * (CELL + 2);
  const listH = 18 + Math.max(n, 1) * ROW_H;
  // At least as wide as the list's header line (~240px at 11px), so it never clips.
  const width = LIST_X + Math.max(listW, 250) + 8;
  const stripsY = Math.max(GH, listH) + 8;
  const height = stripsY + 3 * STRIP_H + 8;

  const frontierLabel = isDfs ? 'stack' : 'queue';
  // Lay the frontier out so the out-end is always the leftmost box: the queue's front,
  // or the stack's top (the stack is shown reversed).
  const frontierShown = isDfs ? model.frontier.slice().reverse() : model.frontier;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="graph: vertices, edges, adjacency lists and the traversal frontier"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      <defs>
        <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={litTone ?? '#666'} />
        </marker>
      </defs>

      {n === 0 && (
        <text x={16} y={30} fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}

      {/* edges first, so the vertices sit on top */}
      {model.edges.map((_, k) => {
        if (k === litEdge) return null; // drawn last, on top
        const [u] = model.edges[k];
        const tree = treeEdges.has(k);
        const touched = model.edgeHits[k] > 0;
        return (
          <path
            key={`e${k}`}
            d={edgePath(model, pos, copies, k, u)}
            fill="none"
            stroke={tree ? TONE.tree : touched ? '#888' : '#ccc'}
            strokeWidth={tree ? 3 : 1.5}
          />
        );
      })}
      {examining && litEdge !== undefined && (
        <path
          key={`e${litEdge}-lit`}
          d={edgePath(model, pos, copies, litEdge, examining.from)}
          fill="none"
          stroke={litTone}
          strokeWidth={3.5}
          markerEnd="url(#graph-arrow)"
        />
      )}

      {pos.map(([x, y], v) => {
        const st = model.state[v];
        const tone = VERTEX[st];
        const isCurrent = model.current === v && !model.done;
        const unreached = model.done && st === 'unseen';
        const ord = orderIndex.get(v);
        return (
          <g key={`v${v}`}>
            <circle
              cx={x}
              cy={y}
              r={R}
              fill={v === marking ? '#ffe08a' : tone.fill}
              stroke={isCurrent ? TONE.tree : tone.stroke}
              strokeWidth={isCurrent ? 3.5 : 1.5}
              strokeDasharray={unreached ? '4 3' : undefined}
            />
            <text x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={13} fontFamily="ui-monospace, monospace" fill="#222">
              {v}
            </text>
            {ord !== undefined && (
              <text x={x + R - 2} y={y - R - 4} fontSize={10} fontFamily="system-ui" fill="#28a745">
                #{ord}
              </text>
            )}
            {unreached && (
              <text x={x} y={y + R + 12} textAnchor="middle" fontSize={10} fontFamily="system-ui" fill="#999">
                not reached
              </text>
            )}
          </g>
        );
      })}

      {/* adjacency lists — one cell per entry, i.e. one cell per edge-visit */}
      <text x={LIST_X} y={12} fontSize={11} fill="#777" fontFamily="system-ui">
        adjacency lists (one cell = one edge-visit)
      </text>
      {model.incident.map((ks, u) => {
        const y = 18 + u * ROW_H;
        return (
          <g key={`row${u}`}>
            <text x={LIST_X + 22} y={y + CELL / 2} textAnchor="end" dominantBaseline="central" fontSize={12} fontFamily="ui-monospace, monospace" fill="#444">
              {u}:
            </text>
            {ks.length === 0 && (
              <text x={LIST_X + 30} y={y + CELL / 2} dominantBaseline="central" fontSize={11} fill="#aaa" fontFamily="system-ui">
                (no edges)
              </text>
            )}
            {ks.map((k, slot) => {
              const x = LIST_X + 30 + slot * (CELL + 2);
              const lit = examining !== undefined && examining.from === u && examining.slot === slot;
              const done = slot < model.examined[u];
              return (
                <g key={`c${u}-${slot}`}>
                  <rect
                    x={x}
                    y={y}
                    width={CELL}
                    height={CELL}
                    rx={3}
                    fill={lit ? (examining?.discovers ? '#d4edda' : '#d1ecf1') : done ? '#e9ecef' : '#fff'}
                    stroke={lit ? litTone : done ? '#adb5bd' : '#ccc'}
                    strokeWidth={lit ? 2.5 : 1}
                  />
                  <text x={x + CELL / 2} y={y + CELL / 2} textAnchor="middle" dominantBaseline="central" fontSize={11} fontFamily="ui-monospace, monospace" fill={done && !lit ? '#888' : '#222'}>
                    {otherEnd(model, k, u)}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}

      {/* frontier, visit order, tally */}
      <text x={16} y={stripsY + STRIP_H / 2} dominantBaseline="central" fontSize={12} fill="#444" fontFamily="system-ui">
        {model.algo === null ? 'frontier' : `${frontierLabel} (next out ←)`}
      </text>
      {frontierShown.length === 0 ? (
        <text x={150} y={stripsY + STRIP_H / 2} dominantBaseline="central" fontSize={11} fill="#aaa" fontFamily="system-ui">
          (empty)
        </text>
      ) : (
        frontierShown.map((v, i) => (
          <g key={`f${i}`}>
            <rect x={150 + i * 28} y={stripsY + 3} width={24} height={STRIP_H - 6} rx={3} fill={VERTEX.marked.fill} stroke={i === 0 ? TONE.tree : VERTEX.marked.stroke} strokeWidth={i === 0 ? 2.5 : 1} />
            <text x={150 + i * 28 + 12} y={stripsY + STRIP_H / 2} textAnchor="middle" dominantBaseline="central" fontSize={12} fontFamily="ui-monospace, monospace">
              {v}
            </text>
          </g>
        ))
      )}
      <text x={16} y={stripsY + STRIP_H * 1.5} dominantBaseline="central" fontSize={12} fill="#444" fontFamily="system-ui">
        visit order
      </text>
      <text x={150} y={stripsY + STRIP_H * 1.5} dominantBaseline="central" fontSize={12} fill="#222" fontFamily="ui-monospace, monospace">
        {model.order.length === 0 ? '—' : model.order.join(' → ')}
      </text>
      <text x={16} y={stripsY + STRIP_H * 2.5} dominantBaseline="central" fontSize={12} fill="#444" fontFamily="system-ui">
        {`cost so far: ${model.vertexVisits} vertex-visit${model.vertexVisits === 1 ? '' : 's'} + ${model.edgeVisits} edge-visit${model.edgeVisits === 1 ? '' : 's'} = ${model.vertexVisits + model.edgeVisits} ops`}
      </text>
    </svg>
  );
}
