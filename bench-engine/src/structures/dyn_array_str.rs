//! Unsorted dynamic array of **string** keys (docs/PLAN.md §8, "Linear" family)
//! — the string twin of [`super::dyn_array::ArrayF64`].
//!
//! Identical algorithm, different key type: search is a linear scan from the
//! front (cost metric **comparisons**, one per element examined) and `delete` is
//! the **ordered shift-compact** (scan for the first occurrence, then shift the
//! tail left). The only structural difference is the boundary: it is built from
//! the offsets+UTF-8 marshal layout (docs/PLAN.md §4.2, risk R7) via
//! [`super::decode_keys`], so the string keys cross into WASM as one byte buffer
//! rather than element-by-element.

use super::decode_keys;
use wasm_bindgen::prelude::*;

/// An unsorted list of string keys (a multiset — duplicates are kept, matching
/// the data layer's "never dedupe" rule; membership is unaffected by multiplicity).
#[wasm_bindgen]
pub struct ArrayStr {
    data: Vec<String>,
    /// Query workload, stored once (untimed) so the timed search call carries no
    /// argument-marshalling overhead per invocation (docs/PLAN.md §6.2).
    probes: Vec<String>,
    /// The spare key cycled in/out by `churn_n` (docs/PLAN.md §6.3); the caller
    /// sets it absent from `data` so each insert is real and the matching delete
    /// restores size — holding n stable across the batch.
    churn_key: String,
}

#[wasm_bindgen]
impl ArrayStr {
    /// Build from the first `n` keys of an offsets+UTF-8-bytes marshal buffer
    /// (docs/PLAN.md §4.2).
    #[wasm_bindgen(constructor)]
    pub fn new(offsets: &[u32], bytes: &[u8], n: usize) -> ArrayStr {
        ArrayStr { data: decode_keys(offsets, bytes, n), probes: Vec::new(), churn_key: String::new() }
    }

    /// Number of stored keys (`n`).
    pub fn len(&self) -> usize {
        self.data.len()
    }

    /// Set the query workload (present + absent probe keys) from a marshal buffer.
    /// Untimed.
    pub fn set_probes(&mut self, offsets: &[u32], bytes: &[u8]) {
        self.probes = decode_keys(offsets, bytes, offsets.len().saturating_sub(1));
    }

    /// Timed hot path: perform `k` searches, cycling through the stored probes.
    /// Returns the number of hits — consumed by the caller so the optimizer can't
    /// elide the work (docs/PLAN.md §6.2). No op-counting overhead (`COUNT=false`).
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

    /// Op-count signal (§6.4): one pass over the probe set with `COUNT=true`,
    /// returning total comparisons. `f64` return keeps it a plain JS number.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for p in &self.probes {
            let _ = self.contains::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare key cycled by `churn_n` — must be absent from the data so
    /// each insert is real and the matching delete restores size. Untimed.
    pub fn set_churn_key(&mut self, key: &str) {
        self.churn_key = key.to_owned();
    }

    /// Timed hot path: `k` insert+delete *pairs* of the churn key, holding size
    /// stable at ≈ n (docs/PLAN.md §6.3). This isolates the per-op mutation cost
    /// at a fixed n. Returns the delete-hit count to defeat dead-code elimination.
    /// No op-counting overhead (`COUNT=false`).
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let key = self.churn_key.clone();
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            self.data.push(key.clone()); // insert (append, O(1))
            if self.remove_first::<false>(&key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the comparisons + shifts of a
    /// counted insert+delete. The pair nets zero size change, so state is
    /// unchanged afterwards. The append contributes no comparisons/shifts, so the
    /// pair's cost is the delete's (a full scan to the tail-appended key).
    pub fn churn_counted(&mut self) -> f64 {
        let key = self.churn_key.clone();
        let mut ops = 0u64;
        self.data.push(key.clone());
        let _ = self.remove_first::<true>(&key, &mut ops);
        ops as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh array of size `n` from empty by appending each key in
    /// turn (no pre-reserved capacity, so realloc growth is part of the measured
    /// cost). Differencing this across sweep points yields per-insert cost near n
    /// (finite differences, docs/PLAN.md §6.3). Returns the length to defeat DCE.
    pub fn build_insert_n(offsets: &[u32], bytes: &[u8], n: usize) -> u32 {
        let keys = decode_keys(offsets, bytes, n);
        let mut data: Vec<String> = Vec::new();
        for k in keys {
            data.push(k);
        }
        data.len() as u32
    }

    /// Op-count for the cumulative build to size `n`. An array append performs no
    /// comparisons and no shifts, so the build's op-count is identically zero —
    /// the deterministic counterpart of insert's O(1) wall-clock cost.
    pub fn build_insert_counted(_offsets: &[u32], _bytes: &[u8], _n: usize) -> f64 {
        0.0
    }

    /// Timed: delete every stored key, front-first, leaving the array empty
    /// (docs/PLAN.md §6.3 teardown). Built untimed by the caller via `new`; only
    /// this call is timed. Returns the delete count to defeat DCE.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        while let Some(k) = self.data.first().cloned() {
            self.remove_first::<false>(&k, &mut ops);
            count += 1;
        }
        count
    }

