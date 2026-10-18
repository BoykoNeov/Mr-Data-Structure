//! Hash set with **linear probing and backward-shift deletion** (docs/PLAN.md §8 "Hashing",
//! §13's first open question, item (a)) — the third hash set, built to be read against the
//! tombstone one (`hash_set_oa::HashSetOaF64`) so that the only thing differing between
//! their lines is **what a delete leaves behind**.
//!
//! **What is held equal.** Everything the open-addressing set already holds equal to the
//! chaining set — the same hash (`mix_f64`), the same power-of-two table starting at 4
//! slots, the same 0.75 growth threshold, the same doubling (`tests::grows_at_exactly_the_
//! chaining_sets_points`) — plus the open-addressing set's own probe sequence (linear, step
//! one) and its rehash re-placement order (old slots in index order). A table built with no
//! deletes is therefore **slot for slot the open-addressing set's table**, so their search
//! op-counts coincide exactly (pinned in `structures::methodology_hbs`). The two differ only
//! once something is deleted.
//!
//! **Delete shifts instead of marking (Knuth's Algorithm R).** Emptying a slot would cut the
//! probe path of any key stored past it, so instead the delete walks on through the rest of
//! the run and moves back every key whose home slot does not lie (cyclically) between the
//! hole and the key's slot, each move opening the hole one place further on; the slot the
//! last move vacates becomes empty. No tombstone ever exists, so the table never needs a
//! purge, no load accounting counts dead slots, and a churn insert+delete restores the table
//! **bit for bit, by construction**: an absent key lands on the empty slot that ended its
//! walk, every key in the run after that slot is homed inside that run (the probing
//! invariant: no key's path crosses an empty slot), so the shift moves nothing back and the
//! slot is emptied again.
//!
//! **Cost metric: hashes + slot probes**, on the open-addressing (and chaining) convention:
//! one tick for the hash, one per occupied slot examined, the empty slot that ends a walk
//! free. The delete's **shift scan** is counted on the same unit, literally: each occupied
//! slot it examines is **one slot probe plus one hash**, because deciding whether a key may
//! move back needs that key's home slot, and this twin — like the other two hash sets —
//! stores no hashes, so it recomputes `mix_f64` for every key it passes. That choice sets
//! the size of the one term in which this set's churn differs from the tombstone set's
//! unprimed pair (`methodology_hbs`), so it is stated wherever the number is quoted. Moves
//! (writes) are not counted, as no set counts its writes.
//!
//! **Churn: the open-addressing set's block, with no priming.** Equal footing with the
//! tombstone set is the point of this line, so `set_churn_key` builds the **same block** —
//! `clamp(⌊len / 32⌋, 1, 16)` consecutive absent keys from `max + 1` — and the counted signal
//! is the same mean per pair. The block is kept even though a backward-shift pair leaves
//! nothing behind, because its *other* job still applies: one key's churn cost is the length
//! of whichever run its home lands in, heavy-tailed, and a block of keys samples several
//! runs (METHODOLOGY §2.8 rule 4). What disappears is rule 3: there is no tombstone to
//! prime, so the first pair costs what every later pair costs (`tests::the_first_pair_is_
//! already_the_steady_state`). `set_churn_key` runs one untimed **capacity settle** pass
//! instead — an insert+delete per block key, repeated until a pass causes no rehash — which
//! is a no-op except when the stored count sits exactly at the threshold, where a churn
//! insert (n + 1 keys) doubles the table: without the settle, the first counted pair would
//! run at the old load factor and every later one at the new (`tests::a_churn_pair_at_the_
//! threshold_settles_before_anything_is_counted`). The chaining set has the same edge and
//! no settle — one key, a constant; noted, not copied.
//!
//! Semantics mirror the other two sets: a **set** (duplicates collapse on insert, first
//! occurrence wins), `len` is the stored distinct count, `teardown_keys` keeps the distinct
//! keys in insertion order so teardown deletes each exactly once.

use super::mix_f64;
use wasm_bindgen::prelude::*;

const INITIAL_SLOTS: usize = 4;
/// Double when `live / slots` would exceed this — the chaining set's 0.75.
const MAX_LOAD: f64 = 0.75;

const EMPTY: u8 = 0;
const LIVE: u8 = 1;

/// Most churn keys a block holds — the open-addressing set's 16.
const CHURN_BLOCK_MAX: usize = 16;
/// At most one churn key per this many stored keys — the open-addressing set's 32.
const KEYS_PER_CHURN_KEY: usize = 32;
/// Settle passes `set_churn_key` may run (one suffices: the table never shrinks, so after a
/// pass that doubled it no later pair can reach the threshold). A defensive bound.
const MAX_SETTLE_PASSES: usize = 4;

/// How many churn keys a set of `len` stored keys churns: `clamp(len / 32, 1, 16)` — the
/// open-addressing set's block rule, restated so the two lines sample the same keys.
pub fn churn_block(len: usize) -> usize {
    (len / KEYS_PER_CHURN_KEY).clamp(1, CHURN_BLOCK_MAX)
}

/// A set of distinct `f64` keys stored in one flat, linearly-probed table with no
/// tombstones. Slot state lives in its own byte array, as in the open-addressing set,
/// because every f64 can be a real key.
#[wasm_bindgen]
pub struct HashSetBsF64 {
    keys: Vec<f64>,
    state: Vec<u8>,
    len: usize,
    probes: Vec<f64>,
    /// The block of spare keys cycled in/out by `churn_n` (docs/PLAN.md §6.3), all absent.
    churn_keys: Vec<f64>,
    /// Which key of the block the next timed churn pair uses.
    churn_cursor: usize,
    /// Doublings so far — how the capacity settle detects that a pass changed nothing.
    rehashes: u32,
    /// Distinct keys captured at build time, in insertion order (see the module doc).
    teardown_keys: Vec<f64>,
}

