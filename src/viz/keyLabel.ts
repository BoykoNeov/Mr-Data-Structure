import type { VizKey } from './events';

/**
 * How the array and hash-set views label a key (docs/PLAN.md §5). A number prints
 * as itself. A string prints verbatim except for the two cases SVG text would
 * otherwise hide: the empty string reads `""`, and each space reads `␣` — SVG
 * collapses leading/trailing whitespace, so `" a"` would silently draw as `a`, and
 * a key's identity is its exact text (CLAUDE.md, "keys are identity").
 */
export function keyLabel(k: VizKey): string {
  if (typeof k === 'number') return String(k);
  return k === '' ? '""' : k.replace(/ /g, '␣');
}

/** A rough rendered width, in px, of `text` at `fontPx` in a system sans-serif: wide
 * (CJK / emoji) code points take about a full em, the rest about 0.62 em. Only used
 * to size a cell so a long key does not overflow it — never for anything measured. */
export function textWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    em += cp >= 0x1100 ? 1 : 0.62;
  }
  return em * fontPx;
}

/** The width a cell must have to hold every key's label with `pad` px either side,
 * never narrower than `min` — so short keys (every numeric seed) keep the views'
 * original fixed width. */
export function cellWidthFor(keys: readonly VizKey[], fontPx: number, min: number, pad = 7): number {
  let w = min;
  for (const k of keys) w = Math.max(w, Math.ceil(textWidth(keyLabel(k), fontPx) + 2 * pad));
  return w;
}
