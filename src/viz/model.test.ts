import { describe, it, expect } from 'vitest';
import { DynArrayF64 } from '../structures/dynArray';
import { HashSetF64 } from '../structures/hashSet';
import { SortedArrayF64 } from '../structures/sortedArray';
import { SinglyLinkedListF64, DoublyLinkedListF64 } from '../structures/linkedList';
import { BstF64, type BstShape } from '../structures/bst';
import { AvlF64, type AvlShape } from '../structures/avl';
import { MinHeapF64 } from '../structures/heap';
import { TrieStr, type TrieShape } from '../structures/trie';
import type { ArrayEvent, HashSetEvent, SortedArrayEvent, LinkedListEvent, BstEvent, AvlEvent, HeapEvent, TrieEvent } from './events';
import {
  arrayModel, foldArray, hashModel, foldHash, isHole, type ArrayModel, type HashModel,
  foldSortedArray, linkedModel, foldLinkedList,
  bstModel, foldBst, type BstDisplayNode,
  avlModel, foldAvl, type AvlDisplayNode,
  heapModel, foldHeap,
  trieModel, foldTrie, type TrieModel, type TrieDisplayNode,
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

describe('bst fold mirrors the structure', () => {
  // The BST fold MUST be checked against the full nested {value,left,right} shape,
  // NOT keysInOrder(): in-order traversal is shape-invariant (a right-chain and a
  // balanced tree can share an in-order), so a keys-only assertion would pass
  // while proving nothing about which *side* the reducer attached a node. This
  // serializer strips the animation ids so the structure's BstShape compares deep.
  const shapeOfModel = (n: BstDisplayNode | null): BstShape | null =>
    n === null ? null : { value: n.value, left: shapeOfModel(n.left), right: shapeOfModel(n.right) };
  const ids = (n: BstDisplayNode | null): number[] =>
    n === null ? [] : [n.id, ...ids(n.left), ...ids(n.right)];

  /** Capture before-state, run the op with a tracer, fold, and return the pieces —
   * the assertions compare the fold's shape to the structure's actual post-op shape. */
  const runFold = (build: number[], op: (t: BstF64, push: (e: BstEvent) => void) => void) => {
    const t = BstF64.fromKeys(build);
    const before = bstModel(t.snapshot());
    const events: BstEvent[] = [];
    op(t, (e) => events.push(e));
    return { t, before, events };
  };

  it('a search stream leaves the tree shape unchanged', () => {
    const { t, before, events } = runFold([50, 30, 70, 20, 40], (s, push) => s.search(40, push));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual(t.snapshot());
  });

  it('an insert folds to the structure’s post-insert shape (not just its keys)', () => {
    const { t, before, events } = runFold([50, 30, 70], (s, push) => s.insert(40, push));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual(t.snapshot());
  });

  it('inserting into an empty tree seeds the root (path [])', () => {
    const t = new BstF64();
    const before = bstModel(t.snapshot()); // null root
    const events: BstEvent[] = [];
    t.insert(42, (e) => events.push(e));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual({ value: 42, left: null, right: null });
  });

  it('a duplicate insert attaches on the RIGHT — shape catches what in-order cannot', () => {
    const { t, before, events } = runFold([50, 30], (s, push) => s.insert(50, push));
    const after = foldBst(before, events);
    // in-order would be [30,50,50] regardless of side; the shape pins the right child.
    expect(shapeOfModel(after.root)).toEqual(t.snapshot());
    expect(after.root!.right).toEqual(expect.objectContaining({ value: 50 }));
  });

  it('a leaf delete folds to the structure’s post-delete shape', () => {
    const { t, before, events } = runFold([50, 30, 70, 20], (s, push) => s.delete(20, push));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual(t.snapshot());
  });

  it('a one-child delete (left child) folds to the structure’s shape', () => {
    const { t, before, events } = runFold([50, 30, 20], (s, push) => s.delete(30, push));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual(t.snapshot());
  });

  it('a two-child delete (successor copy-up) folds to the structure’s shape', () => {
    const { t, before, events } = runFold([50, 30, 70, 60, 80], (s, push) => s.delete(70, push));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual(t.snapshot());
  });

  it('deleting the root down to empty folds to a null root', () => {
    const { t, before, events } = runFold([42], (s, push) => s.delete(42, push));
    expect(foldBst(before, events).root).toBeNull();
    expect(t.snapshot()).toBeNull();
  });

  it('deleting an absent key leaves the shape unchanged', () => {
    const { t, before, events } = runFold([50, 30, 70], (s, push) => s.delete(99, push));
    expect(shapeOfModel(foldBst(before, events).root)).toEqual(t.snapshot());
  });

  it('every frame of a two-child delete is renderable (unique node ids each prefix)', () => {
    const { before, events } = runFold([50, 30, 70, 60, 80], (s, push) => s.delete(50, push));
    for (let f = 0; f <= events.length; f++) {
      const frameIds = ids(foldBst(before, events.slice(0, f)).root);
      expect(new Set(frameIds).size).toBe(frameIds.length);
    }
  });

  it('every frame of an insert is renderable (unique node ids each prefix)', () => {
    const { before, events } = runFold([50, 30, 70, 20, 40], (s, push) => s.insert(35, push));
    for (let f = 0; f <= events.length; f++) {
      const frameIds = ids(foldBst(before, events.slice(0, f)).root);
      expect(new Set(frameIds).size).toBe(frameIds.length);
    }
  });
});

describe('avl fold mirrors the structure (including rotations)', () => {
  // Like the BST, the AVL fold is checked against the full nested shape — but here
  // the rotate reducer must reproduce the *rebalanced* shape exactly, which keys
  // alone (shape-invariant under in-order) could never catch.
  const shapeOfModel = (n: AvlDisplayNode | null): AvlShape | null =>
    n === null ? null : { value: n.value, left: shapeOfModel(n.left), right: shapeOfModel(n.right) };
  const ids = (n: AvlDisplayNode | null): number[] =>
    n === null ? [] : [n.id, ...ids(n.left), ...ids(n.right)];

  const runFold = (build: number[], op: (t: AvlF64, push: (e: AvlEvent) => void) => void) => {
    const t = AvlF64.fromKeys(build);
    const before = avlModel(t.snapshot());
    const events: AvlEvent[] = [];
    op(t, (e) => events.push(e));
    return { t, before, events };
  };

  it('a search stream leaves the tree shape unchanged', () => {
    const { t, before, events } = runFold([50, 30, 70, 20, 40], (s, push) => s.search(40, push));
    expect(shapeOfModel(foldAvl(before, events).root)).toEqual(t.snapshot());
  });

  it('an LL insert folds to the rebalanced shape (single rotation)', () => {
    const { t, before, events } = runFold([30, 20], (s, push) => s.insert(10, push));
    expect(shapeOfModel(foldAvl(before, events).root)).toEqual(t.snapshot());
    expect(t.snapshot()!.value).toBe(20); // rotated
  });

  it('an LR insert folds to the rebalanced shape (double rotation)', () => {
    const { t, before, events } = runFold([30, 10], (s, push) => s.insert(20, push));
    expect(shapeOfModel(foldAvl(before, events).root)).toEqual(t.snapshot());
    expect(t.snapshot()!.value).toBe(20);
  });

  it('a sorted-run insert (cascading rotations) folds to the structure', () => {
    const { t, before, events } = runFold([10, 20, 30, 40, 50], (s, push) => s.insert(60, push));
    expect(shapeOfModel(foldAvl(before, events).root)).toEqual(t.snapshot());
  });

  it('a two-child delete that rebalances folds to the structure', () => {
    const { t, before, events } = runFold([50, 30, 70, 20, 40, 60, 80, 10], (s, push) => s.delete(30, push));
    expect(shapeOfModel(foldAvl(before, events).root)).toEqual(t.snapshot());
  });

  it('deleting an absent key leaves the shape unchanged', () => {
    const { t, before, events } = runFold([50, 30, 70], (s, push) => s.delete(99, push));
    expect(shapeOfModel(foldAvl(before, events).root)).toEqual(t.snapshot());
  });

  it('every frame of a rotating insert is renderable (unique node ids each prefix)', () => {
    const { before, events } = runFold([10, 20, 30, 40, 50], (s, push) => s.insert(60, push));
    for (let f = 0; f <= events.length; f++) {
      const frameIds = ids(foldAvl(before, events.slice(0, f)).root);
      expect(new Set(frameIds).size).toBe(frameIds.length);
    }
  });

  it('every frame of a rebalancing delete is renderable', () => {
    const { before, events } = runFold([50, 30, 70, 20, 40, 60, 80, 10], (s, push) => s.delete(70, push));
    for (let f = 0; f <= events.length; f++) {
      const frameIds = ids(foldAvl(before, events.slice(0, f)).root);
      expect(new Set(frameIds).size).toBe(frameIds.length);
    }
  });
});

describe('heap fold mirrors the structure', () => {
  const values = (m: ArrayModel) => m.cells.map((c) => (isHole(c) ? '·' : c.value));

  const runFold = (build: number[], op: (h: MinHeapF64, push: (e: HeapEvent) => void) => void) => {
    const h = MinHeapF64.fromKeys(build);
    const before = heapModel(h.toArray());
    const events: HeapEvent[] = [];
    op(h, (e) => events.push(e));
    return { h, before, events };
  };

  it('an insert (sift-up) folds to the structure’s backing array', () => {
    const { h, before, events } = runFold([20, 30, 40], (s, push) => s.insert(5, push));
    expect(values(foldHeap(before, events))).toEqual(h.toArray());
    expect(h.toArray()[0]).toBe(5);
  });

  it('an extract-min (sift-down) folds to the structure’s array, ids distinct each frame', () => {
    const { h, before, events } = runFold([50, 30, 70, 20, 40, 60, 10], (s, push) => s.extractMin(push));
    const after = foldHeap(before, events);
    expect(values(after)).toEqual(h.toArray());
    // every prefix renderable: the moved-up cell and swaps keep ids unique.
    for (let f = 0; f <= events.length; f++) {
      const idsAt = foldHeap(before, events.slice(0, f)).cells.map((c) => c.id);
      expect(new Set(idsAt).size).toBe(idsAt.length);
    }
  });

  it('extract-min down to empty folds to an empty array', () => {
    const { h, before, events } = runFold([42], (s, push) => s.extractMin(push));
    expect(foldHeap(before, events).cells).toEqual([]);
    expect(h.toArray()).toEqual([]);
  });

  it('a search leaves the model unchanged', () => {
    const { h, before, events } = runFold([50, 30, 70, 20], (s, push) => s.search(70, push));
    expect(values(foldHeap(before, events))).toEqual(h.toArray());
  });

  it('repeated extract-min folds correctly at each step', () => {
    const h = MinHeapF64.fromKeys([5, 3, 8, 1, 9, 2, 7]);
    while (h.size > 0) {
      const before = heapModel(h.toArray());
      const events: HeapEvent[] = [];
      h.extractMin((e) => events.push(e));
      expect(values(foldHeap(before, events))).toEqual(h.toArray());
    }
  });
});

describe('trie fold mirrors the structure', () => {
  /** The folded model with its animation ids stripped — directly comparable to the
   * structure's own `snapshot()`. Shape equality is the strongest statement
   * available: it pins the key set, the *node* set, and the byte ordering at once.
   * The key set alone would not: a reducer that dropped or misordered prune events
   * still answers every membership question correctly while the folded tree carries
   * litter nodes the real structure has already reclaimed. */
  const shapeOf = (n: TrieDisplayNode): TrieShape => ({
    byte: n.byte,
    terminal: n.terminal,
    children: n.children.map(shapeOf),
  });

  const nodeCount = (n: TrieDisplayNode): number =>
    1 + n.children.reduce((acc, c) => acc + nodeCount(c), 0);

  const ids = (n: TrieDisplayNode): number[] => [n.id, ...n.children.flatMap(ids)];

  const runFold = (build: string[], op: (t: TrieStr, push: (e: TrieEvent) => void) => void) => {
    const t = TrieStr.fromKeys(build);
    const before = trieModel(t.snapshot());
    const events: TrieEvent[] = [];
    op(t, (e) => events.push(e));
    return { t, before, events };
  };

  /** Fold the whole stream and assert the picture *is* the structure — shape, node
   * count, key set — then assert every intermediate frame is renderable (ids stay
   * unique, which is what a React key collision would break). */
  const expectMirrors = (t: TrieStr, before: TrieModel, events: readonly TrieEvent[]) => {
    const after = foldTrie(before, events);
    expect(shapeOf(after.root)).toEqual(t.snapshot());
    expect(nodeCount(after.root)).toBe(t.nodeCount());
    for (let f = 0; f <= events.length; f++) {
      const frameIds = ids(foldTrie(before, events.slice(0, f)).root);
      expect(new Set(frameIds).size).toBe(frameIds.length);
    }
  };

  const CASES: [string, string[], (t: TrieStr, push: (e: TrieEvent) => void) => void][] = [
    ['search leaves the trie unchanged', ['car', 'cat'], (t, p) => t.search('car', p)],
    ['search that falls off the tree', ['car'], (t, p) => t.search('zebra', p)],
    ['search a proper prefix (full depth, still absent)', ['stack'], (t, p) => t.search('stac', p)],
    ['insert into an empty trie', [], (t, p) => t.insert('car', p)],
    ['insert a whole new branch', ['car'], (t, p) => t.insert('dog', p)],
    ['insert extending a shared prefix', ['car'], (t, p) => t.insert('cart', p)],
    ['insert a duplicate (nothing created)', ['car'], (t, p) => t.insert('car', p)],
    ['insert a multi-byte key', ['car'], (t, p) => t.insert('café', p)],
    ['delete that prunes one node', ['car', 'cart', 'cat'], (t, p) => t.delete('cart', p)],
    ['delete that prunes a whole chain', ['car', 'dog'], (t, p) => t.delete('dog', p)],
    ['delete a proper prefix (prunes nothing)', ['car', 'cart'], (t, p) => t.delete('car', p)],
    ['delete an absent key', ['car', 'cat'], (t, p) => t.delete('cow', p)],
    ['delete a multi-byte key', ['café', 'car'], (t, p) => t.delete('café', p)],
    ['delete down to empty', ['dog'], (t, p) => t.delete('dog', p)],
  ];

  it.each(CASES)('%s', (_label, build, op) => {
    const { t, before, events } = runFold(build, op);
    expectMirrors(t, before, events);
  });

  it('litter would be invisible to the key set — so the node count is the assertion', () => {
    // A guard on the guard: after deleting `dog` from {car, dog}, the key set is
    // {car} whether or not the three `dog` nodes were pruned. Only the node count
    // separates the two, which is why `expectMirrors` checks it.
    const { t, before, events } = runFold(['car', 'dog'], (s, p) => s.delete('dog', p));
    const after = foldTrie(before, events);
    expect(nodeCount(after.root)).toBe(t.nodeCount());
    expect(nodeCount(after.root)).toBe(nodeCount(before.root) - 3); // d, o, g reclaimed
  });

  it('a churn pair returns the picture to exactly the shape it started in', () => {
    // The measurement's precondition (docs/METHODOLOGY.md §2.5), folded: an
    // insert+delete of a derived key nets zero nodes on screen too.
    const t = TrieStr.fromKeys(['one', 'two', 'three']);
    const start = trieModel(t.snapshot());
    const events: TrieEvent[] = [];
    const push = (e: TrieEvent) => events.push(e);
    t.insert('thref', push);
    t.delete('thref', push);
    const after = foldTrie(start, events);
    expect(shapeOf(after.root)).toEqual(shapeOf(start.root));
    expect(shapeOf(after.root)).toEqual(t.snapshot());
  });
});
