import { describe, it, expect } from 'vitest';
import { TrieStr } from './trie';

/**
 * Unit tests for the teaching trie (docs/PLAN.md §8, §12). Cross-language equality
 * with the Rust bench twin is `conformance-trie.test.ts`'s job; these pin the
 * behaviour that makes the *measurement* mean what the UI says it means — the
 * char-step metric, the prune on delete, and flatness in the number of keys.
 */
describe('TrieStr (teaching twin)', () => {
  it('answers membership, and does not confuse a prefix for a key', () => {
    const t = TrieStr.fromKeys(['stack', 'stackoverflow']);
    expect(t.search('stack').found).toBe(true);
    expect(t.search('stackoverflow').found).toBe(true);
    expect(t.search('stac').found).toBe(false); // reaching the node ≠ a key ends there
    expect(t.search('zebra').found).toBe(false);
  });

  it('collapses duplicates (set semantics, like the hash set)', () => {
    expect(TrieStr.fromKeys(['seven', 'seven', 'eight']).size).toBe(2);
  });

  it('counts char-steps as the root plus one per byte looked up', () => {
    const t = TrieStr.fromKeys(['alpha', 'alpine']);
    expect(t.search('alpha')).toEqual({ found: true, ops: 1 + 5 });
    expect(t.search('alpine')).toEqual({ found: true, ops: 1 + 6 });
    // Absent, sharing four bytes: falls off on the fifth lookup.
    expect(t.search('alphx')).toEqual({ found: false, ops: 1 + 5 });
    // Absent, sharing nothing: the trie's cheapest case.
    expect(t.search('zebra')).toEqual({ found: false, ops: 1 + 1 });
  });

  it('walks UTF-8 bytes, so a multi-byte character costs several levels', () => {
    const t = TrieStr.fromKeys(['', 'a', 'café', '日本']);
    expect(t.size).toBe(4);
    expect(t.search('').found).toBe(true); // terminal at the root
    expect(t.search('café')).toEqual({ found: true, ops: 1 + 5 }); // é is two bytes
    expect(t.search('日本')).toEqual({ found: true, ops: 1 + 6 }); // three bytes each
    expect(t.search('cafe').found).toBe(false); // byte-exact
  });

  it('is flat in the number of keys — the claim the structure exists to make', () => {
    const small = TrieStr.fromKeys(
      Array.from({ length: 100 }, (_, i) => `key-${String(i).padStart(6, '0')}`),
    );
    const large = TrieStr.fromKeys(
      Array.from({ length: 20_000 }, (_, i) => `key-${String(i).padStart(6, '0')}`),
    );
    expect(large.search('key-000042')).toEqual(small.search('key-000042'));
  });

  it('prunes on delete only what nothing else needs', () => {
    const t = TrieStr.fromKeys(['car', 'cart', 'cat']);
    const all = t.nodeCount();
    expect(t.delete('cart').found).toBe(true);
    expect(t.nodeCount()).toBe(all - 1); // just the 't'
    expect(t.search('car').found).toBe(true); // the shared prefix survives
    expect(t.delete('car').found).toBe(true);
    expect(t.nodeCount()).toBe(all - 2); // 'ca' is still on "cat"'s path
    expect(t.search('cat').found).toBe(true);
    expect(t.size).toBe(1);
  });

  it('leaves the trie untouched when the delete target is absent', () => {
    const t = TrieStr.fromKeys(['one', 'two']);
    const before = t.nodeCount();
    expect(t.delete('onx').found).toBe(false);
    expect(t.delete('on').found).toBe(false); // a prefix is not a key
    expect(t.nodeCount()).toBe(before);
    expect(t.size).toBe(2);
  });

  it('returns an insert+delete pair to exactly the shape it started in', () => {
    // The churn measurement's precondition: a pair must net zero, in size *and* in
    // nodes, or the structure would grow underneath a fixed-n measurement.
    const t = TrieStr.fromKeys(['one', 'two', 'three']);
    const nodes = t.nodeCount();
    for (let i = 0; i < 10; i++) {
      t.insert('thref');
      t.delete('thref');
    }
    expect(t.size).toBe(3);
    expect(t.nodeCount()).toBe(nodes);
  });

  it('allocates one node for a last-char-derived key and a whole branch for a prefix-free one', () => {
    // The churn-key decision, in the teaching twin (its Rust mirror is
    // `a_prefix_free_churn_key_allocates_a_whole_branch`). Which absent key the
    // workload picks changes what the churn curve is measuring.
    const t = TrieStr.fromKeys(
      Array.from({ length: 64 }, (_, i) => `key-${String(i).padStart(4, '0')}`),
    );
    const base = t.nodeCount();
    t.insert('key-000x');
    expect(t.nodeCount()).toBe(base + 1);
    t.delete('key-000x');
    expect(t.nodeCount()).toBe(base);
    t.insert('zzzzzzzz');
    expect(t.nodeCount()).toBe(base + 8); // one node per byte
    t.delete('zzzzzzzz');
    expect(t.nodeCount()).toBe(base);
  });

  it('iterates in lexicographic byte order — an order the hash set does not have', () => {
    const t = TrieStr.fromKeys(['pear', 'apple', 'apricot', '', 'banana']);
    expect(t.keysInOrder()).toEqual(['', 'apple', 'apricot', 'banana', 'pear']);
  });
});
