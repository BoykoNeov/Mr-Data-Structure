import { describe, it, expect } from 'vitest';
import { DynArrayF64 } from '../structures/dynArray';
import { HashSetF64 } from '../structures/hashSet';
import { SortedArrayF64 } from '../structures/sortedArray';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import type { ArrayEvent, HashSetEvent, SortedArrayEvent, LinkedListEvent } from './events';
import {
  arrayModel, foldArray, hashModel, foldHash, isHole, type ArrayModel, type HashModel,
  foldSortedArray, linkedModel, foldLinkedList,
} from './model';

/**
 * The fold's correctness is pinned *against the real algorithm*: capture the
 * model before an op, run the op on the structure with a tracer, fold the emitted
 * events over the captured model, and assert the folded result matches the
 * structure's actual post-op state. If the event stream and the reducer ever
 * disagree with the structure, this fails (docs/PLAN.md §5).
 */

const arrValues = (m: ArrayModel) => m.cells.map((c) => (isHole(c) ? '·' : c.value));
const hashValues = (m: HashModel) => m.buckets.map((b) => b.map((c) => c.value));

describe('array fold mirrors the structure', () => {
  it('a search stream leaves the model unchanged', () => {
    const a = DynArrayF64.fromKeys([10, 20, 30]);
    const before = arrayModel(a.keysInOrder());
    const events: ArrayEvent[] = [];
    a.search(20, (e) => events.push(e));
    expect(arrValues(foldArray(before, events))).toEqual([10, 20, 30]);
  });

  it('an append stream grows the model with a fresh id', () => {
    const a = DynArrayF64.fromKeys([1, 2]);
    const before = arrayModel(a.keysInOrder());
    const events: ArrayEvent[] = [];
    a.insert(3, (e) => events.push(e));
    const after = foldArray(before, events);
    expect(arrValues(after)).toEqual([1, 2, 3]);
    expect(new Set(after.cells.map((c) => c.id)).size).toBe(3); // ids distinct
  });

  it('a shift-compact delete folds to the structure’s post-delete keys', () => {
    const a = DynArrayF64.fromKeys([10, 20, 30, 40, 50]);
    const before = arrayModel(a.keysInOrder());
    const events: ArrayEvent[] = [];
    a.delete(20, (e) => events.push(e));
    expect(arrValues(foldArray(before, events))).toEqual(a.keysInOrder());
    expect(a.keysInOrder()).toEqual([10, 30, 40, 50]);
  });

  it('deleting an absent key leaves the model unchanged', () => {
    const a = DynArrayF64.fromKeys([1, 2, 3]);
    const before = arrayModel(a.keysInOrder());
    const events: ArrayEvent[] = [];
    a.delete(99, (e) => events.push(e));
    expect(arrValues(foldArray(before, events))).toEqual([1, 2, 3]);
  });

  it('every frame of a non-tail delete has unique slot ids (each prefix is renderable)', () => {
    // The renderer keys slots by id and folds *every* prefix, not just the final
    // frame; the vacated hole must keep ids unique as the survivors shift left.
    const a = DynArrayF64.fromKeys([10, 20, 30, 40, 50]);
    const before = arrayModel(a.keysInOrder());
    const events: ArrayEvent[] = [];
    a.delete(20, (e) => events.push(e)); // delete a non-tail element (index 1)
    for (let f = 0; f <= events.length; f++) {
      const ids = foldArray(before, events.slice(0, f)).cells.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // and the final frame still equals the structure's post-delete keys.
    expect(arrValues(foldArray(before, events))).toEqual([10, 30, 40, 50]);
  });
});

describe('hash-set fold mirrors the structure', () => {
  it('an insert that triggers a rehash folds to the structure’s buckets, ids preserved', () => {
    const s = new HashSetF64();
    for (const k of [1, 2, 3]) s.insert(k); // 4 buckets, no rehash yet
    let model = hashModel(s.snapshotBuckets());
    const idsBefore = new Set(model.buckets.flat().map((c) => c.id));

    const events: HashSetEvent[] = [];
    s.insert(4, (e) => events.push(e)); // 4th distinct insert → rehash to 8
    expect(events.some((e) => e.kind === 'hs.rehash')).toBe(true);
    model = foldHash(model, events);

    expect(hashValues(model)).toEqual(s.snapshotBuckets());
    // the 3 pre-existing chips kept their ids through the rehash relocation.
    const idsAfter = new Set(model.buckets.flat().map((c) => c.id));
    for (const id of idsBefore) expect(idsAfter.has(id)).toBe(true);
  });

  it('a chain-remove delete folds to the structure’s buckets', () => {
    const s = HashSetF64.fromKeys([10, 20, 30, 40, 50, 60]);
    const before = hashModel(s.snapshotBuckets());
    const events: HashSetEvent[] = [];
    s.delete(30, (e) => events.push(e));
    expect(hashValues(foldHash(before, events))).toEqual(s.snapshotBuckets());
  });

  it('a duplicate insert leaves the buckets unchanged', () => {
    const s = HashSetF64.fromKeys([5, 6, 7]);
    const before = hashModel(s.snapshotBuckets());
    const events: HashSetEvent[] = [];
    s.insert(6, (e) => events.push(e)); // already present
    expect(events.some((e) => e.kind === 'hs.duplicate')).toBe(true);
    expect(hashValues(foldHash(before, events))).toEqual(s.snapshotBuckets());
  });
});

describe('sorted-array fold mirrors the structure', () => {
  /** Capture before-state, run the op with a tracer, fold, and compare to the
   * structure's actual post-op keys — the fold can't drift from the algorithm. */
  const runFold = (build: number[], op: (a: SortedArrayF64, push: (e: SortedArrayEvent) => void) => void) => {
    const a = SortedArrayF64.fromKeys(build);
    const before = arrayModel(a.keysInOrder());
    const events: SortedArrayEvent[] = [];
    op(a, (e) => events.push(e));
    return { a, before, events };
  };

  it('a binary-search stream leaves the model unchanged', () => {
    const { a, before, events } = runFold([10, 20, 30, 40, 50], (s, push) => s.search(30, push));
    expect(arrValues(foldSortedArray(before, events))).toEqual(a.keysInOrder());
  });

  it('an insert folds to the structure’s post-insert keys, ids distinct', () => {
    const { a, before, events } = runFold([10, 20, 40, 50], (s, push) => s.insert(30, push));
    const after = foldSortedArray(before, events);
    expect(arrValues(after)).toEqual(a.keysInOrder());
    expect(a.keysInOrder()).toEqual([10, 20, 30, 40, 50]);
    expect(new Set(after.cells.map((c) => c.id)).size).toBe(after.cells.length);
  });

  it('inserting a new minimum (max shift count) still folds correctly', () => {
    const { a, before, events } = runFold([20, 30, 40], (s, push) => s.insert(5, push));
    expect(arrValues(foldSortedArray(before, events))).toEqual([5, 20, 30, 40]);
    expect(a.keysInOrder()).toEqual([5, 20, 30, 40]);
  });

  it('every frame of an insert is renderable (unique slot ids each prefix)', () => {
    // The hole bubbles right→left through the shifts; each prefix must keep ids
    // unique (the renderer keys slots by id and folds every prefix, not just the end).
    const { a, before, events } = runFold([10, 20, 40, 50], (s, push) => s.insert(30, push));
    for (let f = 0; f <= events.length; f++) {
      const ids = foldSortedArray(before, events.slice(0, f)).cells.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(arrValues(foldSortedArray(before, events))).toEqual(a.keysInOrder());
  });

  it('a delete folds to the structure’s post-delete keys', () => {
    const { a, before, events } = runFold([10, 20, 30, 40, 50], (s, push) => s.delete(20, push));
    expect(arrValues(foldSortedArray(before, events))).toEqual(a.keysInOrder());
    expect(a.keysInOrder()).toEqual([10, 30, 40, 50]);
  });

  it('every frame of a delete is renderable (unique slot ids each prefix)', () => {
    const { before, events } = runFold([10, 20, 30, 40, 50], (s, push) => s.delete(20, push));
    for (let f = 0; f <= events.length; f++) {
      const ids = foldSortedArray(before, events.slice(0, f)).cells.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('deleting an absent key leaves the model unchanged', () => {
    const { a, before, events } = runFold([10, 20, 30], (s, push) => s.delete(99, push));
    expect(arrValues(foldSortedArray(before, events))).toEqual(a.keysInOrder());
  });
});

describe('linked-list fold mirrors the structure (singly + doubly)', () => {
  for (const List of [SinglyLinkedListF64, DoublyLinkedListF64]) {
    describe(List.name, () => {
      it('head insert reverses input order and folds to the structure', () => {
        const l = List.fromKeys([10, 20, 30]); // head-insert ⇒ 30→20→10
        expect(l.keysInOrder()).toEqual([30, 20, 10]);
        const before = linkedModel(l.keysInOrder());
        const events: LinkedListEvent[] = [];
        l.insert(40, (e) => events.push(e));
        const after = foldLinkedList(before, events);
        expect(after.nodes.map((n) => n.value)).toEqual(l.keysInOrder());
        expect(l.keysInOrder()).toEqual([40, 30, 20, 10]);
        expect(new Set(after.nodes.map((n) => n.id)).size).toBe(after.nodes.length);
      });

      it('a search leaves the model unchanged', () => {
        const l = List.fromKeys([1, 2, 3]);
        const before = linkedModel(l.keysInOrder());
        const events: LinkedListEvent[] = [];
        l.search(2, (e) => events.push(e));
        expect(foldLinkedList(before, events).nodes.map((n) => n.value)).toEqual(l.keysInOrder());
      });

      it('a delete unlinks the node and folds to the post-delete list', () => {
        const l = List.fromKeys([10, 20, 30, 40]); // 40→30→20→10
        const before = linkedModel(l.keysInOrder());
        const events: LinkedListEvent[] = [];
        l.delete(30, (e) => events.push(e));
        const after = foldLinkedList(before, events);
        expect(after.nodes.map((n) => n.value)).toEqual(l.keysInOrder());
        expect(l.keysInOrder()).toEqual([40, 20, 10]);
        // every prefix renderable (ids stay unique through the unlink)
        for (let f = 0; f <= events.length; f++) {
          const ids = foldLinkedList(before, events.slice(0, f)).nodes.map((n) => n.id);
          expect(new Set(ids).size).toBe(ids.length);
        }
      });

      it('deleting an absent key leaves the model unchanged', () => {
        const l = List.fromKeys([1, 2, 3]);
        const before = linkedModel(l.keysInOrder());
        const events: LinkedListEvent[] = [];
        l.delete(99, (e) => events.push(e));
        expect(foldLinkedList(before, events).nodes.map((n) => n.value)).toEqual(l.keysInOrder());
      });
    });
  }
});
