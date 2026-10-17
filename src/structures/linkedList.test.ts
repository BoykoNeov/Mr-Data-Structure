import { describe, it, expect } from 'vitest';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from './linkedList';
import type { LinkedListEvent, DoublyListEvent } from '../viz/events';

/**
 * The singly and doubly lists run one algorithm, so the observable surface
 * (membership, head→tail order, node-visit op-count) is identical — we run the same
 * suite over both (docs/PLAN.md §8). Their event streams differ (the doubly list also
 * traces its pointer writes), so those are tested per list below.
 */
describe.each([
  ['SinglyLinkedListF64', SinglyLinkedListF64],
  ['DoublyLinkedListF64', DoublyLinkedListF64],
] as const)('%s — teaching impl (node-visits)', (_name, List) => {
  it('head insert reverses insertion order', () => {
    const l = List.fromKeys([1, 2, 3]);
    expect(l.keysInOrder()).toEqual([3, 2, 1]);
    expect(l.size).toBe(3);
  });

  it('keeps duplicates (multiset)', () => {
    const l = List.fromKeys([5, 5, 5]);
    expect(l.keysInOrder()).toEqual([5, 5, 5]);
  });

  it('search node-visits equal the 1-based position when found', () => {
    const l = List.fromKeys([10, 20, 30]); // head→tail: 30, 20, 10
    expect(l.search(30)).toEqual({ found: true, ops: 1 });
    expect(l.search(20)).toEqual({ found: true, ops: 2 });
    expect(l.search(10)).toEqual({ found: true, ops: 3 });
  });

  it('an absent key walks the whole list', () => {
    const l = List.fromKeys([10, 20, 30]);
    expect(l.search(99)).toEqual({ found: false, ops: 3 });
  });

  it('delete counts node-visits to find the key and unlinks the first match', () => {
    const l = List.fromKeys([10, 20, 30]); // head→tail: 30, 20, 10
    // delete the head: 1 visit, no further walk.
    expect(l.delete(30)).toEqual({ removed: true, ops: 1 });
    expect(l.keysInOrder()).toEqual([20, 10]);
    // delete the tail: full walk.
    expect(l.delete(10)).toEqual({ removed: true, ops: 2 });
    expect(l.keysInOrder()).toEqual([20]);
    // absent key: full walk, nothing removed.
    expect(l.delete(99)).toEqual({ removed: false, ops: 1 });
  });

  it('delete removes only the first occurrence (multiset)', () => {
    const l = List.fromKeys([7, 5, 5]); // head→tail: 5, 5, 7
    expect(l.delete(5).removed).toBe(true);
    expect(l.keysInOrder()).toEqual([5, 7]);
  });

  it('membership and order agree with a reference over a random workload', () => {
    const keys = Array.from({ length: 120 }, (_, i) => (i * 13) % 37);
    const l = List.fromKeys(keys);
    const ref = [...keys].reverse(); // head insert reverses
    expect(l.keysInOrder()).toEqual(ref);
    for (const q of [0, 36, 5, 5, 99, 12, 24]) {
      const before = ref.indexOf(q);
      const res = l.delete(q);
      if (before === -1) expect(res.removed).toBe(false);
      else {
        expect(res.removed).toBe(true);
        ref.splice(before, 1);
      }
      expect(l.keysInOrder()).toEqual(ref);
    }
  });
});

describe('SinglyLinkedListF64 — event stream', () => {
  it('insert is O(1) — emits one head-insert event, no visits', () => {
    const l = SinglyLinkedListF64.fromKeys([1, 2]);
    const events: LinkedListEvent[] = [];
    l.insert(3, (e) => events.push(e));
    expect(events).toEqual([{ kind: 'll.insertHead', value: 3 }]);
    expect(l.keysInOrder()).toEqual([3, 2, 1]);
  });

  it('delete emits a visit stream then an unlink + result', () => {
    const l = SinglyLinkedListF64.fromKeys([10, 20, 30]); // head→tail: 30, 20, 10
    const events: LinkedListEvent[] = [];
    l.delete(20, (e) => events.push(e)); // visit 30, visit 20 (match) → unlink → result
    expect(events.map((e) => e.kind)).toEqual(['ll.visit', 'll.visit', 'll.unlink', 'll.result']);
  });
});

/**
 * The doubly twin holds real `next` / `prev` links (an index arena like the Rust twin's),
 * so these are the TS-side counterparts of `bench-engine/tests/proptest_doubly_linked_list.rs`
 * and the Rust unit tests: the back links stay a mirror of the forward ones after every op.
 */