#[wasm_bindgen]
impl HashSetBsF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`. Building (including any
    /// doublings) is untimed (docs/PLAN.md §6.3, "search is size-preserving").
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> HashSetBsF64 {
        let n = n.min(keys.len());
        let mut set = HashSetBsF64::empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            if set.insert_generic::<false>(k, &mut ops) {
                set.teardown_keys.push(k); // distinct keys only
            }
        }
        set
    }

    /// Number of distinct stored keys.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Set the query workload (present + absent probe keys). Untimed.
    pub fn set_probes(&mut self, probes: &[f64]) {
        self.probes = probes.to_vec();
    }

    /// Timed hot path: `k` searches over the stored probes, no op-counting (`COUNT=false`).
    /// Returns the hit count to defeat dead-code elimination.
    pub fn search_n(&self, k: u32) -> u32 {
        let len = self.probes.len();
        if len == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut found = 0u32;
        for i in 0..k as usize {
            if self.contains::<false>(self.probes[i % len], &mut ops) {
                found += 1;
            }
        }
        found
    }

    /// Op-count signal (§6.4): one pass over the probes counting hashes + slot probes.
    pub fn search_counted(&self) -> f64 {
        let mut ops = 0u64;
        for &p in &self.probes {
            let _ = self.contains::<true>(p, &mut ops);
        }
        ops as f64
    }

    // ── Mutation: churn at fixed size (docs/PLAN.md §6.3, primary method) ──

    /// Set the spare churn keys: the block `key, key + 1, …` of `churn_block(len)` keys —
    /// the open-addressing set's block, so the two lines churn the same keys (module doc).
    /// `key` must be absent (the sweep passes `max + 1`); a block key that turns out to be
    /// present is dropped, since its "delete" would remove a real key.
    ///
    /// There is **no priming** — no tombstone exists to settle — but there is one untimed
    /// **capacity settle**: a pass of insert+delete pairs, repeated until a pass causes no
    /// doubling. Below the threshold it changes nothing (every pair restores the table bit
    /// for bit); at it, the first churn insert doubles the table, and the settle makes that
    /// happen before anything is timed or counted.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_keys.clear();
        self.churn_cursor = 0;
        let block = churn_block(self.len);
        let mut ops = 0u64;
        for j in 0..block {
            let k = key + j as f64;
            if !self.contains::<false>(k, &mut ops) {
                self.churn_keys.push(k);
            }
        }
        for _ in 0..MAX_SETTLE_PASSES {
            let rehashes = self.rehashes;
            for j in 0..self.churn_keys.len() {
                let k = self.churn_keys[j];
                self.insert_generic::<false>(k, &mut ops);
                let _ = self.remove_key::<false>(k, &mut ops);
            }
            if self.rehashes == rehashes {
                break;
            }
        }
    }

    /// Timed hot path: `k` insert+delete *pairs*, each of the next key in the churn block,
    /// holding size at n (docs/PLAN.md §6.3). Returns the delete-hit count to defeat DCE.
    pub fn churn_n(&mut self, k: u32) -> u32 {
        let block = self.churn_keys.len();
        if block == 0 {
            return 0;
        }
        let mut ops = 0u64;
        let mut hits = 0u32;
        for _ in 0..k {
            let key = self.churn_keys[self.churn_cursor];
            self.churn_cursor = (self.churn_cursor + 1) % block;
            self.insert_generic::<false>(key, &mut ops);
            if self.remove_key::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the **mean** hashes + slot probes of one
    /// counted insert+delete per key in the block (the open-addressing set's averaging).
    /// Every pair restores the table exactly, so this is exact whatever the cursor position.
    pub fn churn_counted(&mut self) -> f64 {
        let block = self.churn_keys.len();
        if block == 0 {
            return 0.0;
        }
        let mut ops = 0u64;
        for j in 0..block {
            let key = self.churn_keys[j];
            self.insert_generic::<true>(key, &mut ops);
            let _ = self.remove_key::<true>(key, &mut ops);
        }
        ops as f64 / block as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh set of size `n` from empty (doublings amortized in). Returns
    /// `len` to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        HashSetBsF64::new(keys, n).len as u32
    }

    /// Op-count for the cumulative build to size `n`: total hashes + slot probes of the
    /// per-insert dedupe walks (rehash redistribution is amortized structural work and is
    /// deliberately not counted, as in the other two sets). Equal to the open-addressing
    /// set's, since a build has no deletes.
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        let n = n.min(keys.len());
        let mut s = HashSetBsF64::empty();
        let mut ops = 0u64;
        for &k in &keys[..n] {
            s.insert_generic::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key in insertion order, leaving an empty table. Built
    /// untimed by the caller via `new`. Returns the delete count to defeat DCE.
    pub fn teardown_all(&mut self) -> u32 {
        let mut ops = 0u64;
        let mut count = 0u32;
        for i in 0..self.teardown_keys.len() {
            let k = self.teardown_keys[i];
            if self.remove_key::<false>(k, &mut ops) {
                count += 1;
            }
        }
        count
    }

    /// Op-count for a full size-`n` teardown: each delete's find walk plus its shift scan.
    /// Runs shorten as keys leave (nothing is left behind to step over), so later deletes
    /// get cheaper — the opposite of the tombstone set's teardown.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        let mut s = HashSetBsF64::new(keys, n);
        let mut ops = 0u64;
        let order = s.teardown_keys.clone();
        for k in order {
            let _ = s.remove_key::<true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: build a fresh size-`n` set, then tear it all down, in one call. Subtracting
    /// the `build_insert_n` time isolates the teardown (docs/PLAN.md §6.3).
    pub fn build_then_teardown_n(keys: &[f64], n: usize) -> u32 {
        let mut s = HashSetBsF64::new(keys, n);
        s.teardown_all()
    }
}

impl HashSetBsF64 {
    fn empty() -> HashSetBsF64 {
        HashSetBsF64 {
            keys: vec![0.0; INITIAL_SLOTS],
            state: vec![EMPTY; INITIAL_SLOTS],
            len: 0,
            probes: Vec::new(),
            churn_keys: Vec::new(),
            churn_cursor: 0,
            rehashes: 0,
            teardown_keys: Vec::new(),
        }
    }

    #[inline]
    fn home(&self, key: f64) -> usize {
        // Power-of-two table ⇒ mask instead of modulo; the same low bits the other two sets
        // read, so a key's home slot here is its home slot (or bucket) there.
        (mix_f64(key) as usize) & (self.state.len() - 1)
    }

    /// The one search algorithm, generic over counting: hash, then walk forward from the
    /// home slot until the key or an empty slot. One tick for the hash and one per occupied
    /// slot examined; the empty slot that ends the walk is free. Bounded by the capacity
    /// defensively — the load invariant already guarantees an empty slot.
    #[inline]
    fn contains<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let mask = self.state.len() - 1;
        let mut i = self.home(target);
        for _ in 0..self.state.len() {
            if self.state[i] == EMPTY {
                return false;
            }
            if COUNT {
                *ops += 1; // slot probe (key compared)
            }
            if self.keys[i] == target {
                return true;
            }
            i = (i + 1) & mask;
        }
        false
    }

    /// The one insert algorithm, generic over counting. Walk from the home slot to the first
    /// empty slot to dedupe (same ticks as search) and place the key there; then double if
    /// live keys exceed the threshold. With no tombstones this is the open-addressing set's
    /// insert on a tombstone-free table, step for step. Returns whether the key was newly
    /// stored.
    #[inline]
    fn insert_generic<const COUNT: bool>(&mut self, key: f64, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let cap = self.state.len();
        let mask = cap - 1;
        let mut i = self.home(key);
        let mut empty: Option<usize> = None;
        for _ in 0..cap {
            if self.state[i] == EMPTY {
                empty = Some(i);
                break;
            }
            if COUNT {
                *ops += 1; // slot probe (dedupe check)
            }
            if self.keys[i] == key {
                return false; // already present
            }
            i = (i + 1) & mask;
        }
        let slot = empty.expect("load invariant: live <= 0.75 * cap leaves an empty slot");
        self.state[slot] = LIVE;
        self.keys[slot] = key;
        self.len += 1;
        if self.len as f64 > MAX_LOAD * cap as f64 {
            self.rehash();
        }
        true
    }

    /// The one delete algorithm, generic over counting: [`Self::remove_split`] with its two
    /// counts summed. Returns whether a key was removed.
    #[inline]
    fn remove_key<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        let (mut find, mut shift) = (0u64, 0u64);
        let removed = self.remove_split::<COUNT>(target, &mut find, &mut shift);
        *ops += find + shift;
        removed
    }

    /// Delete with the cost split in two. `find`: the hash plus one per occupied slot
    /// examined on the way to the key (exactly a search's walk). `shift`: the backward-shift
    /// scan over the rest of the run — **one slot probe plus one hash per occupied slot
    /// examined**, the hash being the key's home recomputed to decide whether it may move
    /// back; the empty slot that ends the scan is free.
    ///
    /// The move rule (Knuth's Algorithm R): the key at slot `j` may fill the hole at `h`
    /// unless its home lies cyclically in `(h, j]` — i.e. unless its probe path starts past
    /// the hole and so never crossed it. In wrapping arithmetic that is
    /// `(j − home) mod cap ≥ (j − h) mod cap`.
    #[inline]
    fn remove_split<const COUNT: bool>(
        &mut self,
        target: f64,
        find: &mut u64,
        shift: &mut u64,
    ) -> bool {
        if COUNT {
            *find += 1; // the hash
        }
        let cap = self.state.len();
        let mask = cap - 1;
        let mut i = self.home(target);
        let mut at: Option<usize> = None;
        for _ in 0..cap {
            if self.state[i] == EMPTY {
                return false;
            }
            if COUNT {
                *find += 1; // slot probe
            }
            if self.keys[i] == target {
                at = Some(i);
                break;
            }
            i = (i + 1) & mask;
        }
        let Some(mut hole) = at else {
            return false;
        };
        let mut j = (hole + 1) & mask;
        for _ in 0..cap {
            if self.state[j] == EMPTY {
                break; // free: the end of the run
            }
            if COUNT {
                *shift += 2; // slot probe + the hash of the key found there
            }
            let k = self.keys[j];
            let home = (mix_f64(k) as usize) & mask;
            if (j.wrapping_sub(home) & mask) >= (j.wrapping_sub(hole) & mask) {
                self.keys[hole] = k; // move back into the hole …
                hole = j; // … which opens here instead
            }
            j = (j + 1) & mask;
        }
        self.state[hole] = EMPTY;
        self.len -= 1;
        true
    }

    /// Double the table. The trigger is `live > 0.75 · cap` and there are no tombstones, so
    /// a rehash is always a doubling (the open-addressing set's purge branch needs dead
    /// slots, and this table has none). Live keys are re-placed by walking the old slots in
    /// index order, each into the first empty slot from its new home — the open-addressing
    /// set's order, which is what keeps a delete-free build slot-identical to it, and the
    /// order the TS twin mirrors.
    fn rehash(&mut self) {
        let new_cap = self.state.len() * 2;
        let old_keys = std::mem::replace(&mut self.keys, vec![0.0; new_cap]);
        let old_state = std::mem::replace(&mut self.state, vec![EMPTY; new_cap]);
        let mask = new_cap - 1;
        for (i, &st) in old_state.iter().enumerate() {
            if st == LIVE {
                let k = old_keys[i];
                let mut j = (mix_f64(k) as usize) & mask;
                while self.state[j] != EMPTY {
                    j = (j + 1) & mask;
                }
                self.state[j] = LIVE;
                self.keys[j] = k;
            }
        }
        self.rehashes = self.rehashes.wrapping_add(1);
    }

    /// Test/conformance helper: membership + (hashes + slot probes) for one search.
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: insert `target`, returning `(newly stored, hashes + slot
    /// probes)`. Mutates the set (and may double it).
    pub fn insert_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let inserted = self.insert_generic::<true>(target, &mut ops);
        (inserted, ops)
    }

    /// Test/conformance helper: delete `target`, returning `(removed, hashes + slot probes)`
    /// — the find walk and the shift scan together, as the churn signal counts them.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let (removed, find, shift) = self.delete_one_split(target);
        (removed, find + shift)
    }

    /// Test/conformance helper: delete `target`, returning `(removed, find ops, shift ops)`
    /// — the split the methodology decomposition reads (`methodology_hbs`).
    pub fn delete_one_split(&mut self, target: f64) -> (bool, u64, u64) {
        let (mut find, mut shift) = (0u64, 0u64);
        let removed = self.remove_split::<true>(target, &mut find, &mut shift);
        (removed, find, shift)
    }

    /// Number of slots in the table.
    pub fn capacity(&self) -> usize {
        self.state.len()
    }

    /// Doublings so far (a test hook).
    pub fn rehash_count(&self) -> u32 {
        self.rehashes
    }

    /// The current churn block (a test / conformance hook).
    pub fn churn_block_keys(&self) -> Vec<f64> {
        self.churn_keys.clone()
    }

    /// Live keys in slot order — the iteration order. A conformance hook (docs/PLAN.md §12);
    /// not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<f64> {
        (0..self.state.len()).filter(|&i| self.state[i] == LIVE).map(|i| self.keys[i]).collect()
    }

    /// The raw table, one entry per slot: `Some(k)` live, `None` empty — the corpus's layout
    /// dimension. A twin with a different move rule (or a tombstone) answers every query
    /// correctly and still fails it.
    pub fn slots(&self) -> Vec<Option<f64>> {
        (0..self.state.len())
            .map(|i| if self.state[i] == LIVE { Some(self.keys[i]) } else { None })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(keys: &[f64]) -> HashSetBsF64 {
        HashSetBsF64::new(keys, keys.len())
    }

    #[test]
    fn membership_is_correct() {
        let s = set(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert!(s.search_one_counted(3.0).0);
        assert!(!s.search_one_counted(99.0).0);
    }

    #[test]
    fn dedupes_on_insert_and_tears_down_to_an_empty_table() {
        let mut s = set(&[5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(s.len(), 3);
        assert_eq!(s.teardown_all(), 3); // not 5
        assert_eq!(s.len(), 0);
        assert!(s.slots().iter().all(|sl| sl.is_none()), "nothing is left behind");
    }

    /// The chaining set's growth rule, restated from `hash_set.rs` (start at 4 buckets,
    /// double whenever `len > 0.75 · buckets`) so this test needs no hook in that file.
    fn chaining_capacity(distinct: usize) -> usize {
        let mut buckets = 4usize;
        for len in 1..=distinct {
            if len as f64 > 0.75 * buckets as f64 {
                buckets *= 2;
            }
        }
        buckets
    }

    #[test]
    fn grows_at_exactly_the_chaining_sets_points() {
        // Same 4-slot start, same 0.75 threshold, same doubling as the chaining set (and so
        // as the open-addressing set): equal capacity at every n, so all three hash sets
        // share a load factor point for point (module doc).
        let keys: Vec<f64> = (0..5000).map(|i| i as f64).collect();
        for n in [0usize, 1, 3, 4, 7, 10, 20, 50, 100, 500, 1000, 4000, 5000] {
            let bs = HashSetBsF64::new(&keys, n);
            assert_eq!(bs.capacity(), chaining_capacity(n), "n={n}");
        }
    }

    #[test]
    fn a_hit_on_its_home_slot_costs_what_a_chain_head_hit_costs() {
        let s = set(&[42.0]);
        assert_eq!(s.search_one_counted(42.0), (true, 2));
        let empty = set(&[]);
        assert_eq!(empty.search_one_counted(1.0), (false, 1));
        // A lone key's delete: hash + one probe, then a shift scan that meets an empty slot
        // straight away and costs nothing.
        let mut lone = set(&[42.0]);
        assert_eq!(lone.delete_one_split(42.0), (true, 2, 0));
    }

    /// The reason a delete cannot simply empty its slot, and the fix: a key stored past the
    /// deleted one stays reachable because it is moved back into the hole.
    #[test]
    fn a_displaced_key_moves_back_into_the_hole_and_stays_reachable() {
        let keys: Vec<f64> = (0..200).map(|i| i as f64).collect();
        let mut s = set(&keys);
        let slots = s.slots();
        let mask = s.capacity() - 1;
        let (pos, displaced) = slots
            .iter()
            .enumerate()
            .find_map(|(i, sl)| match sl {
                Some(k) if (mix_f64(*k) as usize & mask) != i => Some((i, *k)),
                _ => None,
            })
            .expect("200 keys in 512 slots must collide somewhere");
        let blocker = slots[(pos + mask) & mask].expect("a displaced key's predecessor is occupied");
        let (_, before) = s.search_one_counted(displaced);
        assert!(s.delete_one_counted(blocker).0);
        let (found, after) = s.search_one_counted(displaced);
        assert!(found, "a key behind a deleted one must stay reachable");
        assert!(after < before, "and it is now closer to home ({after} < {before})");
        assert_eq!(s.slots()[(pos + mask) & mask], Some(displaced), "moved back into the hole");
    }

    /// Algorithm R's one subtle case: a key homed *after* the hole must not move back, even
    /// when it sits in the same run. Build a run where the second key is the first key's
    /// collision and the third is homed at its own slot; deleting the first moves the
    /// second back and leaves the third where it is.
    #[test]
    fn a_key_homed_past_the_hole_stays_put() {
        let homed = |slot: usize, cap: usize, count: usize| -> Vec<f64> {
            (0u32..)
                .map(f64::from)
                .filter(|&k| (mix_f64(k) as usize) & (cap - 1) == slot)
                .take(count)
                .collect()
        };
        // In an 8-slot table (4–6 keys): two keys homed at 2 (slots 2, 3), one homed at 4.
        let at2 = homed(2, 8, 2);
        let at4 = homed(4, 8, 1)[0];
        let at6 = homed(6, 8, 1)[0]; // a fourth key so the table is 8 slots
        let mut s = set(&[at2[0], at2[1], at4, at6]);
        assert_eq!(s.capacity(), 8);
        let before = s.slots();
        // Which of the two sits at home depends on the rehash's re-placement order; read it.
        let (head, collision) = (before[2].unwrap(), before[3].unwrap());
        assert!(at2.contains(&head) && at2.contains(&collision));
        assert_eq!(before[4], Some(at4));
        assert!(s.delete_one_counted(head).0);
        let after = s.slots();
        assert_eq!(after[2], Some(collision), "the collision moves back to its home");
        assert_eq!(after[3], None, "the hole it left is emptied");
        assert_eq!(after[4], Some(at4), "a key homed past the hole stays put");
    }

    #[test]
    fn churn_holds_size_and_leaves_the_table_bit_identical() {
        // Four keys in eight slots: below the threshold (six), so nothing settles.
        let mut s = set(&[1.0, 2.0, 3.0, 4.0]);
        let before = s.slots();
        s.set_churn_key(99.0);
        assert_eq!(s.slots(), before, "no priming: setting the churn key changes nothing");
        s.churn_n(10);
        assert_eq!(s.len(), 4);
        assert_eq!(s.slots(), before);
        assert!(!s.search_one_counted(99.0).0);
        assert!(s.churn_counted() >= 3.0);
        assert_eq!(s.slots(), before);
    }

    #[test]
    fn a_present_churn_key_is_dropped_not_deleted() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_churn_key(2.0); // a caller error — the block must not delete a real key
        assert_eq!(s.len(), 3);
        assert!(s.search_one_counted(2.0).0);
        assert!(s.churn_block_keys().is_empty());
        assert_eq!(s.churn_n(5), 0);
    }

    #[test]
    fn churn_block_is_the_open_addressing_sets() {
        for len in [0usize, 31, 32, 100, 511, 512, 10_000] {
            assert_eq!(churn_block(len), super::super::hash_set_oa::churn_block(len), "len={len}");
        }
    }

    /// **The pin this structure exists for (docs/METHODOLOGY.md §2.8, regime NEW).** With no
    /// tombstone there is nothing to prime: the pair counted straight after `set_churn_key`
    /// costs what it costs after 1, 7, 100 or 100 000 timed pairs, and the table after any
    /// number of pairs is the table as built — bit for bit, not merely "back at the primed
    /// state" as the open-addressing set's is.
    #[test]
    fn the_first_pair_is_already_the_steady_state() {
        let keys = shuffled_keys(3000);
        for n in [250usize, 1000, 3000] {
            let mut s = HashSetBsF64::new(&keys, n);
            let built = s.slots();
            s.set_churn_key(1e9);
            assert_eq!(s.slots(), built, "n={n}: below the threshold the settle is a no-op");
            let first = s.churn_counted();
            for reps in [1u32, 7, 100, 100_000] {
                s.churn_n(reps); // 7: a partial cycle of the block leaves no residue either
                assert_eq!(s.churn_counted(), first, "n={n}: drift after {reps} reps");
            }
            assert_eq!(s.slots(), built, "n={n}: a churn pair must restore the table as built");
        }
    }

    /// Why `set_churn_key` keeps one settle pass. At `n = 0.75 · cap` (6 keys in 8 slots,
    /// 3072 in 4096) a churn insert makes n + 1 keys and doubles the table. Counted without
    /// the settle, that first pair runs at the old load factor and every later one at the
    /// new — exactly the "depends on what the batcher ran first" drift the project forbids.
    #[test]
    fn a_churn_pair_at_the_threshold_settles_before_anything_is_counted() {
        let keys = shuffled_keys(3072);
        let n = 3072;
        // Unsettled: the first counted pair doubles the table, the second does not. One key
        // at a time, so each first pair is a single walk on the full old table; over 64 keys
        // the first and second counts must disagree somewhere (one key can land on an empty
        // home slot in both tables and hide it).
        let mut disagreements = 0;
        for j in 0..64 {
            let mut raw = HashSetBsF64::new(&keys, n);
            assert_eq!(raw.capacity(), 4096);
            raw.churn_keys = vec![1e9 + j as f64];
            let first = raw.churn_counted();
            assert_eq!(raw.capacity(), 8192, "the first churn insert doubled the table");
            let second = raw.churn_counted();
            assert_eq!(raw.churn_counted(), second, "from the second pair on it is fixed");
            if first != second {
                disagreements += 1;
            }
        }
        assert!(disagreements > 32, "the first pair measures a different table ({disagreements}/64)");
        let mut raw = HashSetBsF64::new(&keys, n);
        raw.churn_keys = (0..churn_block(n)).map(|j| 1e9 + j as f64).collect();
        let _ = raw.churn_counted();
        let second = raw.churn_counted();
        // Settled: `set_churn_key` doubles it up front, and every pair is the same.
        let mut s = HashSetBsF64::new(&keys, n);
        s.set_churn_key(1e9);
        assert_eq!(s.capacity(), 8192);
        let settled = s.slots();
        let c = s.churn_counted();
        s.churn_n(1000);
        assert_eq!(s.churn_counted(), c);
        assert_eq!(s.slots(), settled);
        assert_eq!(c, second, "the settled pair is the steady state the unsettled one reached");
        // One pass suffices: a second settle changes nothing.
        let rehashes = s.rehash_count();
        s.set_churn_key(1e9);
        assert_eq!(s.rehash_count(), rehashes);
    }

    #[test]
    fn build_and_teardown_round_trip() {
        let keys: Vec<f64> = (0..50).map(|i| i as f64).collect();
        assert_eq!(HashSetBsF64::build_insert_n(&keys, 50), 50);
        assert!(HashSetBsF64::build_insert_counted(&keys, 50) >= 50.0);
        let mut s = HashSetBsF64::new(&keys, 50);
        assert_eq!(s.teardown_all(), 50);
        assert_eq!(s.len(), 0);
        let teardown_ops = HashSetBsF64::teardown_counted(&keys, 50);
        assert!(teardown_ops >= 100.0 && teardown_ops < 50.0 * 12.0, "{teardown_ops}");
    }

    #[test]
    fn search_n_counts_hits() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_probes(&[2.0, 99.0]);
        assert_eq!(s.search_n(4), 2);
    }

    /// The `wrap` corpus case must really shift a key across the end of the table — the
    /// cyclic `(h, j]` test is where an Algorithm R twin usually goes wrong.
    #[test]
    fn the_wrap_corpus_case_shifts_across_the_end_of_the_table() {
        let c = corpus::cases().into_iter().find(|c| c.name == "wrap").unwrap();
        let mut s = HashSetBsF64::new(&c.keys, c.keys.len());
        let cap = s.capacity();
        let before = s.slots();
        assert!(before[cap - 1].is_some() && before[0].is_some(), "a run spans the wrap: {before:?}");
        assert_eq!(before[cap - 1], Some(c.deletes[0]));
        s.delete_one_counted(c.deletes[0]);
        let after = s.slots();
        let moved = after[cap - 1].expect("the hole at the last slot was refilled");
        assert!(
            before[..3].contains(&Some(moved)),
            "the key refilling slot {} came from across the wrap: {before:?} → {after:?}",
            cap - 1
        );
    }

    /// The `threshold` corpus case's churn really doubles the table in the settle.
    #[test]
    fn the_threshold_corpus_case_doubles_in_the_settle() {
        let c = corpus::cases().into_iter().find(|c| c.name == "threshold").unwrap();
        let mut s = HashSetBsF64::new(&c.keys, c.keys.len());
        assert_eq!((s.len(), s.capacity()), (6, 8));
        s.set_churn_key(corpus::churn_key_for(&c.keys));
        assert_eq!(s.capacity(), 16);
    }

    /// A fixed-seed permutation of `0..n` (xorshift; the open-addressing tests' generator).
    pub(crate) fn shuffled_keys(n: usize) -> Vec<f64> {
        let mut v: Vec<f64> = (0..n).map(|i| i as f64).collect();
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        for i in (1..n).rev() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let j = (state % (i as u64 + 1)) as usize;
            v.swap(i, j);
        }
        v
    }
}

