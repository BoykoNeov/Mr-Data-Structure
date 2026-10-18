import type { ArrayEvent, VizKey } from './events';
import { isHole, type ArrayModel } from './model';
import { keyLabel, cellWidthFor } from './keyLabel';

/**
 * Array renderer (docs/PLAN.md §5, "arrays as cells with index + shift
 * animation"). Cells are drawn left-to-right; each keeps a stable id so a
 * shift-compact delete slides the survivors via a CSS transform transition. The
 * active event drives the highlight: the cell being compared (amber, or green on
 * a match), or the delete target (red).
 *
 * Generic over the key type: the text-key array (docs/PLAN.md §8) draws through
 * the same view. Cells widen to fit the longest label ({@link cellWidthFor}), so a
 * short key — every numeric seed — keeps the original 46 px cell.
 */

const CELL_W = 46;
const CELL_H = 42;
const GAP = 8;
const PAD = 12;
const FONT = 14;

interface Highlight {
  readonly index: number;
  readonly tone: 'compare' | 'match' | 'target';
}

const TONE: Record<Highlight['tone'], { fill: string; stroke: string }> = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  target: { fill: '#f8d7da', stroke: '#dc3545' },
};

/** Which cell (if any) the active event highlights. */
function highlightOf<K extends VizKey>(active: ArrayEvent<K> | undefined, cellCount: number): Highlight | undefined {
  if (!active) return undefined;
  switch (active.kind) {
    case 'arr.compare':
      return { index: active.index, tone: active.matched ? 'match' : 'compare' };
    case 'arr.removeTarget':
      return { index: active.index, tone: 'target' };
    case 'arr.append':
      return { index: cellCount - 1, tone: 'match' }; // flash the new tail
    default:
      return undefined;
  }
}

interface ArrayViewProps<K extends VizKey> {
  readonly model: ArrayModel<K>;
  readonly active: ArrayEvent<K> | undefined;
}

export function ArrayView<K extends VizKey = number>({ model, active }: ArrayViewProps<K>) {
  const { cells } = model;
  const hl = highlightOf(active, cells.length);
  const cellW = cellWidthFor(cells.flatMap((c) => (isHole(c) ? [] : [c.value])), FONT, CELL_W);
  const stride = cellW + GAP;
  const width = PAD * 2 + Math.max(1, cells.length) * stride - GAP;
  const height = PAD * 2 + CELL_H + 18; // room for index labels below

  return (
    <svg
      width={Math.max(width, 120)}
      height={height}
      role="img"
      aria-label="dynamic array cells"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {cells.map((cell, i) => {
        const highlighted = hl && hl.index === i;
        const tone = highlighted ? TONE[hl.tone] : { fill: '#fff', stroke: '#bbb' };
        const hole = isHole(cell);
        return (
          <g
            key={cell.id}
            transform={`translate(${PAD + i * stride}, ${PAD})`}
            style={{ transition: 'transform 180ms ease' }}
          >
            <rect
              width={cellW}
              height={CELL_H}
              rx={5}
              fill={hole && !highlighted ? '#f4f4f4' : tone.fill}
              stroke={hole && !highlighted ? '#ccc' : tone.stroke}
              strokeWidth={2}
              strokeDasharray={hole ? '4 3' : undefined}
            />
            {!hole && (
              <text
                x={cellW / 2}
                y={CELL_H / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={FONT}
                fontFamily="system-ui, sans-serif"
                fill="#222"
              >
                {keyLabel(cell.value)}
              </text>
            )}
            <text
              x={cellW / 2}
              y={CELL_H + 13}
              textAnchor="middle"
              fontSize={11}
              fontFamily="monospace"
              fill="#999"
            >
              {i}
            </text>
          </g>
        );
      })}
      {cells.length === 0 && (
        <text x={PAD} y={PAD + CELL_H / 2} fontSize={13} fill="#999" fontFamily="system-ui">
          (empty)
        </text>
      )}
    </svg>
  );
}
