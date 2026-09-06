//! Prefix tree (**trie**) over **string** keys (docs/PLAN.md §8, "Specialized"
//! family) — the third string bench twin, beside [`super::dyn_array_str::ArrayStr`]
//! and [`super::hash_set_str::HashSetStr`].
//!
//! The trie is the structure whose textbook cost does not mention `n` at all:
//! every operation walks the key one byte at a time, so it is **O(L)** in the
//! key's length and **O(1) in the number of stored keys**. That is exactly the
//! second cost axis the string section exists to show (docs/METHODOLOGY.md §2.5)
//! — and it makes the trie the honest foil to the string hash set, which is also
//! flat in n but for an entirely different reason: the hash set reads every byte
//! of the key *once* to compute one hash and then jumps; the trie never hashes
//! and instead takes one branch per byte, stopping the instant a byte has no
//! child. Two flat lines, two mechanisms, distinguishable only by their constant
//! and by how they respond to the key-length control.
//!
//! **Structure.** A node holds its children as a `Vec<(u8, Box<TrieNode>)>` kept
//! **sorted by byte**, so a child lookup is a binary search over at most 256
//! entries — bounded, and therefore a constant factor rather than a term in the
//! cost. Keys are walked as their UTF-8 bytes (the marshal layout ships UTF-8,
//! docs/PLAN.md §4.2), so a multi-byte character simply occupies several levels.
//!
//! **Cost metric — char-steps.** One step for entering the root, plus one per key
//! byte whose child lookup is attempted. A stored key of `L` bytes therefore
//! costs `1 + L`; an absent key costs `1 + d` where `d` is the depth at which the
//! walk fell off the tree. The within-node binary search is deliberately *not*
//! counted: it is bounded by the alphabet, and counting it would let a
//! representation detail masquerade as complexity. The metric name says what is
//! counted.
//!
//! **Set semantics**, like the hash set: a key is present or not, duplicates
//! collapse on insert. `delete` clears the terminal flag and then **prunes** every
//! node that is left neither terminal nor a parent — without the prune, an
//! insert+delete churn pair would leave litter behind and the structure would
//! grow under a measurement that is supposed to hold size fixed.

use super::decode_keys;
use wasm_bindgen::prelude::*;

/// One node: the terminal flag plus children sorted by byte.
#[derive(Default)]
struct TrieNode {
    /// `(byte, child)` pairs in ascending byte order — binary-searched on lookup.
    children: Vec<(u8, Box<TrieNode>)>,
    /// True when a stored key ends here.
    terminal: bool,
}

impl TrieNode {
    #[inline]
    fn child(&self, b: u8) -> Option<&TrieNode> {
        self.children
            .binary_search_by_key(&b, |(k, _)| *k)
            .ok()
            .map(|i| self.children[i].1.as_ref())
    }

    /// Nothing ends here and nothing hangs off here — safe to unlink.
    #[inline]
    fn is_prunable(&self) -> bool {
        !self.terminal && self.children.is_empty()
    }

    fn count_nodes(&self) -> usize {
        1 + self
            .children
            .iter()
            .map(|(_, c)| c.count_nodes())
            .sum::<usize>()
    }

    /// Depth-first over children in byte order — the trie's iteration order is
    /// lexicographic by UTF-8 byte, which is a property it has and the hash set
    /// does not.
    fn collect(&self, prefix: &mut Vec<u8>, out: &mut Vec<String>) {
        if self.terminal {
            out.push(String::from_utf8_lossy(prefix).into_owned());
        }
        for (b, child) in &self.children {
            prefix.push(*b);
            child.collect(prefix, out);
            prefix.pop();
        }
    }
}

/// A set of distinct string keys stored as a prefix tree.
#[wasm_bindgen]
pub struct TrieStr {
    root: TrieNode,
    len: usize,
    probes: Vec<String>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3) — set absent.
    churn_key: String,
    /// Distinct keys captured at build time, in insertion order, so `teardown_all`
    /// can delete every key without walking the tree inside the timed region.
    teardown_keys: Vec<String>,
}

#[wasm_bindgen]
impl TrieStr {
    /// Build from the first `n` keys of an offsets+UTF-8-bytes marshal buffer
    /// (docs/PLAN.md §4.2). Building is untimed; search timing starts from the
    /// built trie (docs/PLAN.md §6.3).
    #[wasm_bindgen(constructor)]
    pub fn new(offsets: &[u32], bytes: &[u8], n: usize) -> TrieStr {
        let keys = decode_keys(offsets, bytes, n);
        let mut t = TrieStr::empty();
        for k in &keys {
            let before = t.len;
            let mut ops = 0u64;
            t.insert_generic::<false>(k, &mut ops);
            if t.len != before {
                t.teardown_keys.push(k.clone()); // distinct keys only
            }
        }
        t
    }

