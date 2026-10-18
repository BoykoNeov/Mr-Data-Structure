import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BenchEngine } from '../bench/BenchEngine';
import { MAX_OP_FIELDS, type RawMaxOpProfile } from '../bench/maxOp';
import { runMaxOp, type MaxOpResult } from '../compare/maxOp';
import { generateUniform } from '../data';
import { MaxOpNotes, MaxOpResults, MaxOpSection } from './MaxOpSection';

/** Every field 1 except the ones a test sets — a structure-agnostic stand-in. */
function raw(structure: RawMaxOpProfile['structure'], n: number, set: Partial<RawMaxOpProfile> = {}): RawMaxOpProfile {
  const base = Object.fromEntries(MAX_OP_FIELDS.map((f) => [f, 1])) as Record<(typeof MAX_OP_FIELDS)[number], number>;
  const tree = structure === 'avl' || structure === 'rbt';
  return {
    ...base,
    structure,
    n,
    stored: n,
    deletes: n,
    delete_misses: 0,
    height: tree ? 12 : NaN,
    insert_max_rotations: tree ? 2 : NaN,
    delete_max_rotations: structure === 'avl' ? 10 : structure === 'rbt' ? 3 : NaN,
    insert_max_recolours: structure === 'rbt' ? 22 : NaN,
    delete_max_recolours: structure === 'rbt' ? 11 : NaN,
    insert_max_moved: structure === 'array' ? 2048 : NaN,
    insert_max_moved_at: structure === 'array' ? 2049 : NaN,
    resizes: structure === 'array' ? 10 : NaN,
    ...set,
  };
}

const engine: Pick<BenchEngine, 'runMaxOpProfile'> = {
  runMaxOpProfile: async (_keys, sizes, structures) => structures.flatMap((s) => sizes.map((n) => raw(s, n))),
};

async function result(): Promise<MaxOpResult> {
  return runMaxOp(engine, generateUniform(4000, 0, 1e6, false, 1), [250, 1000, 4000], undefined, undefined);
}

/** Visible text only (tags stripped), so a phrase split by markup still matches. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, '’');

describe('MaxOpSection — render smoke and honesty guard (docs/PLAN.md §13)', () => {
  it('renders its own button, says it is clock-free, and stays disabled with no numeric run', () => {
    const html = renderToStaticMarkup(
      createElement(MaxOpSection, { engineOf: () => null, busy: false, dataset: null, sizes: null }),
    );
    expect(html).toContain('count the worst single operations');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('clock-free');
    expect(text(html)).toMatch(/counted, never timed/);
    expect(text(html)).toContain('needs a run on numeric keys first');
    // The browser gate's locators must never pick this button.
    expect(html).not.toMatch(/run the sweeps/i);
    expect(html).not.toMatch(/measure the graph/i);
  });

  it('enables the button once a numeric run is on screen', () => {
    const html = renderToStaticMarkup(
      createElement(MaxOpSection, {
        engineOf: () => null,
        busy: false,
        dataset: generateUniform(500, 0, 100, false, 1),
        sizes: [250, 500],
      }),
    );
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });

  it('draws the three tables and the data-driven findings', async () => {
    const r = await result();
    const html = renderToStaticMarkup(createElement(MaxOpResults, { result: r, description: 'uniform — 4,000 number keys' }));
    for (const t of ['ladder', 'top', 'trees', 'findings']) expect(html).toContain(`data-max-op="${t}"`);
    const t = text(html);
    expect(t).toContain('Not timed');
    expect(t).toContain(`n = ${(4000).toLocaleString()}`);
    expect(t).toContain('red-black — rotations, one delete (limit 3)');
    expect(t).toContain('red-black — recolours, one insert (not in its op-count)');
    expect(t).toContain(`${(2048).toLocaleString()} (#${(2049).toLocaleString()})`); // the array's grow-and-copy, with its insert number
    expect(t).toContain('no such step'); // a linked structure's grow-and-copy cell
    expect(t).toMatch(/one AVL delete needed 10 rotations/);
  });

  it('shows the miss column only when a structure dropped repeated keys', async () => {
    const r = await result();
    const clean = renderToStaticMarkup(createElement(MaxOpResults, { result: r, description: 'd' }));
    expect(clean).not.toContain('deletes that found nothing');
    const withMisses: MaxOpResult = {
      ...r,
      rows: r.rows.map((x) => (x.structure === 'hashset' ? { ...x, delete: { ...x.delete, misses: 7 } } : x)),
    };
    const html = renderToStaticMarkup(createElement(MaxOpResults, { result: withMisses, description: 'd' }));
    expect(html).toContain('deletes that found nothing');
    expect(text(html)).toContain(`7 of ${(4000).toLocaleString()}`);
  });

  it('never claims the red-black tree rotates less than the AVL, and says what is left out and why', async () => {
    const r = await result();
    const all = text(
      renderToStaticMarkup(createElement(MaxOpResults, { result: r, description: 'd' })) +
        renderToStaticMarkup(createElement(MaxOpSection, { engineOf: () => null, busy: false, dataset: null, sizes: null })),
    );
    // The VizPanel.test.ts rule: "fewer rotations" is a per-operation bound, never a total.
    expect(all).not.toMatch(/fewer rotations|rotates less|less rotation/i);
    expect(all).toMatch(/in total/);
    expect(all).toMatch(/on inserts the two schemes promise the same/);
    // Recolours are outside the op-count.
    expect(all).toMatch(/never added to its op-count/);
    // The amortised spike is explained, not hidden.
    expect(all).toMatch(/outside the op-count on purpose/);
    expect(all).toMatch(/amortised O\(1\)/);
    // What is absent, and why.
    const notes = text(renderToStaticMarkup(createElement(MaxOpNotes)));
    expect(notes).toMatch(/the min-heap \(its operations are insert and remove-the-smallest/);
    expect(notes).toMatch(/the graph \(it has no keys to insert\)/);
    expect(notes).toMatch(/text keys/);
    expect(notes).toMatch(/Clock-free \(counted, not timed\)/);
  });
});