/// Cross-language conformance corpus for the backward-shift set (docs/PLAN.md §12, risk R1)
/// — `conformance/corpus-hbs.txt`, which `src/structures/conformance-hbs.test.ts` holds the
/// TypeScript twin to.
///
/// Its dimension is the **slot layout** before deletes, after them and after re-inserts, as
/// for the tombstone set, plus the **shift split** of every delete (find walk vs shift
/// scan), which pins the counting rule for the scan on both sides. Cases beyond the
/// tombstone corpus's: `wrap`, a run that crosses the end of the table with a delete that
/// shifts a key back over the wrap, and `threshold`, a table sitting exactly at its load
/// threshold whose churn doubles it in the settle pass. (The tombstone corpus's `purge`
/// case has no counterpart: with no dead slots there is no purge.)
#[cfg(test)]
pub(crate) mod corpus {
    use super::{mix_f64, HashSetBsF64};

    const CORPUS_HBS_PATH: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-hbs.txt");

    pub(crate) struct Case {
        pub(crate) name: &'static str,
        pub(crate) keys: Vec<f64>,
        pub(crate) probes: Vec<f64>,
        pub(crate) deletes: Vec<f64>,
        pub(crate) reinserts: Vec<f64>,
    }

    /// The first `count` non-negative integers whose home slot in a `cap`-slot table is
    /// `slot` — computed, not hand-picked, so the cluster is real for this hash.
    fn keys_homed_at(slot: usize, cap: usize, count: usize) -> Vec<f64> {
        (0u32..)
            .map(f64::from)
            .filter(|&k| (mix_f64(k) as usize) & (cap - 1) == slot)
            .take(count)
            .collect()
    }