    /// Op-count for a full size-`n` teardown: total comparisons + shifts to
    /// delete every key front-first (Σ over the shrinking array — O(n²)).
    pub fn teardown_counted(offsets: &[u32], bytes: &[u8], n: usize) -> f64 {
        let mut a = ArrayStr::new(offsets, bytes, n);
        let mut ops = 0u64;
        while let Some(k) = a.data.first().cloned() {
            a.remove_first::<true>(&k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` array via inserts, then tear it all down,
    /// in one self-contained call. Subtracting the `build_insert_n` time isolates
    /// the teardown — the delete side of the finite-difference method (docs/PLAN.md
    /// §6.3); building via the same append path cancels in the subtraction.
    pub fn build_then_teardown_n(offsets: &[u32], bytes: &[u8], n: usize) -> u32 {
        let keys = decode_keys(offsets, bytes, n);
        let mut a = ArrayStr { data: Vec::new(), probes: Vec::new(), churn_key: String::new() };
        for k in keys {
            a.data.push(k);
        }
        a.teardown_all()
    }
}

impl ArrayStr {
    /// The one search algorithm, generic over whether it counts. With
    /// `COUNT=false` the `*ops` increment is dead code and is removed entirely.
    #[inline]
    fn contains<const COUNT: bool>(&self, target: &str, ops: &mut u64) -> bool {
        for k in &self.data {
            if COUNT {
                *ops += 1;
            }
            if k.as_str() == target {
                return true;
            }
        }
        false
    }

    /// The one delete algorithm, generic over whether it counts. Linear-scan for
    /// the first occurrence (one comparison per element examined), then shift the
    /// tail left to close the gap (one shift per element moved). Returns whether a
    /// key was removed. Cost metric = comparisons + shifts (docs/PLAN.md §8).
    #[inline]
    fn remove_first<const COUNT: bool>(&mut self, target: &str, ops: &mut u64) -> bool {
        let mut found = None;
        for (i, k) in self.data.iter().enumerate() {
            if COUNT {
                *ops += 1; // comparison
            }
            if k.as_str() == target {
                found = Some(i);
                break;
            }
        }
        match found {
            Some(i) => {
                if COUNT {
                    *ops += (self.data.len() - 1 - i) as u64; // shifts to compact
                }
                self.data.remove(i);
                true
            }
            None => false,
        }
    }

    /// Test/conformance helper: membership plus the comparison count for one
    /// search (the cost metric for this structure).
    pub fn search_one_counted(&self, target: &str) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: delete the first occurrence of `target`,
    /// returning `(removed, comparisons + shifts)`. Mutates the array.
    pub fn delete_one_counted(&mut self, target: &str) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.remove_first::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Stored keys in insertion order — the array's iteration order. A
    /// conformance hook (docs/PLAN.md §12); not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<String> {
        self.data.clone()
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

    fn arr(keys: &[&str]) -> ArrayStr {
        let (offsets, bytes) = marshal(keys);
        ArrayStr::new(&offsets, &bytes, keys.len())
    }

    #[test]
    fn comparisons_equal_position_when_found() {
        let a = arr(&["ten", "twenty", "thirty"]);
        assert_eq!(a.search_one_counted("ten"), (true, 1));
        assert_eq!(a.search_one_counted("twenty"), (true, 2));
        assert_eq!(a.search_one_counted("thirty"), (true, 3));
    }

    #[test]
    fn absent_key_scans_whole_array() {
        let a = arr(&["ten", "twenty", "thirty"]);
        assert_eq!(a.search_one_counted("nope"), (false, 3));
    }

    #[test]
    fn builds_from_marshalled_offsets_including_empty_and_multibyte() {
        // Empty string (offsets[i] == offsets[i+1]), accented + CJK + emoji keys
        // (byte-length ≠ char-length), and a duplicate the multiset must keep.
        let keys = ["", "a", "café", "日本", "a"];
        let a = arr(&keys);
        assert_eq!(a.len(), 5);
        let expected: Vec<String> = keys.iter().map(|s| s.to_string()).collect();
        assert_eq!(a.keys_in_order(), expected);
        assert!(a.search_one_counted("").0); // the empty string is a real, findable key
        assert!(a.search_one_counted("café").0);
        assert!(a.search_one_counted("日本").0);
        assert!(!a.search_one_counted("cafe").0); // byte-exact: "cafe" ≠ "café"
    }

    #[test]
    fn constructor_honors_n() {
        let (offsets, bytes) = marshal(&["a", "b", "c", "d"]);
        let a = ArrayStr::new(&offsets, &bytes, 2);
        assert_eq!(a.len(), 2);
        assert_eq!(a.search_one_counted("c"), (false, 2));
    }

    #[test]
    fn search_n_cycles_probes_and_counts_hits() {
        let mut a = arr(&["a", "b", "c"]);
        let (po, pb) = marshal(&["b", "zz"]); // one present, one absent
        a.set_probes(&po, &pb);
        // 4 searches over [b,zz,b,zz] => 2 hits.
        assert_eq!(a.search_n(4), 2);
    }

    #[test]
    fn delete_counts_comparisons_plus_shifts() {
        let mut a = arr(&["ten", "twenty", "thirty"]);
        // Remove the front: 1 comparison + 2 shifts to compact.
        assert_eq!(a.delete_one_counted("ten"), (true, 3));
        assert_eq!(a.keys_in_order(), vec!["twenty".to_string(), "thirty".to_string()]);
        // Remove the tail: 2 comparisons (full scan) + 0 shifts.
        assert_eq!(a.delete_one_counted("thirty"), (true, 2));
        assert_eq!(a.keys_in_order(), vec!["twenty".to_string()]);
        // Absent key: full scan, nothing removed.
        assert_eq!(a.delete_one_counted("nope"), (false, 1));
    }

    #[test]
    fn delete_removes_only_first_occurrence() {
        let mut a = arr(&["x", "x", "y"]);
        assert_eq!(a.delete_one_counted("x").0, true);
        assert_eq!(a.keys_in_order(), vec!["x".to_string(), "y".to_string()]);
    }

    #[test]
    fn churn_holds_size_and_counts_the_delete_scan() {
        let mut a = arr(&["a", "b", "c"]);
        a.set_churn_key("zz"); // absent
        a.churn_n(10); // 10 insert+delete pairs
        assert_eq!(a.len(), 3); // size restored
        assert_eq!(a.keys_in_order(), vec!["a".to_string(), "b".to_string(), "c".to_string()]);
        // One pair: append "zz" at the tail (0 ops) then delete it — found at the
        // tail of the size-4 array => 4 comparisons + 0 shifts.
        assert_eq!(a.churn_counted(), 4.0);
        assert_eq!(a.len(), 3); // churn_counted nets zero
    }

    #[test]
    fn build_insert_is_free_of_comparisons_and_shifts() {
        let (offsets, bytes) = marshal(&["a", "b", "c", "d"]);
        assert_eq!(ArrayStr::build_insert_n(&offsets, &bytes, 3), 3);
        assert_eq!(ArrayStr::build_insert_counted(&offsets, &bytes, 3), 0.0); // append-only
    }

    #[test]
    fn teardown_empties_and_counts_quadratically() {
        let (offsets, bytes) = marshal(&["a", "b", "c"]);
        let mut a = ArrayStr::new(&offsets, &bytes, 3);
        assert_eq!(a.teardown_all(), 3);
        assert_eq!(a.len(), 0);
        // Front-first teardown of size 3: (1 cmp + 2 shifts) + (1 + 1) + (1 + 0)
        // = 3 + 2 + 1 = 6.
        assert_eq!(ArrayStr::teardown_counted(&offsets, &bytes, 3), 6.0);
    }
}
