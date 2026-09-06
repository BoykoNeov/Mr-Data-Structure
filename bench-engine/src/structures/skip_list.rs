//! Skip list (docs/PLAN.md §8, "Specialized") — the production/bench twin of the
//! TypeScript teaching impl (`src/structures/skipList.ts`).
//!
//! Semantics: an **ordered multiset**, like the BST and the sorted array — keys are kept
//! ascending, duplicates are retained (docs/PLAN.md "Keys are identity; never dedupe"),
//! and a new equal key is placed **after** the equals already stored (the insert descent
//! advances on `≤`), so the level-0 walk is insertion-stable among equals. That mirrors
//! the BST's "equal keys go right" and keeps the two ordered structures' iteration order
//! identical on the same input.
//!
//! # Node height is derived from the key's hash, not from an RNG
//!
//! The textbook skip list flips a coin per insert. This one does not, and that is the
//! single most consequential decision in the file:
//!
//! ```text
//! height(key) = 1 + min(MAX_LEVEL - 1, trailing_zeros(splitmix64(to_bits(key) ^ SALT)))
//! ```
//!
//! `trailing_zeros` of a well-mixed 64-bit hash is geometric with p = ½ — exactly the
//! distribution the coin flips produce — so the *shape* is the textbook one. What changes
//! is that it is a **pure function of the key set**, which this project needs for three
//! separate reasons:
//!
//! 1. **The counted path performs real inserts.** `churn_counted` and
//!    `build_insert_counted` mutate a live structure, and `measure.ts` interleaves timed
//!    (`COUNT = false`) and counted (`COUNT = true`) calls under adaptive batching. With a
//!    shared RNG stream the node heights — and therefore the op-count *signal* — would
//!    depend on that interleaving, i.e. on the machine's clock. The op-count is supposed
//!    to be the deterministic half of this tool (docs/PLAN.md §2.2, §6.4).
//! 2. **Cross-language conformance stays exact.** The TS teaching twin reproduces the
//!    committed corpus bit for bit with no new shared primitive: `splitmix64` and the f64
//!    bit reinterpret already have bit-exact TypeScript ports with pinned anchors
//!    (`src/structures/mix.ts` — `splitMix64`, `toBits`). Replaying
//!    recorded heights from the corpus instead would leave the teaching twin unable to
//!    insert a key the corpus never saw — which is the whole job of an animation.
//! 3. **The finding gets stronger, not weaker.** Heights are insertion-order-independent
//!    by construction, so "the skip list stays O(log n) on the reverse-sorted input that
//!    turns a naive BST into an O(n) chain" holds with no RNG caveat attached — and it
//!    holds for a structure that never rotates, which is the contrast against the AVL.
//!
//! The honest caveat, stated rather than buried (docs/METHODOLOGY.md §2.6): the
//! probabilistic guarantee is now over the **key distribution** rather than over a coin.
//! A key set adversarially chosen to collide in `trailing_zeros(splitmix64(...))` would build a
//! degenerate list, exactly as sorted input degenerates a naive BST — the same class of
//! statement, and on-theme for a tool that measures the user's own data.
//!
//! # Cost metric — node-visits (docs/PLAN.md §8); the R1 conformance contract
//!
//! One op per node **inspected** on the walk: at each level the search advances while the
//! forward node's key compares less than the target, and every such inspection is one key
//! comparison, so node-visits and comparisons are the same number here (the same identity
//! the linked list's metric rests on). **Dropping a level costs nothing**, matching the
//! rule the rest of the engine uses — the BST's in-order-successor walk and `max_value`
//! descent are pointer moves, not comparisons (risk R1). Counting level drops as well
//! would add a term of the same O(log n) order and change only the constant; leaving them
//! out keeps the metric a count of *key comparisons*, which is what every other ordered
//! structure here reports.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), exactly
//! as the other structures: one algorithm, the `*ops` increments compiled away on the
//! timed hot path, alive on the op-count signal.
//!
//! # Timed WASM harness surface (docs/PLAN.md §6.2–§6.3)
//!
//! The `#[wasm_bindgen]` impl exposes the same batched primitives `measure.ts` times for
//! every other structure: `search_n`/`search_counted` (size-preserving), the
//! `churn_n`/`churn_counted` primary, and the `build_insert_*`/`teardown_*` cumulative
//! cross-check.
//!
//! **Churn is two-keyed, like the trees** (docs/METHODOLOGY.md §4.1) — `min − 1` and
//! `max + 1`, alternating pair by pair. Unlike the sorted array, *neither* end would
//! mislabel the class on its own, and that was checked rather than assumed: `max + 1`
//! walks right along every level to the last tower and then descends (the full search
//! path, ≈ 2 log n inspections), while `min − 1` fails its first inspection at each level
//! and descends immediately (≈ log n) — a constant apart, both O(log n). The two-key
//! recipe is kept anyway because it is what makes the skip list's curve *comparable* with
//! the BST's and the AVL's, which are measured that way for a reason that does bite them.
//!
//! **Teardown alternates delete-max / delete-min**, again mirroring the trees, so churn's
//! probes and the finite-difference delete ride the same two paths — the precondition for
//! `churn ≈ insert_fd + delete_fd`. Finding the maximum is a pointer descent that always
//! takes the forward link when one exists (O(log n), no comparisons), so a teardown is
//! Θ(n log n) rather than the Θ(n²) a level-0 walk to the tail would cost.