    pub(crate) fn cases() -> Vec<Case> {
        let zero_to_thirty: Vec<f64> = (0..=30).map(|i| i as f64).collect();
        // The tombstone corpus's cluster: five keys sharing home slot 3 of 8 and one homed at
        // 4, displaced by the run — here deleting the run's head shifts four keys back.
        let homed_three = keys_homed_at(3, 8, 6);
        let mut cluster = homed_three[..5].to_vec();
        cluster.push(keys_homed_at(4, 8, 1)[0]);
        let late_three = homed_three[5];
        // Three keys homed at the last slot of 8 and one homed at slot 0: the run wraps from
        // slot 7 into slots 0, 1, 2, and deleting the key in slot 7 must pull slot 0's back.
        vec![
            Case {
                name: "empty",
                keys: vec![],
                probes: vec![1.0, 2.0],
                deletes: vec![1.0],
                reinserts: vec![1.0],
            },
            Case {
                name: "singleton",
                keys: vec![42.0],
                probes: vec![42.0, 7.0],
                deletes: vec![42.0],
                reinserts: vec![42.0, 7.0],
            },
            Case {
                name: "ordered",
                keys: vec![10.0, 20.0, 30.0],
                probes: vec![10.0, 20.0, 30.0, 99.0],
                deletes: vec![20.0, 99.0, 10.0],
                reinserts: vec![20.0, 5.0],
            },
            Case {
                name: "duplicates",
                keys: vec![5.0, 5.0, 5.0, 7.0, 5.0, 9.0],
                probes: vec![5.0, 7.0, 9.0, 99.0],
                deletes: vec![5.0, 5.0, 9.0],
                reinserts: vec![5.0, 9.0, 11.0, 9.0],
            },
            Case {
                name: "rehash",
                keys: zero_to_thirty,
                probes: vec![0.0, 15.0, 30.0, 31.0, -1.0, 1000.0],
                deletes: vec![7.0, 0.0, 30.0, 15.0],
                reinserts: vec![15.0, 100.0, 7.0],
            },
            Case {
                name: "fractional",
                keys: vec![0.0, 0.5, 2.5, -1.0],
                probes: vec![0.5, 2.5, -1.0, 3.0],
                deletes: vec![0.5, -1.0],
                reinserts: vec![-1.0, 4.5],
            },
            Case {
                // Delete the run's head, then a middle key: each shift pulls the rest back.
                name: "cluster",
                probes: cluster.iter().copied().chain([late_three, 1000.0]).collect(),
                deletes: vec![cluster[0], cluster[2]],
                reinserts: vec![late_three, cluster[2]],
                keys: cluster,
            },
            wrap_case(),
            Case {
                // Six keys in eight slots: exactly at the threshold, so the churn insert (the
                // seventh key) doubles the table — inside `set_churn_key`'s settle pass.
                name: "threshold",
                keys: (0..6).map(|i| i as f64).collect(),
                probes: vec![0.0, 3.0, 5.0, 6.0],
                deletes: vec![0.0, 1.0],
                reinserts: vec![0.0, 100.0],
            },
            Case {
                // 100 keys ⇒ a churn block of three (`clamp(100 / 32, 1, 16)`).
                name: "block",
                keys: (0..100).map(|i| (i * 3) as f64).collect(),
                probes: vec![0.0, 150.0, 297.0, 298.0, 1000.0],
                deletes: vec![0.0, 150.0, 297.0, 151.0],
                reinserts: vec![150.0, 151.0],
            },
        ]
    }

