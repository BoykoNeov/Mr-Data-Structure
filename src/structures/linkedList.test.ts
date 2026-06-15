import { describe, it, expect } from 'vitest';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from './linkedList';
import type { LinkedListEvent } from '../viz/events';

/**
 * The singly and doubly lists share one teaching algorithm, so the observable
 * surface (membership, head→tail order, node-visit op-count) is identical — we
 * run the same suite over both (docs/PLAN.md §8).
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

  it('insert is O(1) — emits one head-insert event, no visits', () => {
    const l = List.fromKeys([1, 2]);
    const events: LinkedListEvent[] = [];
    l.insert(3, (e) => events.push(e));
    expect(events).toEqual([{ kind: 'll.insertHead', value: 3 }]);
    expect(l.keysInOrder()).toEqual([3, 2, 1]);
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

  it('delete emits a visit stream then an unlink + result', () => {
    const l = List.fromKeys([10, 20, 30]); // head→tail: 30, 20, 10
    const events: LinkedListEvent[] = [];
    l.delete(20, (e) => events.push(e)); // visit 30, visit 20 (match) → unlink → result
    expect(events.map((e) => e.kind)).toEqual(['ll.visit', 'll.visit', 'll.unlink', 'll.result']);
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