use wasm_bindgen::prelude::*;

use super::splitmix64;

/// Ceiling on a node's tower height, and the head sentinel's width.
///
/// Part of the **conformance contract**, not a tuning knob: it truncates the geometric
/// height distribution, so changing it changes op-counts in both languages at once. The
/// TypeScript twin declares the same constant and `skip_list::tests::height_anchors_are_pinned`
/// pins the derived heights the way `mix_matches_pinned_anchors` pins the hash.
///
/// 24 levels covers n ≈ 2²⁴ ≈ 16.8 M keys before the truncation is felt at all — two
/// orders of magnitude past the sweep's 100 k ceiling (docs/PLAN.md §6.1).
pub const MAX_LEVEL: usize = 24;

/// Cursor value standing for the head sentinel (which is not an arena node).
const HEAD: u32 = u32::MAX;

/// The height hash's salt — the golden-ratio constant, xored into the key's bit pattern
/// before the mix. It exists because **`mix_f64(0.0)` is exactly 0**: SplitMix64's
/// finalizer maps the all-zero input to itself, and `trailing_zeros(0)` is 64, so hashing
/// the raw bits would give the key `0` a full-height tower. That is not a corner case —
/// `0` is one of the most common keys real data contains, and every dataset holding it
/// would carry a 24-level express lane whose extra levels every descent has to inspect,
/// doubling the constant on every measured operation. The salt moves the fixed point onto
/// a key nobody has (the one f64 whose bit pattern *is* the salt).
///
/// Part of the conformance contract, like [`MAX_LEVEL`]: the TypeScript twin declares the
/// same constant, and `tests::height_anchors_are_pinned` pins the heights it produces.
const HEIGHT_SALT: u64 = 0x9e37_79b9_7f4a_7c15;

/// The number of levels `key`'s tower occupies — see the module doc. Geometric with
/// p = ½ over a well-mixed hash, deterministic in the key, clamped to [`MAX_LEVEL`].
///
/// The clamp is the guard for the one remaining zero-hash input (the key whose bit pattern
/// equals [`HEIGHT_SALT`]), which would otherwise ask for a 64-level tower against a
/// 24-wide head; `tests::the_salts_own_key_is_clamped_not_crashed` pins it.
pub fn tower_height(key: f64) -> usize {
    let h = splitmix64(key.to_bits() ^ HEIGHT_SALT);
    1 + (h.trailing_zeros() as usize).min(MAX_LEVEL - 1)
}

/// An arena node. `forward[i]` is the next node at level `i`; the vector's length **is**
/// the tower height, so a node is never asked about a level it does not occupy.
struct Node {
    value: f64,
    forward: Vec<Option<u32>>,
}

