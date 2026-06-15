import type { SortedArrayEvent } from './events';
import { isHole, type ArrayModel } from './model';

/**
 * Sorted-array renderer (docs/PLAN.md §5, "arrays as cells with index + shift
 * animation"). Like {@link ./ArrayView} but it visualizes the *binary search*:
 * on a `sarr.compare` the live window `[lo, hi)` stays bright while the
 * eliminated halves dim, and the midpoint lights amber (green on a match) — the
 * O(log n) halving made visible. Inserts shift cells right to open a gap and a
 * value drops into it; deletes shift left and pop. Each cell keeps a stable id so
 * the shifts slide via a CSS transform transition.
 */

const CELL_W = 46;
const CELL_H = 42;
const GAP = 8;
const PAD = 12;
const STRIDE = CELL_W + GAP;

interface CellState {
  /** Outside the active binary-search window — eliminated, dimmed. */
  readonly eliminated: boolean;
  readonly tone: 'none' | 'compare' | 'match' | 'target';
}

const TONE: Record<Exclude<CellState['tone'], 'none'>, { fill: string; stroke: string }> = {
  compare: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  target: { fill: '#f8d7da', stroke: '#dc3545' },
};

/** Per-cell render state derived from the active event. */
function cellStateOf(active: SortedArrayEvent | undefined, i: number): CellState {
  if (!active) return { eliminated: false, tone: 'none' };
  switch (active.kind) {
    case 'sarr.compare': {
      const eliminated = i < active.lo || i >= active.hi;
      if (i === active.index) return { eliminated: false, tone: active.matched ? 'match' : 'compare' };
      return { eliminated, tone: 'none' };
    }
    case 'sarr.removeTarget':
      return { eliminated: false, tone: i === active.index ? 'target' : 'none' };
    case 'sarr.fill':
      return { eliminated: false, tone: i === active.index ? 'match' : 'none' };
    default:
      return { eliminated: false, tone: 'none' };
  }
}

interface SortedArrayViewProps {
  readonly model: ArrayModel;
  readonly active: SortedArrayEvent | undefined;
}

export function SortedArrayView({ model, active }: SortedArrayViewProps) {
  const { cells } = model;
  const width = PAD * 2 + Math.max(1, cells.length) * STRIDE - GAP;
  const height = PAD * 2 + CELL_H + 18; // room for index labels below

  return (
    <svg
      width={Math.max(width, 120)}
      height={height}
      role="img"
      aria-label="sorted array cells"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {cells.map((cell, i) => {
        const st = cellStateOf(active, i);
        const hole = isHole(cell);
        const base =
          st.tone !== 'none'
            ? TONE[st.tone]
            : hole
              ? { fill: '#f4f4f4', stroke: '#ccc' }
              : { fill: '#fff', stroke: '#bbb' };
        return (
          <g
            key={cell.id}
            transform={`translate(${PAD + i * STRIDE}, ${PAD})`}
            style={{ transition: 'transform 180ms ease', opacity: st.eliminated ? 0.3 : 1 }}
          >
            <rect
              width={CELL_W}
              height={CELL_H}
              rx={5}
              fill={base.fill}
              stroke={base.stroke}
              strokeWidth={2}
              strokeDasharray={hole && st.tone === 'none' ? '4 3' : undefined}
            />
            {!hole && (
              <text
                x={CELL_W / 2}
                y={CELL_H / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={14}
                fontFamily="system-ui, sans-serif"
                fill="#222"
              >
                {cell.value}
              </text>
            )}
            <text
              x={CELL_W / 2}
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
