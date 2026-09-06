/**
 * Teaching implementation of the **trie** (prefix tree) over string keys
 * (docs/PLAN.md §8, "Specialized" family) — the TypeScript twin of the Rust bench
 * impl (bench-engine/src/structures/trie.rs), and the third string-key structure
 * beside {@link DynArrayStr} and {@link HashSetStr}.
 *
 * A trie stores keys as *paths*: one node per byte of the key, so every operation
 * costs the length of the key it is given and nothing else. That makes it **O(L)
 * in the key and O(1) in the number of stored keys** — the same flat line as the
 * hash set, arrived at without hashing anything (docs/METHODOLOGY.md §2.5).
 *
 * **Keys are walked as UTF-8 bytes**, not JS UTF-16 code units, because that is
 * what the Rust twin walks and what the marshal layer ships (docs/PLAN.md §4.2).
 * A multi-byte character therefore occupies several levels, and the conformance
 * corpus (docs/PLAN.md §12) pins both languages to the same char-step counts.
 *
 * **Cost metric — char-steps:** one for entering the root, plus one per key byte
 * whose child lookup is attempted. A stored key of L bytes costs `1 + L`; an
 * absent key costs `1 + d`, where d is the depth at which the walk fell off the
 * tree. The within-node child lookup is bounded by the alphabet and deliberately
 * not counted — the metric name says what is counted.
 *
 * Semantics: a **set** — duplicates collapse on insert. `delete` clears the
 * terminal flag and prunes back every node left neither terminal nor a parent, so
 * an insert+delete pair returns the trie to exactly its previous shape.
 */

import type { SearchResult } from './dynArray';

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** One node: children by byte, plus the flag saying a stored key ends here. */
interface TrieNode {
  readonly children: Map<number, TrieNode>;
  terminal: boolean;
}

function node(): TrieNode {
  return { children: new Map(), terminal: false };
}

export class TrieStr {
  private root: TrieNode = node();
  private count = 0;

  /** Build from a key sequence by inserting each in order (duplicates collapse). */
  static fromKeys(keys: readonly string[]): TrieStr {
    const t = new TrieStr();
    for (const k of keys) t.insert(k);
    return t;
  }

  /** Number of distinct stored keys. */
  get size(): number {
    return this.count;
  }

  /** Walk the key's bytes, creating the nodes that are missing; mark the last terminal. */
  insert(key: string): void {
    let cur = this.root;
    for (const b of utf8.encode(key)) {
      let next = cur.children.get(b);
      if (next === undefined) {
        next = node();
        cur.children.set(b, next);
      }
      cur = next;
    }
    if (!cur.terminal) {
      cur.terminal = true;
      this.count += 1;
    }
  }

  /**
   * Walk the key's bytes and report membership plus the cost-metric count: 1 (the
   * root) plus one per byte looked up — identical to the Rust impl's
   * `search_one_counted`. A walk that falls off the tree stops there, which is why
   * an absent key sharing no prefix is the trie's cheapest case and one derived by
   * changing a stored key's last character is its dearest.
   */
  search(target: string): SearchResult {
    let ops = 1; // entering the root
    let cur: TrieNode | undefined = this.root;
    for (const b of utf8.encode(target)) {
      ops += 1; // one child lookup
      cur = cur.children.get(b);
      if (cur === undefined) return { found: false, ops };
    }
    return { found: cur.terminal, ops };
  }

  /**
   * Remove `target`, pruning every node the removal leaves neither terminal nor a
   * parent. Returns whether a key was removed, plus the same char-step count a
   * search over the key would cost.
   */
  delete(target: string): SearchResult {
    const counter = { ops: 1 }; // entering the root
    const removed = this.removeFrom(this.root, utf8.encode(target), 0, counter);
    if (removed) this.count -= 1;
    return { found: removed, ops: counter.ops };
  }

  private removeFrom(
    cur: TrieNode,
    key: Uint8Array,
    i: number,
    counter: { ops: number },
  ): boolean {
    if (i === key.length) {
      if (!cur.terminal) return false;
      cur.terminal = false;
      return true;
    }
    counter.ops += 1; // one child lookup
    const child = cur.children.get(key[i]);
    if (child === undefined) return false;
    const removed = this.removeFrom(child, key, i + 1, counter);
    if (removed && !child.terminal && child.children.size === 0) {
      cur.children.delete(key[i]);
    }
    return removed;
  }

  /**
   * Keys in **lexicographic byte order** — depth-first over children sorted by
   * byte. This is the trie's iteration order and it is free; the hash set has no
   * order at all and the array has only insertion order.
   */
  keysInOrder(): string[] {
    const out: string[] = [];
    const prefix: number[] = [];
    const walk = (cur: TrieNode): void => {
      if (cur.terminal) out.push(fromUtf8.decode(new Uint8Array(prefix)));
      for (const b of [...cur.children.keys()].sort((x, y) => x - y)) {
        prefix.push(b);
        walk(cur.children.get(b)!);
        prefix.pop();
      }
    };
    walk(this.root);
    return out;
  }

  /**
   * Live node count including the root — a test hook. It is what makes the churn-key
   * decision checkable: the workload's derived key (a stored key with its last
   * character changed) allocates exactly one node per insert, while a key sharing no
   * prefix allocates one per byte (docs/METHODOLOGY.md §2.5).
   */
  nodeCount(): number {
    const walk = (cur: TrieNode): number => {
      let n = 1;
      for (const child of cur.children.values()) n += walk(child);
      return n;
    };
    return walk(this.root);
  }
}