    /// Three keys homed at the last slot of 8 and one homed at slot 0: the run wraps from
    /// slot 7 into slots 0, 1 and 2. The deletes are *read off the built layout* (which key
    /// lands in slot 7 depends on the rehash's re-placement order): first the key in slot 7,
    /// so the delete must pull slot 0's key back across the wrap, then the key now in slot 1.
    fn wrap_case() -> Case {
        let mut keys = keys_homed_at(7, 8, 3);
        keys.push(keys_homed_at(0, 8, 1)[0]);
        let mut m = HashSetBsF64::new(&keys, keys.len());
        let at7 = m.slots()[7].expect("the wrapping run starts in slot 7");
        m.delete_one_counted(at7);
        let at1 = m.slots()[1].expect("the run still reaches slot 1 after one delete");
        Case {
            name: "wrap",
            probes: keys.iter().copied().chain([1000.0]).collect(),
            deletes: vec![at7, at1],
            reinserts: vec![at7, at1],
            keys,
        }
    }

    fn fmt_nums(xs: &[f64]) -> String {
        xs.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" ")
    }

    fn fmt_flag_ops(results: &[(bool, u64)]) -> String {
        results
            .iter()
            .map(|&(f, ops)| format!("{}:{ops}", f as u8))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// One token per slot: `.` empty, otherwise the live key. (No `x`: nothing is a tombstone.)
    fn fmt_slots(s: &HashSetBsF64) -> String {
        s.slots()
            .iter()
            .map(|sl| match sl {
                None => ".".to_string(),
                Some(k) => format!("{k}"),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn fmt_shape(s: &HashSetBsF64) -> String {
        format!("{} {}", s.capacity(), s.len())
    }

    /// The churn key every case records: one past the largest key (`aboveMax`, the recipe
    /// the browser sweep uses), or 1 for an empty set.
    pub(crate) fn churn_key_for(keys: &[f64]) -> f64 {
        if keys.is_empty() {
            return 1.0;
        }
        keys.iter().copied().fold(f64::NEG_INFINITY, f64::max) + 1.0
    }

    pub(crate) fn serialize(cases: &[Case]) -> String {
        let mut out = String::new();
        out.push_str("# Mr Data Structure — backward-shift hash set conformance corpus (docs/PLAN.md §8, §12).\n");
        out.push_str("# Generated from the Rust bench impl (hash_set_bs.rs); the TS teaching twin must match.\n");
        out.push_str("# Op-count = hashes + slot probes (an occupied slot examined; the empty slot that ends a\n");
        out.push_str("# walk is free). A delete's shift scan costs a probe + a hash per occupied slot it\n");
        out.push_str("# examines; `hbs_shift` is that part of each `hbs_delete` count. `hbs_slots*` is the SLOT\n");
        out.push_str("# LAYOUT: one token per slot, `.` empty, else the live key. `hbs_shape*` = capacity live.\n");
        out.push_str("# `hbs_churn_keys` is the churn block set_churn_key(churn_key) builds (clamp(len/32, 1, 16)\n");
        out.push_str("# consecutive absent keys), `hbs_slots_churn` the layout after its settle pass, and\n");
        out.push_str("# `hbs_churn` the mean op-count of one counted pair per block key, from that state.\n");
        out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_hbs\n");
        for c in cases {
            let s = HashSetBsF64::new(&c.keys, c.keys.len());
            let search: Vec<(bool, u64)> =
                c.probes.iter().map(|&p| s.search_one_counted(p)).collect();

            let mut m = HashSetBsF64::new(&c.keys, c.keys.len());
            let split: Vec<(bool, u64, u64)> =
                c.deletes.iter().map(|&d| m.delete_one_split(d)).collect();
            let del: Vec<(bool, u64)> = split.iter().map(|&(f, a, b)| (f, a + b)).collect();
            let shift: Vec<f64> = split.iter().map(|&(_, _, b)| b as f64).collect();
            let slots_after = fmt_slots(&m);
            let search_after: Vec<(bool, u64)> =
                c.probes.iter().map(|&p| m.search_one_counted(p)).collect();
            let ins: Vec<(bool, u64)> =
                c.reinserts.iter().map(|&r| m.insert_one_counted(r)).collect();

            let churn_key = churn_key_for(&c.keys);
            let mut ch = HashSetBsF64::new(&c.keys, c.keys.len());
            ch.set_churn_key(churn_key);
            let churn_slots = fmt_slots(&ch);
            let churn_shape = fmt_shape(&ch);
            let churn_ops = ch.churn_counted();

            out.push('\n');
            out.push_str(&format!("case {}\n", c.name));
            out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
            out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
            out.push_str(&format!("hbs_order {}\n", fmt_nums(&s.keys_in_order())));
            out.push_str(&format!("hbs_search {}\n", fmt_flag_ops(&search)));
            out.push_str(&format!("hbs_slots {}\n", fmt_slots(&s)));
            out.push_str(&format!("hbs_shape {}\n", fmt_shape(&s)));
            out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
            out.push_str(&format!("hbs_delete {}\n", fmt_flag_ops(&del)));
            out.push_str(&format!("hbs_shift {}\n", fmt_nums(&shift)));
            out.push_str(&format!("hbs_slots_after {slots_after}\n"));
            out.push_str(&format!("hbs_search_after {}\n", fmt_flag_ops(&search_after)));
            out.push_str(&format!("reinserts {}\n", fmt_nums(&c.reinserts)));
            out.push_str(&format!("hbs_insert {}\n", fmt_flag_ops(&ins)));
            out.push_str(&format!("hbs_slots_final {}\n", fmt_slots(&m)));
            out.push_str(&format!("hbs_shape_final {}\n", fmt_shape(&m)));
            out.push_str(&format!("churn_key {}\n", fmt_nums(&[churn_key])));
            out.push_str(&format!("hbs_churn_keys {}\n", fmt_nums(&ch.churn_block_keys())));
            out.push_str(&format!("hbs_slots_churn {churn_slots}\n"));
            out.push_str(&format!("hbs_shape_churn {churn_shape}\n"));
            out.push_str(&format!("hbs_churn {churn_ops}\n"));
        }
        out
    }

    fn normalize(s: &str) -> String {
        s.replace('\r', "")
    }

    #[test]
    #[ignore = "writes the committed backward-shift corpus; run deliberately after a behavior change"]
    fn regen_corpus_hbs() {
        std::fs::write(CORPUS_HBS_PATH, serialize(&cases())).expect("write hbs corpus");
    }

    #[test]
    fn corpus_hbs_matches_committed() {
        let committed = std::fs::read_to_string(CORPUS_HBS_PATH).expect(
            "backward-shift corpus missing; generate it with: cargo test -- --ignored regen_corpus_hbs",
        );
        assert_eq!(
            normalize(&committed),
            normalize(&serialize(&cases())),
            "backward-shift conformance corpus is stale vs the Rust impl; \
             regenerate with: cargo test -- --ignored regen_corpus_hbs",
        );
    }
}
