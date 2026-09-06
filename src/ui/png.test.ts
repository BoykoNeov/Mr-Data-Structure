import { describe, it, expect } from 'vitest';
import { planSheet, SHEET, type SheetBlock } from './png';

/**
 * The PNG sheet's arithmetic, kept pure so it can be checked without a canvas (jsdom has
 * no 2-D context). What matters is that nothing overlaps and nothing falls off the sheet —
 * an export whose legend sits on top of the next chart is worse than no export.
 */
const block = (width: number, height: number, legendLines: number): SheetBlock => ({
  title: 't',
  width,
  height,
  legendLines,
});

describe('planSheet', () => {
  it('stacks blocks in order, each below the last, with room for its legend', () => {
    const blocks = [block(800, 400, 4), block(800, 400, 2), block(600, 300, 5)];
    const l = planSheet(blocks, 2, 1);

    expect(l.blocks).toHaveLength(3);
    for (let i = 0; i < blocks.length; i++) {
      const at = l.blocks[i];
      expect(at.titleY).toBeLessThan(at.chartY);
      expect(at.legendY).toBeGreaterThan(at.chartY + blocks[i].height);
      if (i > 0) {
        // The block's title clears the previous block's last legend line.
        const prev = l.blocks[i - 1];
        const prevLegendBottom = prev.legendY + (blocks[i - 1].legendLines - 1) * SHEET.legendLine;
        expect(at.titleY).toBeGreaterThan(prevLegendBottom);
      }
    }
  });

  it('sizes the sheet to the widest chart and past the last caption line', () => {
    const l = planSheet([block(800, 400, 1), block(1200, 300, 1)], 3, 1);
    expect(l.width).toBe(1200 + SHEET.pad * 2);
    const lastCaption = l.captionY + SHEET.captionLine * 2;
    expect(l.height).toBeGreaterThan(lastCaption);
    // The caption sits below the last legend rather than over it.
    const last = l.blocks[1];
    expect(l.captionY).toBeGreaterThan(last.legendY);
  });

  it('scales the text furniture with the device pixel ratio', () => {
    // uPlot's canvas is already DPR-scaled, so the labels must be too — otherwise the
    // legend comes out microscopic beside the plot on exactly the screens people export from.
    const one = planSheet([block(800, 400, 3)], 1, 1);
    const two = planSheet([block(800, 400, 3)], 1, 2);
    expect(two.scale).toBe(2);
    expect(two.blocks[0].chartX).toBe(one.blocks[0].chartX * 2);
    // The chart bitmap itself is unchanged (same device pixels), so the sheet grows only
    // by the extra furniture, not by double.
    expect(two.height).toBeGreaterThan(one.height);
    expect(two.height).toBeLessThan(one.height * 2);
  });

  it('never returns a degenerate sheet for an empty or single-line export', () => {
    const empty = planSheet([], 1, 1);
    expect(empty.width).toBeGreaterThan(0);
    expect(empty.height).toBeGreaterThan(0);
    const one = planSheet([block(10, 10, 0)], 1, 1);
    expect(one.height).toBeGreaterThan(10);
  });
});
