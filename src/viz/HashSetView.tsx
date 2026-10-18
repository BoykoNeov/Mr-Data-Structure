import type { HashSetEvent, VizKey } from './events';
import type { HashModel } from './model';
import { keyLabel, cellWidthFor } from './keyLabel';

/**
 * Hash-set renderer (docs/PLAN.md §5, "hash tables as bucket arrays with chains
 * … and rehash animation"). Each bucket is a row; chips sit along the chain. A
 * chip keeps a stable id, so a rehash relocates it to its new row with a CSS
 * transform transition — the redistribution animates rather than snapping. The
 * active event highlights the hashed bucket, the probed chip (green on a match),
 * or the whole table during a rehash.
 *
 * Generic over the key type: the text-key hash set (docs/PLAN.md §8) draws through
 * the same view, with chips widened to fit the longest label ({@link cellWidthFor});
 * a short key — every numeric seed — keeps the original 46 px chip.
 */

const ROW_H = 34;
const CHIP_W = 46;
const CHIP_H = 26;
const GAP = 8;
const LABEL_W = 64;
const PAD = 10;
const FONT = 13;

interface ChipPos<K extends VizKey> {
  readonly id: number;
  readonly value: K;
  readonly bucket: number;
  readonly pos: number;
}

/** Flatten the model into positioned chips (bucket + index within the chain). */
function placeChips<K extends VizKey>(model: HashModel<K>): ChipPos<K>[] {
  const out: ChipPos<K>[] = [];
  model.buckets.forEach((chain, bucket) => {
    chain.forEach((chip, pos) => out.push({ id: chip.id, value: chip.value, bucket, pos }));
  });
  return out;
}

type Tone = 'none' | 'bucket' | 'probe' | 'match' | 'duplicate';

const TONE: Record<Exclude<Tone, 'none'>, { fill: string; stroke: string }> = {
  bucket: { fill: '#e7f1ff', stroke: '#4a90d9' },
  probe: { fill: '#fff3cd', stroke: '#e0a800' },
  match: { fill: '#d4edda', stroke: '#28a745' },
  duplicate: { fill: '#f8d7da', stroke: '#dc3545' },
};

/** Tone for a chip given the active event. `tailPos` is the index of the last
 * chip in the active insert's bucket, so only the freshly appended chip lights. */
function chipTone<K extends VizKey>(active: HashSetEvent<K> | undefined, c: ChipPos<K>, tailPos: number): Tone {
  if (!active) return 'none';
  switch (active.kind) {
    case 'hs.probe':
      if (active.bucket === c.bucket && active.pos === c.pos) {
        return active.matched ? 'match' : 'probe';
      }
      return 'none';
    case 'hs.duplicate':
      return active.bucket === c.bucket && active.pos === c.pos ? 'duplicate' : 'none';
    case 'hs.insert':
      // the freshly appended chip is the tail of its bucket
      return active.bucket === c.bucket && c.pos === tailPos ? 'match' : 'none';
    default:
      return 'none';
  }
}

/** Bucket row highlighted by an active hash (or every row during a rehash). */
function rowTone<K extends VizKey>(active: HashSetEvent<K> | undefined, bucket: number): boolean {
  if (!active) return false;
  if (active.kind === 'hs.hash') return active.bucket === bucket;
  if (active.kind === 'hs.rehash') return true;
  return false;
}

interface HashSetViewProps<K extends VizKey> {
  readonly model: HashModel<K>;
  readonly active: HashSetEvent<K> | undefined;
}

export function HashSetView<K extends VizKey = number>({ model, active }: HashSetViewProps<K>) {
  const cap = model.buckets.length;
  const chips = placeChips(model);
  const chipW = cellWidthFor(chips.map((c) => c.value), FONT, CHIP_W, 9);
  const stride = chipW + GAP;
  const longest = model.buckets.reduce((m, b) => Math.max(m, b.length), 0);
  const width = LABEL_W + PAD * 2 + Math.max(1, longest) * stride;
  const height = PAD * 2 + cap * ROW_H;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="hash set buckets"
      style={{ background: '#fafafa', border: '1px solid #eee', borderRadius: 6 }}
    >
      {model.buckets.map((_, bucket) => {
        const y = PAD + bucket * ROW_H;
        return (
          <g key={`row-${bucket}`}>
            <rect
              x={2}
              y={y}
              width={width - 4}
              height={ROW_H - 4}
              rx={4}
              fill={rowTone(active, bucket) ? '#eef5ff' : 'transparent'}
              stroke={rowTone(active, bucket) ? '#bcd6f5' : 'transparent'}
            />
            <text
              x={PAD}
              y={y + (ROW_H - 4) / 2}
              dominantBaseline="central"
              fontSize={12}
              fontFamily="monospace"
              fill="#888"
            >
              [{bucket}]
            </text>
          </g>
        );
      })}
      {chips.map((c) => {
        const tailPos = model.buckets[c.bucket].length - 1;
        const tone = chipTone(active, c, tailPos);
        const style = tone === 'none' ? { fill: '#fff', stroke: '#bbb' } : TONE[tone];
        const x = LABEL_W + PAD + c.pos * stride;
        const y = PAD + c.bucket * ROW_H + (ROW_H - 4 - CHIP_H) / 2;
        return (
          <g
            key={c.id}
            transform={`translate(${x}, ${y})`}
            style={{ transition: 'transform 220ms ease' }}
          >
            <rect
              width={chipW}
              height={CHIP_H}
              rx={13}
              fill={style.fill}
              stroke={style.stroke}
              strokeWidth={2}
            />
            <text
              x={chipW / 2}
              y={CHIP_H / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={FONT}
              fontFamily="system-ui, sans-serif"
              fill="#222"
            >
              {keyLabel(c.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