describe('DoublyLinkedListF64 — real back links', () => {
  const rev = (xs: readonly number[]) => [...xs].reverse();

  it('insert writes three pointers (new.next, old head.prev, head) — no visits', () => {
    const l = DoublyLinkedListF64.fromKeys([1, 2]); // 2 → 1
    const events: DoublyListEvent[] = [];
    l.insert(3, (e) => events.push(e));
    expect(events).toEqual([
      { kind: 'll.insertHead', value: 3 },
      { kind: 'dll.relink', link: 'next', from: 0, to: 1 },
      { kind: 'dll.relink', link: 'prev', from: 1, to: 0 },
      { kind: 'dll.relink', link: 'next', from: null, to: 0 },
    ]);
    expect(l.keysInOrder()).toEqual([3, 2, 1]);
    expect(l.keysReversed()).toEqual([1, 2, 3]);
  });

  it('insert into an empty list points the tail handle at the new node', () => {
    const l = new DoublyLinkedListF64();
    const events: DoublyListEvent[] = [];
    l.insert(9, (e) => events.push(e));
    expect(events.slice(1)).toEqual([
      { kind: 'dll.relink', link: 'next', from: 0, to: null },
      { kind: 'dll.relink', link: 'prev', from: null, to: 0 },
      { kind: 'dll.relink', link: 'next', from: null, to: 0 },
    ]);
    expect(l.snapshot()).toEqual({ values: [9], next: [null], prev: [null], head: 0, tail: 0 });
  });

  it.each([
    // [label, key, the two relinks]   list: 40 → 30 → 20 → 10
    ['the head', 40, [{ link: 'next', from: null, to: 1 }, { link: 'prev', from: 1, to: null }]],
    ['a middle node', 20, [{ link: 'next', from: 1, to: 3 }, { link: 'prev', from: 3, to: 1 }]],
    ['the tail', 10, [{ link: 'next', from: 2, to: null }, { link: 'prev', from: null, to: 2 }]],
  ] as const)('deleting %s writes its neighbours (or the handles) past it, then drops it', (_label, key, relinks) => {
    const l = DoublyLinkedListF64.fromKeys([10, 20, 30, 40]);
    const events: DoublyListEvent[] = [];
    const r = l.delete(key, (e) => events.push(e));
    const at = [40, 30, 20, 10].indexOf(key);
    expect(r).toEqual({ removed: true, ops: at + 1 });
    expect(events.slice(at + 1)).toEqual([
      ...relinks.map((x) => ({ kind: 'dll.relink', ...x })),
      { kind: 'll.unlink', index: at },
      { kind: 'll.result', found: true },
    ]);
    expect(l.keysReversed()).toEqual(rev(l.keysInOrder()));
  });

  it('deleting the only node empties both handles', () => {
    const l = DoublyLinkedListF64.fromKeys([5]);
    const events: DoublyListEvent[] = [];
    l.delete(5, (e) => events.push(e));
    expect(events.filter((e) => e.kind === 'dll.relink')).toEqual([
      { kind: 'dll.relink', link: 'next', from: null, to: null },
      { kind: 'dll.relink', link: 'prev', from: null, to: null },
    ]);
    expect(l.snapshot()).toEqual({ values: [], next: [], prev: [], head: null, tail: null });
    expect(l.keysReversed()).toEqual([]);
  });

  it('a miss writes no pointer', () => {
    const l = DoublyLinkedListF64.fromKeys([1, 2, 3]);
    const events: DoublyListEvent[] = [];
    l.delete(99, (e) => events.push(e));
    expect(events.some((e) => e.kind === 'dll.relink' || e.kind === 'll.unlink')).toBe(false);
  });

  it('back links mirror forward links after every op of a seeded random stream (freed slots reused)', () => {
    // Small key range ⇒ duplicates and hits at every position. Phases alternate every 100
    // steps: growing (70 % inserts), then draining (20 % inserts, and half the deletes aim
    // at a stored key) — without the drain the list settles near 26 nodes and never gets
    // back down to one. Every delete frees a slot the next insert reuses.
    let seed = 0x9e3779b9;
    const rand = (m: number) => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return seed % m;
    };
    const l = new DoublyLinkedListF64();
    const ref: number[] = [];
    const seen = { head: 0, tail: 0, middle: 0, only: 0 };
    for (let step = 0; step < 2000; step++) {
      const grow = Math.floor(step / 100) % 2 === 0;
      const key = !grow && ref.length > 0 && rand(2) === 0 ? ref[rand(ref.length)] : rand(12);
      if (rand(10) < (grow ? 7 : 2) || ref.length === 0) {
        l.insert(key);
        ref.unshift(key);
      } else {
        const at = ref.indexOf(key);
        if (at !== -1) {
          if (ref.length === 1) seen.only++;
          else if (at === 0) seen.head++;
          else if (at === ref.length - 1) seen.tail++;
          else seen.middle++;
          ref.splice(at, 1);
        }
        expect(l.delete(key).removed).toBe(at !== -1);
      }
      expect(l.keysInOrder()).toEqual(ref);
      expect(l.keysReversed()).toEqual(rev(ref));
      expect(l.size).toBe(ref.length);
    }
    // the stream really did unlink at every kind of position
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(0);
  });

  it('snapshot reports positional links: next = i + 1, prev = i − 1, handles at the ends', () => {
    const l = DoublyLinkedListF64.fromKeys([1, 2, 3]);
    l.delete(2);
    l.insert(7); // reuses the freed slot
    expect(l.snapshot()).toEqual({
      values: [7, 3, 1],
      next: [1, 2, null],
      prev: [null, 0, 1],
      head: 0,
      tail: 2,
    });
  });
});
