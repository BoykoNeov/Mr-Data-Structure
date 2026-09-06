/**
 * PNG export (docs/PLAN.md §7.1, §10 Phase 5): the charts currently on the page, stacked
 * into one image with their titles, legends and the dataset's provenance, so a result can
 * leave the page as a picture — into a slide, an issue, a message — the way CSV/JSON let
 * it leave as data (`./export`).
 *
 * uPlot draws its plot area to a canvas but renders the legend as DOM, so a raw
 * `canvas.toDataURL()` would export lines with nothing naming them. This module therefore
 * composes: it copies each chart's canvas into a sheet and *draws* the title, the legend
 * (with its colour swatches) and the caption beside them.
 *
 * The layout arithmetic is a pure function ({@link planSheet}) so it can be unit-tested;
 * only {@link renderSheet} touches a canvas, and it does nothing a test could check that
 * the layout does not already pin.
 */

/** Layout constants, in CSS pixels — {@link planSheet} scales them by the device ratio. */
export const SHEET = {
  pad: 18,
  titleHeight: 24,
  legendLine: 17,
  captionLine: 16,
  gap: 22,
  swatch: 10,
  /** Caption font size — also the width the caption is wrapped against. */
  captionText: 11,
} as const;

/** One chart to place on the sheet: its canvas size and how many legend lines it needs. */
export interface SheetBlock {
  readonly title: string;
  /** Canvas width in device pixels (`canvas.width`, i.e. already DPR-scaled). */
  readonly width: number;
  /** Canvas height in device pixels. */
  readonly height: number;
  readonly legendLines: number;
}

/** Where each block's parts go, in device pixels from the sheet's top-left. */
export interface PlacedBlock {
  readonly titleY: number;
  readonly chartY: number;
  readonly chartX: number;
  readonly legendY: number;
}

export interface SheetLayout {
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly PlacedBlock[];
  /** Baseline of the first caption line, at the bottom of the sheet. */
  readonly captionY: number;
  /** Device-pixel scale the constants were multiplied by. */
  readonly scale: number;
}

/**
 * Plan the stacked sheet: title, chart, legend for each block, then the caption.
 *
 * Sizes arrive in **device** pixels (`canvas.width`, which uPlot has already multiplied by
 * `devicePixelRatio`), so the text metrics are scaled by the same ratio — otherwise the
 * labels would come out microscopic beside the plot on a HiDPI screen, which is exactly
 * where a shared PNG is usually made.
 */
export function planSheet(
  blocks: readonly SheetBlock[],
  captionLines: number,
  scale: number,
): SheetLayout {
  const s = Math.max(1, scale);
  const pad = SHEET.pad * s;
  const titleH = SHEET.titleHeight * s;
  const legendH = SHEET.legendLine * s;
  const captionH = SHEET.captionLine * s;
  const gap = SHEET.gap * s;

  const contentWidth = blocks.reduce((w, b) => Math.max(w, b.width), 0);
  let y = pad;
  const placed: PlacedBlock[] = [];
  for (const b of blocks) {
    const titleY = y + titleH * 0.7;
    const chartY = y + titleH;
    const legendY = chartY + b.height + legendH * 0.8;
    placed.push({ titleY, chartY, chartX: pad, legendY });
    y = chartY + b.height + legendH * b.legendLines + gap;
  }

  const captionY = y - gap + captionH * 0.8;
  return {
    width: contentWidth + pad * 2,
    height: Math.max(pad * 2, captionY + captionH * (captionLines - 1) + pad),
    blocks: placed,
    captionY,
    scale: s,
  };
}

/**
 * Wrap caption lines to `maxWidth`, measured by the caller's `widthOf` (a canvas text
 * metric in practice, an injected stub in tests).
 *
 * Needed rather than cosmetic: the caption is where the qualifiers travel — the linked
 * list's flat churn line only being flat for the key it just inserted, or a fitted label
 * the project does not stand behind. Those sentences are longer than a chart is wide, and
 * a clipped caveat is worse than none, because it looks complete.
 *
 * Words longer than `maxWidth` are left over-long rather than broken: a URL or an
 * identifier is more use whole than split.
 */
