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

import type { Tracer, TrieEvent } from '../viz/events';
import type { SearchResult } from './dynArray';

/** Result of an insert: the char-steps walked to place the key (`1 + L`, always —
 * an insert walks the whole key whether or not the nodes already existed). Mirrors
 * the Rust twin's `insert_generic::<true>` count. */
export interface InsertResult {
  readonly ops: number;
}

/** An immutable snapshot of the trie's shape — the byte that reaches a node (null
 * at the root), its terminal flag, and its children in ascending byte order — used
 * to seed the renderer's display model (`src/viz/model.ts`). Carries no animation
 * ids; the model assigns those. */
export interface TrieShape {
  /** The byte labelling the edge into this node; `null` only at the root. */
  readonly byte: number | null;
  readonly terminal: boolean;
  readonly children: readonly TrieShape[];
}

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

  /**
   * Walk the key's bytes, creating the nodes that are missing; mark the last
   * terminal. Costs `1 + L` char-steps unconditionally — unlike search and delete,
   * an insert never falls off the tree, it extends it. Duplicates collapse (set
   * semantics), and a duplicate insert still walks and still costs.
   */
  insert(key: string, trace?: Tracer<TrieEvent>): InsertResult {
    let ops = 1; // entering the root
    trace?.({ kind: 'trie.enterRoot', key });
    const path: number[] = [];
    let cur = this.root;
    for (const b of utf8.encode(key)) {
      ops += 1; // one child lookup
      let next = cur.children.get(b);
      // A miss here is the ordinary case: the next event creates the child and the
      // walk carries on, which is not what a miss means on a search or a delete.
      trace?.({ kind: 'trie.step', path: path.slice(), byte: b, hit: next !== undefined, creates: next === undefined });
      path.push(b);
      if (next === undefined) {
        next = node();
        cur.children.set(b, next);
        trace?.({ kind: 'trie.create', path: path.slice() });
      }
      cur = next;
    }
    const alreadyPresent = cur.terminal;
    if (!cur.terminal) {
      cur.terminal = true;
      this.count += 1;
    }
    trace?.({ kind: 'trie.markTerminal', path, alreadyPresent });
    return { ops };
  }

  /**
   * Walk the key's bytes and report membership plus the cost-metric count: 1 (the
   * root) plus one per byte looked up — identical to the Rust impl's
   * `search_one_counted`. A walk that falls off the tree stops there, which is why
   * an absent key sharing no prefix is the trie's cheapest case and one derived by
   * changing a stored key's last character is its dearest.
   */
  search(target: string, trace?: Tracer<TrieEvent>): SearchResult {
    let ops = 1; // entering the root
    trace?.({ kind: 'trie.enterRoot', key: target });
    const path: number[] = [];
    let cur: TrieNode | undefined = this.root;
    for (const b of utf8.encode(target)) {
      ops += 1; // one child lookup
      const next: TrieNode | undefined = cur.children.get(b);
      trace?.({ kind: 'trie.step', path: path.slice(), byte: b, hit: next !== undefined, creates: false });
      if (next === undefined) {
        trace?.({ kind: 'trie.result', found: false });
        return { found: false, ops };
      }
      path.push(b);
      cur = next;
    }
    // Reaching the last node is not finding a key: a *proper prefix* of a stored
    // key walks its full depth and still reports absent (`stac` under `stack`).
    trace?.({ kind: 'trie.result', found: cur.terminal });
    return { found: cur.terminal, ops };
  }

  /**
   * Remove `target`, pruning every node the removal leaves neither terminal nor a
   * parent. Returns whether a key was removed, plus the same char-step count a
   * search over the key would cost.
   */
  delete(target: string, trace?: Tracer<TrieEvent>): SearchResult {
    const counter = { ops: 1 }; // entering the root
    trace?.({ kind: 'trie.enterRoot', key: target });
    const bytes = utf8.encode(target);
    const removed = this.removeFrom(this.root, bytes, 0, counter, trace);
    if (removed) this.count -= 1;
    trace?.({ kind: 'trie.result', found: removed });
    return { found: removed, ops: counter.ops };
  }

  /** The prune unwinds on the way *back up*, so `trie.prune` events are emitted
   * deepest-first and each one removes a node that is by then a childless
   * non-terminal leaf — never a subtree. The display reducer relies on that. */
  private removeFrom(
    cur: TrieNode,
    key: Uint8Array,
    i: number,
    counter: { ops: number },
    trace?: Tracer<TrieEvent>,
  ): boolean {
    if (i === key.length) {
      if (!cur.terminal) return false;
      cur.terminal = false;
      trace?.({ kind: 'trie.clearTerminal', path: [...key] });
      return true;
    }
    counter.ops += 1; // one child lookup
    const child = cur.children.get(key[i]);
    trace?.({ kind: 'trie.step', path: [...key.subarray(0, i)], byte: key[i], hit: child !== undefined, creates: false });
    if (child === undefined) return false;
    const removed = this.removeFrom(child, key, i + 1, counter, trace);
    if (removed && !child.terminal && child.children.size === 0) {
      cur.children.delete(key[i]);
      trace?.({ kind: 'trie.prune', path: [...key.subarray(0, i + 1)] });
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
   * An immutable shape snapshot for the renderer's display model, children in
   * ascending byte order (the same order {@link keysInOrder} walks).
   */
  snapshot(): TrieShape {
    const walk = (cur: TrieNode, byte: number | null): TrieShape => ({
      byte,
      terminal: cur.terminal,
      children: [...cur.children.keys()]
        .sort((x, y) => x - y)
        .map((b) => walk(cur.children.get(b)!, b)),
    });
    return walk(this.root, null);
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
