import { describe, it, expect } from 'vitest';
import { SkipListF64 } from '../structures/skipList';
import { describeSkip } from './VizPanel';
import type { SkipListEvent } from './events';

/**
 * The skip list's step caption reads the comparison direction from value-vs-target,
 * not from being told the op. The trap (advisor-flagged): an insert descends with `≤`,
 * so it *advances past an equal key* — and a caption that hard-codes "smaller" would
 * then narrate "compare 50 = 50 → smaller", which is wrong and is the first thing a
 * user sees, since the seed invites the duplicate 50. A render smoke can't catch a
 * wrong string, so this asserts the wording directly.
 */
describe('describeSkip: an advance on an equal key is not "smaller"', () => {
  const capture = (op: (s: SkipListF64, push: (e: SkipListEvent) => void) => void) => {
    const s = SkipListF64.fromKeys([10, 30, 40, 50, 50, 90, 220, 270]);
    const events: SkipListEvent[] = [];
    op(s, (e) => events.push(e));
    return events;
  };

  it('inserting a duplicate 50 narrates the equal steps as "equal", never "smaller"', () => {
    const events = capture((s, p) => s.insert(50, p));
    const equalAdvances = events.filter(
      (e): e is Extract<SkipListEvent, { kind: 'skip.inspect' }> =>
        e.kind === 'skip.inspect' && e.outcome === 'advance' && e.value === e.target,
    );
    // The seed has two 50s, both height 1, so the insert advances past them at level 0.
    expect(equalAdvances.length).toBeGreaterThan(0);
    for (const e of equalAdvances) {
      const caption = describeSkip(e);
      expect(caption).not.toContain('smaller');
      expect(caption).toContain('equal');
    }
  });

  it('a search still says "smaller" on a strictly-smaller step (the ordinary case)', () => {
    const events = capture((s, p) => s.search(100, p));
    const smallerAdvances = events.filter(
      (e): e is Extract<SkipListEvent, { kind: 'skip.inspect' }> =>
        e.kind === 'skip.inspect' && e.outcome === 'advance' && e.value < e.target,
    );
    expect(smallerAdvances.length).toBeGreaterThan(0);
    for (const e of smallerAdvances) expect(describeSkip(e)).toContain('smaller');
  });
});