export function wrapLines(
  lines: readonly string[],
  maxWidth: number,
  widthOf: (text: string) => number,
): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let current = '';
    for (const word of line.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && widthOf(candidate) > maxWidth) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current);
  }
  return out;
}

/** One legend entry: the text and the colour of its swatch. */
export interface LegendEntry {
  readonly text: string;
  readonly color: string;
}

/** A chart ready to be drawn: the live canvas plus what names it. */
export interface ChartShot {
  readonly title: string;
  readonly canvas: HTMLCanvasElement;
  readonly legend: readonly LegendEntry[];
}

/**
 * Draw the shots onto a fresh canvas and return it. The sheet is painted on **white**
 * rather than left transparent: these end up pasted into documents and chat, where a
 * transparent background renders the axis text invisible on a dark theme.
 */
export function renderSheet(
  shots: readonly ChartShot[],
  caption: readonly string[],
  scale = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
): HTMLCanvasElement {
  const blocks = shots.map((s) => ({
    title: s.title,
    width: s.canvas.width,
    height: s.canvas.height,
    legendLines: s.legend.length,
  }));
  const s = Math.max(1, scale);
  const captionFont = `${SHEET.captionText * s}px system-ui, -apple-system, Segoe UI, sans-serif`;

  // Wrap the caption *before* planning, so the sheet is tall enough for what it will hold.
  // Measuring needs a context; without one (no DOM) the unwrapped lines are used, which
  // only matters in an environment that cannot draw the sheet anyway.
  const measurer = document.createElement('canvas').getContext('2d');
  const contentWidth = blocks.reduce((w, b) => Math.max(w, b.width), 0);
  let lines = [...caption];
  if (measurer) {
    measurer.font = captionFont;
    lines = wrapLines(caption, contentWidth, (t) => measurer.measureText(t).width);
  }

  const layout = planSheet(blocks, lines.length, scale);
  const sheet = document.createElement('canvas');
  sheet.width = Math.ceil(layout.width);
  sheet.height = Math.ceil(layout.height);
  const ctx = sheet.getContext('2d');
  if (!ctx) return sheet;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  const font = (px: number, weight = '') =>
    `${weight} ${px * s}px system-ui, -apple-system, Segoe UI, sans-serif`.trim();

  shots.forEach((shot, i) => {
    const at = layout.blocks[i];
    ctx.fillStyle = '#222';
    ctx.font = font(14, '600');
    ctx.fillText(shot.title, at.chartX, at.titleY);
    ctx.drawImage(shot.canvas, at.chartX, at.chartY);

    ctx.font = font(11);
    shot.legend.forEach((entry, li) => {
      const y = at.legendY + li * SHEET.legendLine * s;
      const box = SHEET.swatch * s;
      ctx.fillStyle = entry.color;
      ctx.fillRect(at.chartX, y - box * 0.8, box, box);
      ctx.fillStyle = '#333';
      ctx.fillText(entry.text, at.chartX + box * 1.6, y);
    });
  });

  ctx.fillStyle = '#666';
  ctx.font = captionFont;
  lines.forEach((line, i) => {
    ctx.fillText(line, SHEET.pad * s, layout.captionY + i * SHEET.captionLine * s);
  });

  return sheet;
}

/**
 * The plot canvas uPlot rendered inside `host`, or null if the chart has not mounted.
 * uPlot's root holds exactly one canvas; taking it from the DOM keeps {@link ChartShot}
 * free of a uPlot import and works whichever way the chart was built.
 */
export function plotCanvasOf(host: HTMLElement | null): HTMLCanvasElement | null {
  return host?.querySelector('canvas') ?? null;
}