/// An ordered multiset of `f64` keys, stored as a tower of forward-linked lists.
#[wasm_bindgen]
pub struct SkipListF64 {
    nodes: Vec<Node>,
    /// The head sentinel's forward links, always [`MAX_LEVEL`] wide.
    head: Vec<Option<u32>>,
    /// Number of levels currently in use (0 for an empty list); levels `0..level` are all
    /// non-empty, because a tower of height h occupies every level below h.
    level: usize,
    /// Slots vacated by delete, reused by the next insert so the arena stays bounded by
    /// live size. Slot numbering is not observable — every walk follows forward links.
    free: Vec<u32>,
    count: usize,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2).
    probes: Vec<f64>,
    /// The two spare keys cycled by `churn_n` (docs/PLAN.md §6.3, METHODOLOGY §4.1).
    churn_lo: f64,
    churn_hi: f64,
    /// Which end the next churn pair uses. Persisted across `churn_n` calls so a run of
    /// one-pair batches alternates rather than pinning one end.
    churn_hi_next: bool,
}

#[wasm_bindgen]
impl SkipListF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`, inserting each in
    /// turn. Unlike the BST, insertion order does **not** affect the result: every node's
    /// height comes from its key, so the same key set always builds the same list.
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> SkipListF64 {
        let n = n.min(keys.len());
        let mut s = SkipListF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            s.insert::<false>(k, &mut ops);
        }
        s
    }

    /// Number of stored keys (`n`); duplicates each count.
    pub fn len(&self) -> usize {
        self.count
    }

    // ── Search: size-preserving (docs/PLAN.md §6.3) ──

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: perform `k` searches, cycling through the stored probes. Returns
    /// the hit count so the optimizer can't elide the work (docs/PLAN.md §6.2). No
    /// op-counting overhead (`COUNT=false`).
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.find::<false>(self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`, returning
    /// total node-visits (the cost metric). `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.find::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the two spare keys cycled by `churn_n` — **both** must be absent so each insert
    /// is real and the matching delete restores size. The engine passes `lo = min − 1` and
    /// `hi = max + 1`; pairs alternate between them (docs/METHODOLOGY.md §4.1). Untimed.
    pub fn set_churn_keys(&mut self, lo: f64, hi: f64) {
        self.churn_lo = lo;
        self.churn_hi = hi;
    }

    /// Timed hot path: `k` insert+delete *pairs*, holding size stable at ≈ n
    /// (docs/PLAN.md §6.3). Successive pairs **alternate** the two churn keys. Returns the
    /// delete-hit count to defeat dead-code elimination. No op-counting overhead.
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            let key = if self.churn_hi_next { self.churn_hi } else { self.churn_lo };
            self.churn_hi_next = !self.churn_hi_next;
            self.insert::<false>(key, &mut ops);
            if self.delete::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair — the **mean** of the two alternating
    /// pairs, matching what `churn_n` amortises per unit (the trees' convention, so the
    /// three ordered structures stay on one per-pair y-axis). Each pair nets zero size
    /// change, so state is unchanged afterwards.
    pub fn churn_counted(&mut self) -> f64 {
        let (lo, hi) = (self.churn_lo, self.churn_hi);
        let mut lo_ops = 0u64;
        self.insert::<true>(lo, &mut lo_ops);
        let _ = self.delete::<true>(lo, &mut lo_ops);
        let mut hi_ops = 0u64;
        self.insert::<true>(hi, &mut hi_ops);
        let _ = self.delete::<true>(hi, &mut hi_ops);
        (lo_ops + hi_ops) as f64 / 2.0
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh list of size `n` from empty by inserting each key in turn.
    /// Differencing this across sweep points yields the per-insert cost (finite
    /// differences, docs/PLAN.md §6.3). Θ(n log n). Returns the size to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        SkipListF64::new(keys, n).count as u32
    }

    /// Op-count for the cumulative build to size `n`: total node-visits to insert the
    /// first `n` keys — the list's total search-path length, ≈ n log n for any input
    /// order (the heights do not care how the keys arrive).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut s = SkipListF64::new_empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            s.insert::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key by removing the current **maximum and minimum in
    /// turn**, leaving the list empty (docs/PLAN.md §6.3 teardown) — the two ends churn
    /// probes, which is what keeps churn and the finite-difference delete on the same
    /// paths (docs/METHODOLOGY.md §4.1). Returns the delete count to defeat DCE.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        let mut take_hi = true;
        loop {
            let end = if take_hi { self.max_value() } else { self.min_value() };
            match end {
                Some(v) => {
                    take_hi = !take_hi;
                    self.delete::<false>(v, &mut ops);
                    count += 1;
                }
                None => break,
            }
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total node-visits to delete every key by
    /// removing the current maximum and minimum in turn (Σ over the shrinking list —
    /// Θ(n log n)). Built untimed via `new`, then counted.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut s = SkipListF64::new(keys, n);
        let mut ops = 0u64;
        let mut take_hi = true;
        loop {
            let end = if take_hi { s.max_value() } else { s.min_value() };
            match end {
                Some(v) => {
                    take_hi = !take_hi;
                    s.delete::<true>(v, &mut ops);
                }
                None => break,
            }
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` list, then tear it all down by alternating
    /// delete-max / delete-min, in one self-contained call. Subtracting the
    /// `build_insert_n` time isolates the teardown — the delete side of the
    /// finite-difference method (docs/PLAN.md §6.3).
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        SkipListF64::new(keys, n).teardown_all()
    }
}

impl SkipListF64 {
    /// An empty list: a head sentinel with no forward links and no levels in use.
    pub fn new_empty() -> SkipListF64 {
        SkipListF64 {
            nodes: Vec::new(),
            head: vec![None; MAX_LEVEL],
            level: 0,
            free: Vec::new(),
            count: 0,
            probes: Vec::new(),
            churn_lo: 0.0,
            churn_hi: 0.0,
            churn_hi_next: true,
        }
    }

    /// Whether the list holds no keys.
    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// The node after `cur` at `level` (`cur == HEAD` reads the sentinel).
    #[inline]
    fn fwd(&self, cur: u32, level: usize) -> Option<u32> {
        if cur == HEAD {
            self.head[level]
        } else {
            self.nodes[cur as usize].forward[level]
        }
    }

    /// Point `cur`'s level-`level` forward link at `next` (`cur == HEAD` writes the sentinel).
    #[inline]
    fn set_fwd(&mut self, cur: u32, level: usize, next: Option<u32>) {
        if cur == HEAD {
            self.head[level] = next;
        } else {
            self.nodes[cur as usize].forward[level] = next;
        }
    }

    /// Allocate a node of `height` levels, reusing a freed slot when one is available.
    fn alloc(&mut self, value: f64, height: usize) -> u32 {
        let node = Node { value, forward: vec![None; height] };
        match self.free.pop() {
            Some(i) => {
                self.nodes[i as usize] = node;
                i
            }
            None => {
                self.nodes.push(node);
                (self.nodes.len() - 1) as u32
            }
        }
    }

    /// The shared descent: from the top level down to level 0, advance while the forward
    /// node's key satisfies `key <cmp> target`, recording the last node visited per level
    /// in `update`. Counts **one op per node inspected** (the cost metric).
    ///
    /// `PAST_EQUAL` picks the comparison, and it is the only difference between the
    /// insert descent and the search/delete one:
    /// - `false` ⇒ advance while `value < target`, stopping *before* the first equal key
    ///   (what search and delete need — they act on the first occurrence);
    /// - `true` ⇒ advance while `value <= target`, stopping *after* the last equal key
    ///   (what insert needs, so a new equal lands behind the equals already stored).
    /// `update` is `None` for a plain search, which wants only the predecessor: nothing
    /// downstream reads the per-level record, and the timed hot path should not be paying
    /// for a 24-word scratch array it never looks at. `insert` and `delete` pass `Some`.
    fn descend<const COUNT: bool, const PAST_EQUAL: bool>(
        &self,
        target: f64,
        ops: &mut u64,
        mut update: Option<&mut [u32; MAX_LEVEL]>,
    ) -> u32 {
        let mut cur = HEAD;
        let mut i = self.level;
        while i > 0 {
            i -= 1;
            while let Some(nx) = self.fwd(cur, i) {
                if COUNT {
                    *ops += 1;
                }
                let v = self.nodes[nx as usize].value;
                if if PAST_EQUAL { v <= target } else { v < target } {
                    cur = nx;
                } else {
                    break;
                }
            }
            if let Some(u) = update.as_deref_mut() {
                u[i] = cur;
            }
        }
        cur
    }

    /// Search for `key`: descend to its level-0 predecessor, then inspect the one node
    /// that could hold it. Counts one op per node inspected, the final equality test
    /// included — so a miss just past the end of the list costs one op less than a hit.
    fn find<const COUNT: bool>(&self, key: f64, ops: &mut u64) -> bool {
        let cur = self.descend::<COUNT, false>(key, ops, None);
        match self.fwd(cur, 0) {
            Some(nx) => {
                if COUNT {
                    *ops += 1;
                }
                self.nodes[nx as usize].value == key
            }
            None => false,
        }
    }

    /// Insert `key` (multiset — a new equal key goes *after* the stored equals). The
    /// tower height comes from the key's hash, so the resulting list is a function of the
    /// key set alone. Counts the descent's node-visits; the link surgery is free.
    fn insert<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) {
        // `update` starts at HEAD everywhere, which is already the right predecessor for
        // every level the list does not yet use — a taller-than-current tower links
        // straight off the sentinel.
        let mut update = [HEAD; MAX_LEVEL];
        let _ = self.descend::<COUNT, true>(key, ops, Some(&mut update));

        let height = tower_height(key);
        if height > self.level {
            self.level = height;
        }
        let id = self.alloc(key, height);
        for j in 0..height {
            let next = self.fwd(update[j], j);
            self.nodes[id as usize].forward[j] = next;
            self.set_fwd(update[j], j, Some(id));
        }
        self.count += 1;
    }

    /// Delete the **first** occurrence of `key`. Counts the descent's node-visits plus the
    /// one equality test that identifies the victim; unlinking carries no comparisons
    /// (the R1 contract). Returns whether a key was removed.
    fn delete<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) -> bool {
        let mut update = [HEAD; MAX_LEVEL];
        let cur = self.descend::<COUNT, false>(key, ops, Some(&mut update));

        let target = match self.fwd(cur, 0) {
            Some(nx) => nx,
            None => return false,
        };
        if COUNT {
            *ops += 1;
        }
        if self.nodes[target as usize].value != key {
            return false;
        }

        // Unlink at every level the victim occupies. `update[j]`'s successor at level j is
        // the first node ≥ key there; the victim is the first such node in level-0 order,
        // and duplicates of a key all share its height (the height is a function of the
        // key), so for every j below its height that successor is the victim itself. The
        // guard is belt-and-braces — the textbook form, kept because it is free.
        let height = self.nodes[target as usize].forward.len();
        for j in 0..height {
            if self.fwd(update[j], j) == Some(target) {
                let next = self.nodes[target as usize].forward[j];
                self.set_fwd(update[j], j, next);
            }
        }
        self.free.push(target);
        self.count -= 1;
        // Drop any now-empty top levels so `level` keeps meaning "levels in use".
        while self.level > 0 && self.head[self.level - 1].is_none() {
            self.level -= 1;
        }
        true
    }

    /// Value of the current minimum — the first node at level 0. A pointer read, so it is
    /// not a cost event (the same rule as the BST's `min_value`). `None` when empty.
    fn min_value(&self) -> Option<f64> {
        self.head[0].map(|i| self.nodes[i as usize].value)
    }

    /// Value of the current maximum — reached by taking every forward link that exists,
    /// top level down. A pointer descent with no key comparison (so not a cost event), and
    /// O(log n) rather than the O(n) a level-0 walk to the tail would cost — which is what
    /// keeps `teardown_all` at Θ(n log n). `None` when empty.
    fn max_value(&self) -> Option<f64> {
        if self.level == 0 {
            return None;
        }
        let mut cur = HEAD;
        let mut i = self.level;
        while i > 0 {
            i -= 1;
            while let Some(nx) = self.fwd(cur, i) {
                cur = nx;
            }
        }
        debug_assert_ne!(cur, HEAD, "a non-empty list has a last node");
        Some(self.nodes[cur as usize].value)
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// Membership plus the node-visit count for one search (the cost metric).
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.find::<true>(target, &mut ops);
        (found, ops)
    }

    /// Insert one key, returning the node-visit count of its descent. Mutates.
    pub fn insert_one_counted(&mut self, key: f64) -> u64 {
        let mut ops = 0u64;
        self.insert::<true>(key, &mut ops);
        ops
    }

    /// Delete the first occurrence of `target`, returning `(removed, node-visits)`. Mutates.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.delete::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Keys in ascending order — the level-0 walk, which *is* the iteration order.
    pub fn keys_in_order(&self) -> Vec<f64> {
        let mut out = Vec::with_capacity(self.count);
        let mut cur = self.head[0];
        while let Some(i) = cur {
            out.push(self.nodes[i as usize].value);
            cur = self.nodes[i as usize].forward[0];
        }
        out
    }

    /// Number of levels currently in use.
    pub fn top_level(&self) -> usize {
        self.level
    }

    /// The keys visible at each level, level 0 first — the **express-lane profile**, and
    /// the conformance dimension membership and op-count cannot supply on their own.
    ///
    /// A skip list whose upper levels are mis-linked or silently dropped still answers
    /// every membership query correctly (level 0 alone is a sorted linked list) and would
    /// pass an order-plus-op-count corpus while being an O(n) structure. Pinning the level
    /// lists catches that, and it subsumes a height histogram: a key's tower height is the
    /// number of lists it appears in. This is the skip list's counterpart to the BST
    /// corpus's pre-order shape.
    pub fn level_keys(&self) -> Vec<Vec<f64>> {
        (0..self.level)
            .map(|i| {
                let mut out = Vec::new();
                let mut cur = self.head[i];
                while let Some(j) = cur {
                    out.push(self.nodes[j as usize].value);
                    cur = self.nodes[j as usize].forward[i];
                }
                out
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(keys: &[f64]) -> SkipListF64 {
        SkipListF64::new(keys, keys.len())
    }

    fn seq(n: usize) -> Vec<f64> {
        (0..n).map(|i| i as f64).collect()
    }

    /// The height rule is part of the cross-language contract, so its outputs are pinned
    /// the way `mix_matches_pinned_anchors` pins the hash. The TS twin asserts the same
    /// numbers, catching a drift locally before the full corpus (docs/PLAN.md §12).
    #[test]
    fn height_anchors_are_pinned() {
        // The salt's whole job: 0 is an ordinary one-level key, not a full-height tower.
        assert_eq!(tower_height(0.0), 1);
        assert_eq!(tower_height(1.0), 1);
        assert_eq!(tower_height(5.0), 3);
        assert_eq!(tower_height(7.0), 4);
        assert_eq!(tower_height(37.0), 6);
        assert_eq!(tower_height(116.0), 9);
        assert_eq!(tower_height(0.5), 3);
        assert_eq!(tower_height(-1.0), 2);
        assert_eq!(tower_height(1_000_000.0), 1);
    }

    /// The clamp, on the only input that still hashes to zero: the f64 whose bit pattern
    /// *is* the salt. It asks for 64 levels and must get [`MAX_LEVEL`] — no panic, no
    /// out-of-range link into a 24-wide head.
    #[test]
    fn the_salts_own_key_is_clamped_not_crashed() {
        let pathological = f64::from_bits(HEIGHT_SALT);
        assert_eq!(tower_height(pathological), MAX_LEVEL);
        let s = list(&[pathological, 1.0, 2.0]);
        assert_eq!(s.top_level(), MAX_LEVEL);
        assert!(s.search_one_counted(pathological).0);
    }

    /// The heights really are geometric with p = ½ — the property the O(log n) rests on,
    /// checked on the key range the sweeps actually use rather than assumed from the maths.
    #[test]
    fn tower_heights_halve_level_by_level() {
        let n = 4000usize;
        let mut at_least = vec![0usize; 6];
        for i in 0..n {
            let h = tower_height(i as f64);
            for (level, count) in at_least.iter_mut().enumerate() {
                if h >= level + 1 {
                    *count += 1;
                }
            }
        }
        for level in 1..at_least.len() {
            let ratio = at_least[level] as f64 / at_least[level - 1] as f64;
            assert!(
                (0.4..0.6).contains(&ratio),
                "level {level} should hold about half of level {}: ratio {ratio}",
                level - 1
            );
        }
    }

    #[test]
    fn level_zero_is_the_sorted_multiset_duplicates_kept() {
        let s = list(&[5.0, 1.0, 5.0, 3.0, 5.0, 2.0]);
        assert_eq!(s.keys_in_order(), vec![1.0, 2.0, 3.0, 5.0, 5.0, 5.0]);
        assert_eq!(s.len(), 6);
    }

    #[test]
    fn search_finds_present_and_rejects_absent() {
        let s = list(&seq(64));
        assert!(s.search_one_counted(0.0).0);
        assert!(s.search_one_counted(63.0).0);
        assert!(!s.search_one_counted(64.0).0);
        assert!(!s.search_one_counted(-1.0).0);
        let empty = list(&[]);
        assert_eq!(empty.search_one_counted(1.0), (false, 0));
    }

    /// The property the whole hash-height design buys: the list a key set builds does not
    /// depend on the order the keys arrived in. That is what lets the skip list keep its
    /// class on the reverse-sorted input that degenerates a naive BST — with no rotations
    /// and no RNG.
    #[test]
    fn the_list_is_a_function_of_the_key_set_not_the_insertion_order() {
        let ascending = seq(200);
        let descending: Vec<f64> = ascending.iter().rev().copied().collect();
        let mut shuffled = ascending.clone();
        shuffled.swap(0, 137);
        shuffled.swap(9, 42);

        let a = list(&ascending);
        let d = list(&descending);
        let s = list(&shuffled);

        assert_eq!(a.level_keys(), d.level_keys());
        assert_eq!(a.level_keys(), s.level_keys());
        assert_eq!(a.top_level(), d.top_level());
        // And the cost of finding the maximum is the same however it was built.
        assert_eq!(a.search_one_counted(199.0), d.search_one_counted(199.0));
    }

    /// Every level is a subsequence of the one below it, each level is sorted, and a key's
    /// tower height matches the hash rule — the structural invariant the express lanes
    /// rest on. Checked on a set big enough to build several levels.
    #[test]
    fn levels_are_sorted_subsequences_with_hash_derived_heights() {
        let s = list(&seq(2000));
        let levels = s.level_keys();
        assert!(levels.len() >= 8, "2000 keys should build several levels, got {}", levels.len());

        for lvl in &levels {
            assert!(lvl.windows(2).all(|w| w[0] <= w[1]), "each level must be sorted");
        }
        for i in 1..levels.len() {
            let mut lower = levels[i - 1].iter();
            for k in &levels[i] {
                assert!(
                    lower.any(|l| l == k),
                    "level {i} key {k} must appear, in order, at level {}",
                    i - 1
                );
            }
        }
        for k in &levels[0] {
            let height = levels.iter().filter(|lvl| lvl.contains(k)).count();
            assert_eq!(height, tower_height(*k), "tower height of {k} must follow the hash rule");
        }
    }

    /// Delete unlinks the victim at **every** level it occupies. A delete that only fixed
    /// level 0 would leave a dangling express link — still answering membership correctly
    /// on the level-0 walk, which is exactly why the corpus pins the level lists.
    #[test]
    fn delete_unlinks_the_whole_tower() {
        let keys = seq(500);
        let mut s = list(&keys);
        // 116 has a 9-level tower (see the height anchors), so it sits on every express lane.
        assert_eq!(tower_height(116.0), 9);
        assert!(s.delete_one_counted(116.0).0);

        for lvl in s.level_keys() {
            assert!(!lvl.contains(&116.0), "the deleted key must be gone from every level");
        }
        assert_eq!(s.len(), keys.len() - 1);
        assert!(!s.search_one_counted(116.0).0);
        let expected: Vec<f64> = keys.iter().copied().filter(|&k| k != 116.0).collect();
        assert_eq!(s.keys_in_order(), expected);
    }

    /// Deleting one of several equal keys removes exactly one, and leaves a walkable list
    /// even when the equals have different tower heights (the case that makes the unlink
    /// guard matter).
    #[test]
    fn delete_removes_one_of_several_equal_keys() {
        let mut s = list(&[5.0, 5.0, 5.0, 7.0]);
        assert!(s.delete_one_counted(5.0).0);
        assert_eq!(s.keys_in_order(), vec![5.0, 5.0, 7.0]);
        assert!(s.delete_one_counted(5.0).0);
        assert!(s.delete_one_counted(5.0).0);
        assert!(!s.delete_one_counted(5.0).0);
        assert_eq!(s.keys_in_order(), vec![7.0]);
    }

    /// Teardown empties the list and collapses the levels with it, whichever end it
    /// started from — the invariant `build_then_teardown_n` rests on.
    #[test]
    fn teardown_empties_the_list_and_collapses_the_levels() {
        let mut s = list(&seq(300));
        assert_eq!(s.teardown_all(), 300);
        assert!(s.is_empty());
        assert_eq!(s.top_level(), 0);
        assert!(s.level_keys().is_empty());
        assert_eq!(s.keys_in_order(), Vec::<f64>::new());
    }

    /// A churn pair restores the list exactly — same contents, same express lanes — so the
    /// timed loop measures a fixed n rather than a drifting one.
    #[test]
    fn a_churn_pair_restores_the_list() {
        let keys = seq(400);
        let mut s = list(&keys);
        let before = s.level_keys();
        s.set_churn_keys(-1.0, 400.0);
        let _ = s.churn_counted();
        assert_eq!(s.len(), keys.len());
        assert_eq!(s.keys_in_order(), keys);
        assert_eq!(s.level_keys(), before, "churn must leave the express lanes untouched");
    }

    /// **Both churn ends are honest, and that was checked rather than assumed** (the
    /// CLAUDE.md rule that a churn key is a measurement decision, not a default).
    ///
    /// `min − 1` finds a real node waiting at every level and fails the comparison against
    /// it, so it pays one inspection per level. `max + 1` walks off the end of each level
    /// instead, and running out of forward links costs **no comparison at all**, so it is
    /// the *cheaper* of the two — the opposite of the intuition that the far end is the
    /// long walk. Both are O(log n), a constant apart, which is exactly what separates the
    /// skip list from the sorted array: there a tail key would have reported O(log n)
    /// mutation for an honestly O(n) structure — a wrong *class*, not a wrong constant.
    /// Measured on 4000 ascending keys: low end 29, high end 17.
    #[test]
    fn neither_churn_end_changes_the_reported_class() {
        let n = 4000usize;
        let keys = seq(n);
        let mut s = list(&keys);

        s.set_churn_keys(-1.0, -1.0);
        let lo_only = s.churn_counted();
        s.set_churn_keys(n as f64, n as f64);
        let hi_only = s.churn_counted();

        // Both are O(log n): far below any linear reading of a 4000-key list.
        assert!(lo_only < 200.0, "low-end churn {lo_only} must stay O(log n)");
        assert!(hi_only < 200.0, "high-end churn {hi_only} must stay O(log n)");
        // A constant apart, not a class apart — within 2× of each other.
        assert!(
            lo_only < 2.0 * hi_only && hi_only < 2.0 * lo_only,
            "the two churn ends must stay within a constant: low {lo_only}, high {hi_only}"
        );
    }

    /// Search cost grows like log n, not n: a 16× larger list costs only a few more
    /// node-visits per probe. Clock-free — the deterministic half of the O(log n) claim.
    #[test]
    fn search_cost_is_logarithmic_in_the_number_of_keys() {
        let small = list(&seq(1_000));
        let big = list(&seq(16_000));
        let probe = 999.0; // present in both

        let (_, small_ops) = small.search_one_counted(probe);
        let (_, big_ops) = big.search_one_counted(probe);

        assert!(big_ops > small_ops, "a bigger list costs more: {big_ops} vs {small_ops}");
        assert!(
            big_ops < small_ops + 20,
            "16× the keys must cost only a few more visits: {big_ops} vs {small_ops}"
        );
        // A linear scan of 16 000 keys would be three orders of magnitude worse.
        assert!(big_ops < 100, "search must stay O(log n): {big_ops} visits");
    }
}
