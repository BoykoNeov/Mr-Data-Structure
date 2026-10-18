import type { HashSetOaEvent } from './events';
import type { OaModel } from './model';

/**
 * Open-addressing hash set renderer (docs/PLAN.md §5, §8; docs/METHODOLOGY.md §2.8). The
 * table is one flat strip of slots, wrapped into rows of {@link COLS} so a 16- or 32-slot
 * table still fits; the walk steps `+1` and wraps from the last slot to slot 0, which is
 * why a cluster can straddle the end of the table. Slots draw three ways: a live key (a
 * chip with a stable id, so a rebuild flies it to its new slot), a **tombstone** (a
 * deleted key's marker — drawn, never as empty, because a walk does not stop there), and
 * empty (dashed).
 *
 * Everything else is derived from the active event: the home slot, the stretch walked so
 * far (home up to the current slot, mod the capacity — every walk event carries `home`),
 * the slot being probed, the free empty slot that stops a walk, and an insert's
 * remembered tombstone (`reuse`).
 */

const COLS = 8;
const CELL_W = 50;
const CELL_H = 34;
const GAP = 6;
const IDX_H = 14;
const TAG_H = 14;
const ROW_GAP = 8;
const PAD = 10;
const STRIDE_X = CELL_W + GAP;
const STRIDE_Y = IDX_H + CELL_H + TAG_H + ROW_GAP;
const FOOT_H = 22;
const MIN_W = 380;

type Tone = 'none' | 'walked' | 'home' | 'probe' | 'match' | 'tomb' | 'stop' | 'duplicate' | 'place' | 'bury';

const TONE: Record<Exclude<Tone, 'none'>, { fill: string; stroke: string }> = {
  walked: { fill: '#fffaf0', stroke: '#f0d48a' },
  home: { fill: '#e7f1ff', stroke: '#4a90d9' },
  probe: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  tomb: { fill: '#efe8f8', stroke: '#8e6cc0' },
  stop: { fill: '#f2f8ff', stroke: '#4a90d9' },
  duplicate: { fill: '#f8d7da', stroke: '#dc3545' },
  place: { fill: '#d4edda', stroke: '#28a745' },
  bury: { fill: '#f8d7da', stroke: '#dc3545' },
};

/** Cyclic distance from `a` forward to `b` in a table of `cap` slots. */
const ahead = (a: number, b: number, cap: number) => (b - a + cap) % cap;

/** Tone of slot `i` under the active event. */
function slotTone(active: HashSetOaEvent | undefined, i: number, cap: number): Tone {
  if (!active) return 'none';
  switch (active.kind) {
    case 'hoa.hash':
      return i === active.home ? 'home' : 'none';
    case 'hoa.probe':
      if (i === active.slot) return active.matched ? 'match' : active.state === 'tomb' ? 'tomb' : 'probe';
      return ahead(active.home, i, cap) < ahead(active.home, active.slot, cap) ? 'walked' : 'none';
    case 'hoa.stop':
      if (i === active.slot) return 'stop';
      return ahead(active.home, i, cap) < ahead(active.home, active.slot, cap) ? 'walked' : 'none';
    case 'hoa.duplicate':
      return i === active.slot ? 'duplicate' : 'none';
    case 'hoa.place':
      return i === active.slot ? 'place' : 'none';
    case 'hoa.tombstone':
      return i === active.slot ? 'bury' : 'none';
    default:
      return 'none';
  }
}

/** The small label under slot `i`: where the walk began, where it stopped, which slot an
 * insert will reuse. */
function slotTag(active: HashSetOaEvent | undefined, i: number): string {
  if (!active) return '';
  switch (active.kind) {
    case 'hoa.hash':
      return i === active.home ? 'home' : '';
    case 'hoa.probe':
    case 'hoa.stop': {
      const tags: string[] = [];
      if (i === active.home) tags.push('home');
      if (active.kind === 'hoa.stop' && i === active.slot) tags.push('stop · free');
      if (active.reuse === i) tags.push('reuse');
      return tags.join(' · ');
    }
    case 'hoa.place':
      return i === active.slot ? (active.reused ? 'reused' : 'stored') : '';
    default:
      return '';
  }
}

const cellX = (i: number) => PAD + (i % COLS) * STRIDE_X;
const cellY = (i: number) => PAD + Math.floor(i / COLS) * STRIDE_Y + IDX_H;

interface OpenAddressingViewProps {
  readonly model: OaModel;
  readonly active: HashSetOaEvent | undefined;
}

export function OpenAddressingView({ model, active }: OpenAddressingViewProps) {
  const cap = model.slots.length;
  const rows = Math.max(1, Math.ceil(cap / COLS));
  // wide enough for the load line under a 4-slot table, too
  const width = Math.max(MIN_W, PAD * 2 + Math.min(cap, COLS) * STRIDE_X - GAP);
  const height = PAD * 2 + rows * STRIDE_Y + FOOT_H;
  const live = model.slots.filter((s) => s !== null && s !== 'tomb').length;
  const tombs = model.slots.filter((s) => s === 'tomb').length;
  const rebuilding = active?.kind === 'hoa.rehash';

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="open-addressing hash table slots"
      style={{ background: rebuilding ? '#eef5ff' : '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {model.slots.map((s, i) => {
        const tone = slotTone(active, i, cap);
        const x = cellX(i);
        const y = cellY(i);
        const isTomb = s === 'tomb';
        const style =
          tone !== 'none'
            ? TONE[tone]
            : s === null
              ? { fill: 'transparent', stroke: '#ccc' }
              : isTomb
                ? { fill: '#f1f1f1', stroke: '#bbb' }
                : { fill: '#fff', stroke: '#bbb' };
        const tag = slotTag(active, i);
        return (
          <g key={`slot-${i}`}>
            <text x={x + CELL_W / 2} y={y - 4} textAnchor="middle" fontSize={10} fontFamily="monospace" fill="#999">
              [{i}]
            </text>
            <rect
              x={x}
              y={y}
              width={CELL_W}
              height={CELL_H}
              rx={4}
              fill={style.fill}
              stroke={style.stroke}
              strokeWidth={tone === 'none' ? 1 : 2}
              strokeDasharray={s === null ? '4 3' : undefined}
            />
            {isTomb && (
              <text
                x={x + CELL_W / 2}
                y={y + CELL_H / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontFamily="system-ui, sans-serif"
                fill="#8a7aa8"
              >
                tomb
              </text>
            )}
            {tag && (
              <text x={x + CELL_W / 2} y={y + CELL_H + 11} textAnchor="middle" fontSize={10} fontFamily="system-ui, sans-serif" fill="#4a6fa5">
                {tag}
              </text>
            )}
          </g>
        );
      })}
      {model.slots.map((s, i) => {
        if (s === null || s === 'tomb') return null;
        return (
          <g key={s.id} transform={`translate(${cellX(i)}, ${cellY(i)})`} style={{ transition: 'transform 220ms ease' }}>
            <text
              x={CELL_W / 2}
              y={CELL_H / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              fontFamily="system-ui, sans-serif"
              fill="#222"
            >
              {s.value}
            </text>
          </g>
        );
      })}
      <text x={PAD} y={height - PAD} fontSize={11} fontFamily="system-ui, sans-serif" fill="#666">
        {`${live} live + ${tombs} tombstone${tombs === 1 ? '' : 's'} = ${live + tombs} of ${cap} slots · rebuild when that passes ${(cap * 3) / 4}`}
      </text>
    </svg>
  );
}