    /// Number of distinct stored keys.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Set the query workload (present + absent probe keys) from a marshal buffer.
    /// Untimed.
    pub fn set_probes(&mut self, offsets: &[u32], bytes: &[u8]) {
        self.probes = decode_keys(offsets, bytes, offsets.len().saturating_sub(1));
    }

    /// Timed hot path: `k` searches over the stored probes, no op-counting
    /// (`COUNT=false`). Returns the hit count to defeat dead-code elimination.
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.contains::<false>(&self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probes counting char-steps,
    /// total returned as a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for p in &self.probes {
            let _ = self.contains::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the trie so each
    /// insert is real and the matching delete restores size. Untimed.
    ///
    /// **Which absent key is a measurement decision here, not a detail.** The
    /// workload derives it from a stored key by changing its last character
    /// (`churnKeyFor` in `src/bench/stringWorkload.ts`), so it shares all but one
    /// byte of an existing path: the insert allocates exactly one node and the
    /// delete prunes exactly one, leaving the *walk* to dominate — the honest
    /// O(L) reading. A key sharing no prefix with the corpus would instead
    /// allocate a whole `L`-node branch on every pair and measure the allocator
    /// rather than the trie. Pinned by
    /// `tests::a_prefix_free_churn_key_allocates_a_whole_branch`.
    pub fn set_churn_key(&mut self, key: &str) {
        self.churn_key = key.to_owned();
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size
    /// stable at ≈ n (docs/PLAN.md §6.3). Returns the delete-hit count to defeat
    /// dead-code elimination. No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = std::mem::take(&mut self.churn_key);
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.insert_generic::<false>(&key, &mut ops);
            if self.remove_key::<false>(&key, &mut ops) {
                hits += 1;
            }
        }
        self.churn_key = key;
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: char-steps of a counted
    /// insert+delete. The pair nets zero size change.
    pub fn churn_counted(&mut self) -> f64 {
        let key = std::mem::take(&mut self.churn_key);
        let mut ops = 0u64;
        self.insert_generic::<true>(&key, &mut ops);
        let _ = self.remove_key::<true>(&key, &mut ops);
        self.churn_key = key;
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh trie of size `n` from empty by inserting each key in
    /// turn. Differencing this across sweep points yields per-insert cost near n
    /// (finite differences, docs/PLAN.md §6.3). Returns `len` to defeat DCE.
    pub fn build_insert_n(offsets: &[u32], bytes: &[u8], n: usize) -> u32 {
        let t = TrieStr::new(offsets, bytes, n);
        t.len as u32
    }

    /// Op-count for the cumulative build to size `n`: total char-steps of the
    /// per-insert walks.
    pub fn build_insert_counted(offsets: &[u32], bytes: &[u8], n: usize) -> f64 {
        let keys = decode_keys(offsets, bytes, n);
        let mut t = TrieStr::empty();
        let mut ops = 0u64;
        for k in &keys {
            t.insert_generic::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key, leaving the trie empty (docs/PLAN.md §6.3
    /// teardown). Built untimed by the caller via `new`; only this call is timed.
    /// Returns the delete count to defeat DCE.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        let order = std::mem::take(&mut self.teardown_keys);
        for k in &order {
            if self.remove_key::<false>(k, &mut ops) {
                count += 1;
            }
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total char-steps to delete every
    /// distinct key (Θ(n·L) — each delete walks its own key and nothing else).
    pub fn teardown_counted(offsets: &[u32], bytes: &[u8], n: usize) -> f64 {
        let mut t = TrieStr::new(offsets, bytes, n);
        let order = std::mem::take(&mut t.teardown_keys);
        let mut ops = 0u64;
        for k in &order {
            let _ = t.remove_key::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` trie, then tear it all down, in one
    /// self-contained call. Subtracting the `build_insert_n` time isolates the
    /// teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); the constructor's insert build cancels in the subtraction.
    pub fn build_then_teardown_n(offsets: &[u32], bytes: &[u8], n: usize) -> u32 {
        let mut t = TrieStr::new(offsets, bytes, n);
        t.teardown_all()
    }
}

impl TrieStr {
    fn empty() -> TrieStr {
        TrieStr {
            root: TrieNode::default(),
            len: 0,
            probes: Vec::new(),
            churn_key: String::new(),
            teardown_keys: Vec::new(),
        }
    }

    /// The one search algorithm, generic over counting. One char-step for the
    /// root, then one per byte whose child lookup is attempted — so a walk that
    /// falls off the tree early costs less, which is the whole mechanism.
    #[inline]
    fn contains<const COUNT: bool>(&self, target: &str, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // entering the root
        }
        let mut node = &self.root;
        for &b in target.as_bytes() {
            if COUNT {
                *ops += 1; // one child lookup
            }
            match node.child(b) {
                Some(next) => node = next,
                None => return false,
            }
        }
        node.terminal
    }

    /// The one insert algorithm, generic over counting. Walks the key's bytes,
    /// creating the nodes that are missing, and marks the last one terminal.
    /// Counts the same char-steps as a search over the same key.
    #[inline]
    fn insert_generic<const COUNT: bool>(&mut self, key: &str, ops: &mut u64) {
        if COUNT {
            *ops += 1; // entering the root
        }
        let mut node = &mut self.root;
        for &b in key.as_bytes() {
            if COUNT {
                *ops += 1; // one child lookup
            }
            let idx = match node.children.binary_search_by_key(&b, |(k, _)| *k) {
                Ok(i) => i,
                Err(i) => {
                    node.children.insert(i, (b, Box::new(TrieNode::default())));
                    i
                }
            };
            node = &mut node.children[idx].1;
        }
        if !node.terminal {
            node.terminal = true;
            self.len += 1;
        }
    }

    /// The one delete algorithm, generic over counting. Walks to the key's last
    /// node, clears its terminal flag, then unwinds pruning every node left
    /// neither terminal nor a parent. Returns whether a key was removed.
    #[inline]
    fn remove_key<const COUNT: bool>(&mut self, target: &str, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // entering the root
        }
        let removed = Self::remove_rec::<COUNT>(&mut self.root, target.as_bytes(), ops);
        if removed {
            self.len -= 1;
        }
        removed
    }

    fn remove_rec<const COUNT: bool>(node: &mut TrieNode, key: &[u8], ops: &mut u64) -> bool {
        let Some((&b, rest)) = key.split_first() else {
            if node.terminal {
                node.terminal = false;
                return true;
            }
            return false;
        };
        if COUNT {
            *ops += 1; // one child lookup
        }
        let Ok(idx) = node.children.binary_search_by_key(&b, |(k, _)| *k) else {
            return false;
        };
        let removed = Self::remove_rec::<COUNT>(&mut node.children[idx].1, rest, ops);
        if removed && node.children[idx].1.is_prunable() {
            node.children.remove(idx); // keep the byte order intact (no swap-remove)
        }
        removed
    }

    /// Test/conformance helper: membership + char-steps for one search.
    pub fn search_one_counted(&self, target: &str) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: delete `target`, returning `(removed, char-steps)`.
    /// Mutates the trie.
    pub fn delete_one_counted(&mut self, target: &str) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.remove_key::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Keys in **lexicographic byte order** — the trie's iteration order, and the
    /// one it gets for free where the hash set has none. A conformance hook
    /// (docs/PLAN.md §12); not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<String> {
        let mut out = Vec::with_capacity(self.len);
        let mut prefix = Vec::new();
        self.root.collect(&mut prefix, &mut out);
        out
    }

    /// Live node count including the root — the test hook that makes the churn-key
    /// decision checkable: the derived key allocates one node per pair, a
    /// prefix-free one allocates a whole branch.
    pub fn node_count(&self) -> usize {
        self.root.count_nodes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Marshal `keys` into the offsets+UTF-8 layout the constructor consumes —
    /// the test-side mirror of `src/data/marshal.ts`.
    fn marshal(keys: &[&str]) -> (Vec<u32>, Vec<u8>) {
        let mut offsets = vec![0u32];
        let mut bytes = Vec::new();
        for k in keys {
            bytes.extend_from_slice(k.as_bytes());
            offsets.push(bytes.len() as u32);
        }
        (offsets, bytes)
    }

    fn trie(keys: &[&str]) -> TrieStr {
        let (offsets, bytes) = marshal(keys);
        TrieStr::new(&offsets, &bytes, keys.len())
    }

    #[test]
    fn membership_is_correct() {
        let t = trie(&["one", "two", "three", "four", "five"]);
        assert!(t.search_one_counted("three").0);
        assert!(!t.search_one_counted("ninety-nine").0);
    }

    #[test]
    fn a_prefix_of_a_stored_key_is_not_itself_stored() {
        // The trie's one failure mode a scan cannot have: reaching the node is not
        // the same as the key ending there.
        let t = trie(&["stack", "stackoverflow"]);
        assert!(!t.search_one_counted("stac").0);
        assert!(t.search_one_counted("stack").0);
        assert!(t.search_one_counted("stackoverflow").0);
    }

    #[test]
    fn dedupes_on_insert() {
        let t = trie(&["seven", "seven", "seven", "eight"]);
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn builds_from_marshalled_offsets_including_empty_and_multibyte() {
        // Empty string (terminal at the root), accented + CJK keys whose bytes
        // occupy several levels, and a duplicate the set must collapse.
        let t = trie(&["", "a", "café", "日本", "a"]);
        assert_eq!(t.len(), 4);
        assert!(t.search_one_counted("").0);
        assert!(t.search_one_counted("café").0);
        assert!(t.search_one_counted("日本").0);
        assert!(!t.search_one_counted("cafe").0); // byte-exact: "cafe" ≠ "café"
        // "café" is 5 bytes, so its walk is 5 levels deep, not 4.
        assert_eq!(t.search_one_counted("café").1, 1 + 5);
    }

    #[test]
    fn char_steps_are_the_key_length_and_stop_where_the_walk_falls_off() {
        let t = trie(&["alpha", "alpine"]);
        // Present: root + one lookup per byte.
        assert_eq!(t.search_one_counted("alpha"), (true, 1 + 5));
        // Absent sharing four bytes ("alph"): falls off on the 5th lookup.
        assert_eq!(t.search_one_counted("alphx"), (false, 1 + 5));
        // Absent sharing nothing: falls off on the first lookup — the trie's
        // cheapest case, and the reason the shared probe workload matters.
        assert_eq!(t.search_one_counted("zebra"), (false, 1 + 1));
        // Cost tracks the key, never the number of stored keys.
        assert_eq!(t.search_one_counted("alpine").1, 1 + 6);
    }

    #[test]
    fn an_absent_probe_that_shares_no_prefix_bails_at_depth_one() {
        // Decision pin (docs/METHODOLOGY.md §2.5): the string workload derives its
        // absent probes from stored keys by changing the *last* character, which is
        // the trie's **deepest** absent case. A probe set of unrelated strings would
        // measure a different, much cheaper structure — so the probe set is a
        // property of the run, shared by all three string structures, not something
        // any one of them gets to choose.
        let t = trie(&["parachute", "paradigm", "paradox"]);
        let deep = t.search_one_counted("paradox").1; // present, full walk
        let derived = t.search_one_counted("paradoy").1; // last char changed
        let unrelated = t.search_one_counted("quixotic").1;
        assert_eq!(derived, deep, "a last-char mutation walks the full key");
        assert_eq!(unrelated, 2, "an unrelated key falls off at the first byte");
        assert!(derived > unrelated * 3);
    }

    #[test]
    fn a_prefix_free_churn_key_allocates_a_whole_branch() {
        // Decision pin, the trie's counterpart to the heap's drain test. The churn
        // key is derived from a stored key by changing its last character, so one
        // insert+delete pair allocates and frees exactly **one** node and the cost
        // is the walk. Swap in a key that shares no prefix and the same pair
        // allocates a node per byte — measuring the allocator, not the trie.
        let keys: Vec<String> = (0..64).map(|i| format!("key-{i:04}")).collect();
        let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
        let mut t = trie(&refs);
        let base = t.node_count();

        // Derived (what `churnKeyFor` produces): "key-0000" with its last byte changed.
        t.set_churn_key("key-000x");
        let mut ops = 0u64;
        t.insert_generic::<false>("key-000x", &mut ops);
        assert_eq!(t.node_count(), base + 1, "one new node, the differing byte");
        assert!(t.remove_key::<false>("key-000x", &mut ops));
        assert_eq!(t.node_count(), base, "the pair prunes back to where it started");

        // Prefix-free: eight bytes sharing nothing ⇒ eight new nodes per pair.
        t.insert_generic::<false>("zzzzzzzz", &mut ops);
        assert_eq!(t.node_count(), base + 8, "a whole branch, one node per byte");
        assert!(t.remove_key::<false>("zzzzzzzz", &mut ops));
        assert_eq!(t.node_count(), base);
    }

    #[test]
    fn delete_prunes_only_what_nothing_else_needs() {
        let mut t = trie(&["car", "cart", "cat"]);
        let with_all = t.node_count();
        // "cart" is a leaf beyond "car": deleting it prunes exactly one node.
        assert!(t.delete_one_counted("cart").0);
        assert_eq!(t.node_count(), with_all - 1);
        assert!(t.search_one_counted("car").0, "the shared prefix survives");
        // "car" is terminal but still a prefix of nothing now; deleting it frees
        // the 'r' node only, since "ca" is on "cat"'s path.
        assert!(t.delete_one_counted("car").0);
        assert_eq!(t.node_count(), with_all - 2);
        assert!(t.search_one_counted("cat").0);
        assert_eq!(t.len(), 1);
    }

    #[test]
    fn delete_of_an_absent_key_changes_nothing() {
        let mut t = trie(&["one", "two"]);
        let before = t.node_count();
        let (removed, ops) = t.delete_one_counted("onx");
        assert!(!removed && ops >= 1);
        assert_eq!(t.node_count(), before);
        assert_eq!(t.len(), 2);
        // A deeper absent key that is a *prefix* of a stored one: reaching the node
        // is not the same as removing a key.
        assert!(!t.delete_one_counted("on").0);
        assert_eq!(t.len(), 2);
    }

    #[test]
    fn iteration_is_lexicographic_by_byte() {
        let t = trie(&["pear", "apple", "apricot", "", "banana"]);
        assert_eq!(
            t.keys_in_order(),
            vec!["", "apple", "apricot", "banana", "pear"]
        );
    }

    #[test]
    fn search_n_counts_hits() {
        let mut t = trie(&["one", "two", "three"]);
        let (po, pb) = marshal(&["two", "zz"]);
        t.set_probes(&po, &pb);
        assert_eq!(t.search_n(4), 2); // [two,zz,two,zz] -> 2 hits
    }

    #[test]
    fn churn_holds_size_and_restores_membership() {
        let mut t = trie(&["one", "two", "three"]);
        t.set_churn_key("thref"); // absent, one byte off a stored key
        let nodes = t.node_count();
        t.churn_n(10);
        assert_eq!(t.len(), 3);
        assert_eq!(t.node_count(), nodes, "churn leaves no litter behind");
        assert!(!t.search_one_counted("thref").0);
        assert!(t.churn_counted() >= 2.0); // >= the two root entries
        assert_eq!(t.len(), 3); // churn_counted nets zero
        assert_eq!(t.node_count(), nodes);
    }

    #[test]
    fn build_and_teardown_round_trip() {
        let keys: Vec<String> = (0..50).map(|i| format!("k{i}")).collect();
        let refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
        let (offsets, bytes) = marshal(&refs);
        assert_eq!(TrieStr::build_insert_n(&offsets, &bytes, 50), 50);
        let build_ops = TrieStr::build_insert_counted(&offsets, &bytes, 50);
        assert!(build_ops >= 50.0); // >= one root entry per key

        let mut t = TrieStr::new(&offsets, &bytes, 50);
        assert_eq!(t.teardown_all(), 50);
        assert_eq!(t.len(), 0);
        assert_eq!(t.node_count(), 1, "teardown prunes back to a bare root");
        let teardown_ops = TrieStr::teardown_counted(&offsets, &bytes, 50);
        assert!(teardown_ops >= 50.0);
    }

    #[test]
    fn teardown_keys_are_distinct_despite_duplicates() {
        let mut t = trie(&["x", "x", "y", "x", "z"]);
        assert_eq!(t.len(), 3);
        assert_eq!(t.teardown_all(), 3); // not 5
        assert_eq!(t.len(), 0);
    }

    #[test]
    fn cost_is_flat_in_the_number_of_keys() {
        // The claim the whole structure exists to make, clock-free: the same key
        // costs the same number of char-steps in a trie of 100 keys and one of
        // 100,000. (The array's scan and the hash set's chain both move here.)
        let small: Vec<String> = (0..100).map(|i| format!("key-{i:06}")).collect();
        let large: Vec<String> = (0..100_000).map(|i| format!("key-{i:06}")).collect();
        let sr: Vec<&str> = small.iter().map(|s| s.as_str()).collect();
        let lr: Vec<&str> = large.iter().map(|s| s.as_str()).collect();
        let probe = "key-000042";
        assert_eq!(
            trie(&sr).search_one_counted(probe),
            trie(&lr).search_one_counted(probe)
        );
    }
}
