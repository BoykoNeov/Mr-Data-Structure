//! Hash set with **open addressing / linear probing** (docs/PLAN.md §8 "Hashing", §13's
//! first open question) — the second hash set, built to be read *against* the chaining one
//! (`hash_set::HashSetF64`).
//!
//! **What is held equal, so the chart isolates the collision strategy.** The same hash
//! (`mix_f64`, the SplitMix64 finalizer over the key's bits), the same power-of-two table
//! starting at 4 slots, the same 0.75 growth threshold and the same doubling. At every n
//! the two tables therefore have the *same capacity and the same load factor α*; the only
//! thing that differs is where a colliding key goes. Chaining hangs it off its bucket in a
//! separate list; linear probing puts it in the next free slot of the one flat array, so
//! collisions from *neighbouring* home slots pile into one run (**primary clustering**).
//!
//! **Cost metric: hashes + slot probes**, counted on the chaining set's convention so the
//! two op-count curves line up unit for unit: one tick for the hash, one per *occupied*
//! slot examined (a live key compared, or a tombstone stepped over). The **empty slot that
//! ends a probe costs nothing**, exactly as reaching the end of a chain costs nothing —
//! in both structures a free header read (the bucket's length, the slot's state byte)
//! says "stop". So a miss costs 1 + (occupied slots passed), and Knuth's textbook probe
//! counts, which include that final empty slot, read one higher than this metric
//! (docs/METHODOLOGY.md §2.8).
//!
//! **Delete leaves a tombstone, and the tombstone policy is the measurement decision.**
//! Linear probing cannot simply empty a deleted slot — a later key whose probe passed
//! through it would become unreachable — so delete marks the slot `TOMB`: searches step
//! over it, inserts may reuse it. Three rules keep that honest under churn (thousands of
//! insert+delete pairs of one key at fixed n):
//!
//! 1. **Insert reuses the first tombstone on its path** — after walking on to the first
//!    empty slot to confirm the key is absent (set semantics). Without reuse every churn
//!    pair strands one more tombstone in the key's own cluster, so the probe walk grows by
//!    one slot per pair and the measured churn cost drifts with the *number of reps*
//!    the adaptive batcher happens to choose, not with n (pinned by
//!    `tests::without_tombstone_reuse_churn_drifts_with_repetition_count`).
//! 2. **Tombstones count toward the load factor.** The rehash trigger is
//!    `live + tombs > 0.75 · cap`, not `live > 0.75 · cap`. Otherwise a delete-heavy
//!    sequence can fill every slot with tombstones, and a miss — which only stops at an
//!    empty slot — would loop forever (a hung worker in the browser). The rehash then
//!    either **purges in place** (same capacity, tombstones dropped) when the live keys
//!    alone are at most half the threshold, or **doubles** — a pure function of
//!    `(live, tombs, cap)`, mirrored exactly by the TS twin. The table never shrinks,
//!    as in the chaining set.
//! 3. **`set_churn_key` runs one untimed priming pair per churn key.** Even with reuse,
//!    the *first* pair is cheaper than every later one: it places the key on an empty slot,
//!    while each later insert finds the key's own tombstone and must walk on past it to an
//!    empty slot before reusing it. Priming puts the table in that steady state before
//!    anything is timed or counted, so every pair — timed or counted, first or
//!    ten-thousandth — costs exactly the same
//!    (`tests::churn_cost_does_not_drift_with_repetition_count`).
//! 4. **Churn cycles a small block of keys, not one.** Under linear probing a single churn
//!    key's cost is the length of the one run its home slot lands in — heavy-tailed, so a
//!    one-key churn curve jumps several-fold between neighbouring sweep points with no
//!    trend behind the jumps (`tests::a_single_churn_key_samples_one_cluster`). The block is
//!    `max + 1, max + 2, …` (all absent), `clamp(len / 32, 1, 16)` keys long, and the counted
//!    signal is the mean per pair. Because every primed pair restores the table exactly
//!    (whichever tombstone a key reuses, it leaves one in the same place), the block's
//!    tombstones are fixed too, and they add at most ~3 % to the load.
//!
//! Semantics mirror the chaining set: a **set** (duplicates collapse on insert, first
//! occurrence wins), `len` is the stored distinct count, and `teardown_keys` keeps the
//! distinct keys in insertion order so teardown deletes each exactly once.
//!
//! **The 0.75 ceiling is a default, and an opt-in control can move it** (docs/PLAN.md §13,
//! "a load-factor control"). `with_max_load` and the `*_at` statics build the same table at
//! another threshold — 0.5, linear probing's usual ceiling, or 0.9 — with every rule above
//! unchanged and the threshold read in their place: rehash when `live + tombs > L · cap`,
//! purge in place when `live ≤ L · cap / 2`, else double. The chaining set stays at 0.75, so
//! at any other `L` the two tables no longer share a capacity at every n and the pair of lines
//! stops isolating the collision strategy; the UI says so wherever the curve travels. Every
//! constructor without a load (`new`, `build_insert_n`, …) is exactly the 0.75 table.

use super::mix_f64;
use wasm_bindgen::prelude::*;

const INITIAL_SLOTS: usize = 4;
/// Rehash when `(live + tombstones) / slots` would exceed this — the chaining set's 0.75, and
/// the threshold of every constructor that does not take one.
const MAX_LOAD: f64 = 0.75;
/// The lowest threshold `with_max_load` accepts. At `L ≥ 0.25` a 4-slot table already has
/// `L · cap ≥ 1`, so one doubling always restores `live + tombs ≤ L · cap` (the invariant the
/// insert's "an empty slot exists" relies on); below it a single doubling may not.
const MIN_MAX_LOAD: f64 = 0.25;

/// Reject a threshold the load invariant cannot hold at: `L < 1` leaves at least one empty
/// slot at rest (`⌊L · cap⌋ ≤ cap − 1`), so every miss terminates; `L ≥ 0.25` keeps a single
/// rehash sufficient (see [`MIN_MAX_LOAD`]). A panic here traps the wasm call — the UI only
/// offers fixed values, so reaching it is a caller error, never a user one.
fn checked_load(max_load: f64) -> f64 {
    assert!(
        (MIN_MAX_LOAD..1.0).contains(&max_load),
        "open-addressing max load {max_load} outside [{MIN_MAX_LOAD}, 1)"
    );
    max_load
}

const EMPTY: u8 = 0;
const LIVE: u8 = 1;
const TOMB: u8 = 2;

/// A set of distinct `f64` keys stored in one flat, linearly-probed table. Slot state lives
/// in its own byte array rather than in a sentinel key, because every f64 can be a real key.
#[wasm_bindgen]
pub struct HashSetOaF64 {
    keys: Vec<f64>,
    state: Vec<u8>,
    len: usize,
    tombs: usize,
    probes: Vec<f64>,
    /// The block of spare keys cycled in/out by `churn_n` (docs/PLAN.md §6.3), all absent
    /// and all primed (module doc, rules 3–4).
    churn_keys: Vec<f64>,
    /// Which key of the block the next timed churn pair uses.
    churn_cursor: usize,
    /// Rehashes so far (doublings and purges) — how priming detects its fixed point.
    rehashes: u32,
    /// Distinct keys captured at build time, in insertion order (see the module doc).
    teardown_keys: Vec<f64>,
    /// The rehash threshold `L` (module doc): [`MAX_LOAD`] unless built `with_max_load`.
    max_load: f64,
}

/// Most churn keys a block holds (module doc, rule 4).
const CHURN_BLOCK_MAX: usize = 16;
/// At most one churn key per this many stored keys, so the block's tombstones stay a
/// rounding error on the load factor (≤ ~3 %).
const KEYS_PER_CHURN_KEY: usize = 32;
/// Stabilisation passes `set_churn_key` may run after the first (two suffice in practice:
/// after a mid-block rehash the table sits far below its threshold). A defensive bound.
const MAX_PRIMING_PASSES: usize = 8;

/// How many churn keys a set of `len` stored keys churns: `clamp(len / 32, 1, 16)`.
pub fn churn_block(len: usize) -> usize {
    (len / KEYS_PER_CHURN_KEY).clamp(1, CHURN_BLOCK_MAX)
}

#[wasm_bindgen]
impl HashSetOaF64 {
    /// Build from the first `n` keys of a marshalled `Float64Array`. Building (including any
    /// rehashes) is untimed (docs/PLAN.md §6.3, "search is size-preserving").
    #[wasm_bindgen(constructor)]
    pub fn new(keys: &[f64], n: usize) -> HashSetOaF64 {
        HashSetOaF64::with_max_load(keys, n, MAX_LOAD)
    }

    /// As [`HashSetOaF64::new`], at rehash threshold `max_load` instead of 0.75 (module doc;
    /// docs/PLAN.md §13). Panics outside `[0.25, 1)` — see `checked_load`.
    pub fn with_max_load(keys: &[f64], n: usize, max_load: f64) -> HashSetOaF64 {
        let n = n.min(keys.len());
        let mut set = HashSetOaF64::empty_at(max_load);
        let mut ops = 0u64;
        for &k in &keys[..n] {
            if set.insert_generic::<false, true>(k, &mut ops) {
                set.teardown_keys.push(k); // distinct keys only
            }
        }
        set
    }

    /// The rehash threshold this table was built with.
    pub fn max_load(&self) -> f64 {
        self.max_load
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

    /// Set the spare churn keys and prime them (module doc, rule 3). `key` must be absent —
    /// the sweep passes `max + 1` — and the set churns a small **block** of consecutive keys
    /// `key, key + 1, …` rather than `key` alone (rule 4): `churn_block(len)` of them, at
    /// most 16 and never more than one per 32 stored keys, so the tombstones they leave add
    /// at most ~3 % to the load the measurement sees. Each is primed with one untimed
    /// insert+delete pair, after which every pair — timed or counted, first or
    /// ten-thousandth — restores the table exactly. A key that turns out to be present
    /// (a caller error) is dropped from the block rather than primed, since its "delete"
    /// would remove a real key.
    ///
    /// Priming repeats whole passes over the block until one changes nothing — no rehash
    /// and no new tombstone. One pass is not always enough: a key primed mid-block can tip
    /// the table over its threshold, and the rehash then purges the tombstones of the keys
    /// primed before it, whose next pair would land on an empty slot again. A pass in which
    /// every key reuses a tombstone restores the table exactly, so that is the fixed point.
    pub fn set_churn_key(&mut self, key: f64) {
        self.churn_keys.clear();
        self.churn_cursor = 0;
        let block = churn_block(self.len);
        let mut ops = 0u64;
        for j in 0..block {
            let k = key + j as f64;
            if self.insert_generic::<false, true>(k, &mut ops) {
                let _ = self.remove_key::<false>(k, &mut ops);
                self.churn_keys.push(k);
            }
        }
        for _ in 0..MAX_PRIMING_PASSES {
            let (tombs, rehashes) = (self.tombs, self.rehashes);
            for j in 0..self.churn_keys.len() {
                let k = self.churn_keys[j];
                self.insert_generic::<false, true>(k, &mut ops);
                let _ = self.remove_key::<false>(k, &mut ops);
            }
            if self.tombs == tombs && self.rehashes == rehashes {
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
            self.insert_generic::<false, true>(key, &mut ops);
            if self.remove_key::<false>(key, &mut ops) {
                hits += 1;
            }
        }
        hits
    }

    /// Op-count signal (§6.4) for *one* churn pair: the **mean** hashes + slot probes of one
    /// counted insert+delete per key in the block — one pair stays one unit, as the trees'
    /// two-key churn averages rather than sums. Every pair nets zero change (size,
    /// tombstones and layout alike), so this is exact whatever the cursor position.
    pub fn churn_counted(&mut self) -> f64 {
        let block = self.churn_keys.len();
        if block == 0 {
            return 0.0;
        }
        let mut ops = 0u64;
        for j in 0..block {
            let key = self.churn_keys[j];
            self.insert_generic::<true, true>(key, &mut ops);
            let _ = self.remove_key::<true>(key, &mut ops);
        }
        ops as f64 / block as f64
    }

    // ── Mutation: cumulative build / teardown (docs/PLAN.md §6.3, cross-check) ──

    /// Timed: build a fresh set of size `n` from empty (rehashes amortized in). Returns
    /// `len` to defeat DCE.
    pub fn build_insert_n(keys: &[f64], n: usize) -> u32 {
        HashSetOaF64::build_insert_n_at(keys, n, MAX_LOAD)
    }

    /// [`HashSetOaF64::build_insert_n`] at threshold `max_load`.
    pub fn build_insert_n_at(keys: &[f64], n: usize, max_load: f64) -> u32 {
        HashSetOaF64::with_max_load(keys, n, max_load).len as u32
    }

    /// Op-count for the cumulative build to size `n`: total hashes + slot probes of the
    /// per-insert dedupe walks (rehash redistribution is amortized structural work and is
    /// deliberately not counted, as in the chaining set).
    pub fn build_insert_counted(keys: &[f64], n: usize) -> f64 {
        HashSetOaF64::build_insert_counted_at(keys, n, MAX_LOAD)
    }

    /// [`HashSetOaF64::build_insert_counted`] at threshold `max_load`.
    pub fn build_insert_counted_at(keys: &[f64], n: usize, max_load: f64) -> f64 {
        let n = n.min(keys.len());
        let mut s = HashSetOaF64::empty_at(max_load);
        let mut ops = 0u64;
        for &k in &keys[..n] {
            s.insert_generic::<true, true>(k, &mut ops);
        }
        ops as f64
    }

    /// Timed: delete every stored key in insertion order, leaving only tombstones. Built
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

    /// Op-count for a full size-`n` teardown. Each delete leaves a tombstone, and later
    /// deletes step over earlier ones, so every delete costs what a successful search did
    /// in the full table — O(1) each, O(n) in total.
    pub fn teardown_counted(keys: &[f64], n: usize) -> f64 {
        HashSetOaF64::teardown_counted_at(keys, n, MAX_LOAD)
    }

    /// [`HashSetOaF64::teardown_counted`] at threshold `max_load`.
    pub fn teardown_counted_at(keys: &[f64], n: usize, max_load: f64) -> f64 {
        let mut s = HashSetOaF64::with_max_load(keys, n, max_load);
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
        HashSetOaF64::build_then_teardown_n_at(keys, n, MAX_LOAD)
    }

    /// [`HashSetOaF64::build_then_teardown_n`] at threshold `max_load`.
    pub fn build_then_teardown_n_at(keys: &[f64], n: usize, max_load: f64) -> u32 {
        let mut s = HashSetOaF64::with_max_load(keys, n, max_load);
        s.teardown_all()
    }
}

impl HashSetOaF64 {
    fn empty_at(max_load: f64) -> HashSetOaF64 {
        HashSetOaF64 {
            max_load: checked_load(max_load),
            keys: vec![0.0; INITIAL_SLOTS],
            state: vec![EMPTY; INITIAL_SLOTS],
            len: 0,
            tombs: 0,
            probes: Vec::new(),
            churn_keys: Vec::new(),
            churn_cursor: 0,
            rehashes: 0,
            teardown_keys: Vec::new(),
        }
    }

    #[inline]
    fn home(&self, key: f64) -> usize {
        // Power-of-two table ⇒ mask instead of modulo; the same low bits the chaining set
        // reads, so a key's home slot here is its bucket there.
        (mix_f64(key) as usize) & (self.state.len() - 1)
    }

    /// The one search algorithm, generic over counting: hash, then walk forward from the
    /// home slot until the key or an empty slot. One tick for the hash and one per occupied
    /// slot examined (live compared, or tombstone stepped over); the empty slot that ends
    /// the walk is free. Bounded by the capacity defensively — the load invariant already
    /// guarantees an empty slot.
    #[inline]
    fn contains<const COUNT: bool>(&self, target: f64, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let mask = self.state.len() - 1;
        let mut i = self.home(target);
        for _ in 0..self.state.len() {
            match self.state[i] {
                EMPTY => return false,
                LIVE => {
                    if COUNT {
                        *ops += 1; // slot probe (key compared)
                    }
                    if self.keys[i] == target {
                        return true;
                    }
                }
                _ => {
                    if COUNT {
                        *ops += 1; // slot probe (tombstone stepped over)
                    }
                }
            }
            i = (i + 1) & mask;
        }
        false
    }

    /// The one insert algorithm, generic over counting and over the tombstone policy.
    /// Walk from the home slot to the first empty slot to dedupe (same ticks as search),
    /// remembering the first tombstone passed; place the key there when `REUSE` (the real
    /// policy), else in the empty slot that ended the walk (the naive policy, kept only so
    /// a test can show the drift it causes). Then rehash if live + tombstones exceed the
    /// load threshold. Returns whether the key was newly stored.
    #[inline]
    fn insert_generic<const COUNT: bool, const REUSE: bool>(
        &mut self,
        key: f64,
        ops: &mut u64,
    ) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let cap = self.state.len();
        let mask = cap - 1;
        let mut i = self.home(key);
        let mut first_tomb: Option<usize> = None;
        let mut empty: Option<usize> = None;
        for _ in 0..cap {
            match self.state[i] {
                EMPTY => {
                    empty = Some(i);
                    break;
                }
                LIVE => {
                    if COUNT {
                        *ops += 1; // slot probe (dedupe check)
                    }
                    if self.keys[i] == key {
                        return false; // already present
                    }
                }
                _ => {
                    if COUNT {
                        *ops += 1; // slot probe (tombstone stepped over)
                    }
                    if REUSE && first_tomb.is_none() {
                        first_tomb = Some(i);
                    }
                }
            }
            i = (i + 1) & mask;
        }
        let slot = match first_tomb {
            Some(t) => {
                self.tombs -= 1;
                t
            }
            None => empty.expect("load invariant: live + tombstones <= max_load * cap leaves an empty slot"),
        };
        self.state[slot] = LIVE;
        self.keys[slot] = key;
        self.len += 1;
        if (self.len + self.tombs) as f64 > self.max_load * cap as f64 {
            self.rehash();
        }
        true
    }

    /// The one delete algorithm, generic over counting: walk as search does; on a hit, mark
    /// the slot a tombstone. Returns whether a key was removed.
    #[inline]
    fn remove_key<const COUNT: bool>(&mut self, target: f64, ops: &mut u64) -> bool {
        if COUNT {
            *ops += 1; // the hash
        }
        let mask = self.state.len() - 1;
        let mut i = self.home(target);
        for _ in 0..self.state.len() {
            match self.state[i] {
                EMPTY => return false,
                LIVE => {
                    if COUNT {
                        *ops += 1; // slot probe
                    }
                    if self.keys[i] == target {
                        self.state[i] = TOMB;
                        self.len -= 1;
                        self.tombs += 1;
                        return true;
                    }
                }
                _ => {
                    if COUNT {
                        *ops += 1; // slot probe (tombstone stepped over)
                    }
                }
            }
            i = (i + 1) & mask;
        }
        false
    }

    /// Rebuild the table without tombstones. **Purge in place** (same capacity) when the
    /// live keys alone are at most half the threshold, otherwise **double** — so a build
    /// with no deletes doubles at exactly the chaining set's points, and a churn- or
    /// delete-heavy table is cleaned rather than grown. Live keys are re-placed by walking
    /// the old slots in index order, each into the first empty slot from its new home: the
    /// order the TS twin mirrors, since it fixes the layout and so every probe count.
    fn rehash(&mut self) {
        let cap = self.state.len();
        let new_cap = if self.len as f64 > self.max_load * cap as f64 / 2.0 { cap * 2 } else { cap };
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
        self.tombs = 0;
        self.rehashes = self.rehashes.wrapping_add(1);
    }

    /// Test/conformance helper: membership + (hashes + slot probes) for one search.
    pub fn search_one_counted(&self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let found = self.contains::<true>(target, &mut ops);
        (found, ops)
    }

    /// Test/conformance helper: insert `target`, returning `(newly stored, hashes + slot
    /// probes)`. Mutates the set (and may rehash it).
    pub fn insert_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let inserted = self.insert_generic::<true, true>(target, &mut ops);
        (inserted, ops)
    }

    /// Test/conformance helper: delete `target`, returning `(removed, hashes + slot probes)`.
    pub fn delete_one_counted(&mut self, target: f64) -> (bool, u64) {
        let mut ops = 0u64;
        let removed = self.remove_key::<true>(target, &mut ops);
        (removed, ops)
    }

    /// Number of slots in the table.
    pub fn capacity(&self) -> usize {
        self.state.len()
    }

    /// Number of tombstones currently in the table.
    pub fn tombstones(&self) -> usize {
        self.tombs
    }

    /// Live keys in slot order — the open-addressing set's iteration order. A conformance
    /// hook (docs/PLAN.md §12); not on the wasm surface.
    pub fn keys_in_order(&self) -> Vec<f64> {
        (0..self.state.len()).filter(|&i| self.state[i] == LIVE).map(|i| self.keys[i]).collect()
    }

    /// The raw table, one entry per slot: `Some(Some(k))` live, `Some(None)` tombstone,
    /// `None` empty — the corpus's layout dimension (where every key sits, and every
    /// tombstone), which a twin with a different reuse or purge rule cannot reproduce even
    /// when it answers every membership query correctly.
    pub fn slots(&self) -> Vec<Option<Option<f64>>> {
        (0..self.state.len())
            .map(|i| match self.state[i] {
                EMPTY => None,
                LIVE => Some(Some(self.keys[i])),
                _ => Some(None),
            })
            .collect()
    }

    /// Longest run of occupied (live or tombstone) slots, wrapping around the end — the
    /// primary-clustering statistic. A test hook.
    pub fn max_cluster(&self) -> usize {
        let cap = self.state.len();
        let Some(start) = (0..cap).find(|&i| self.state[i] == EMPTY) else {
            return cap;
        };
        let (mut best, mut run) = (0usize, 0usize);
        for step in 1..=cap {
            if self.state[(start + step) % cap] == EMPTY {
                run = 0;
            } else {
                run += 1;
                best = best.max(run);
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(keys: &[f64]) -> HashSetOaF64 {
        HashSetOaF64::new(keys, keys.len())
    }

    #[test]
    fn membership_is_correct() {
        let s = set(&[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert!(s.search_one_counted(3.0).0);
        assert!(!s.search_one_counted(99.0).0);
    }

    #[test]
    fn dedupes_on_insert_and_tears_down_each_distinct_key_once() {
        let mut s = set(&[5.0, 5.0, 7.0, 5.0, 9.0]);
        assert_eq!(s.len(), 3);
        assert_eq!(s.teardown_all(), 3); // not 5
        assert_eq!(s.len(), 0);
        assert_eq!(s.tombstones(), 3);
    }

    /// The chaining set's growth rule, restated from `hash_set.rs` (start at 4 buckets,
    /// double whenever `len > 0.75 · buckets`) so this test needs no hook in that file.
    pub(crate) fn chaining_capacity(distinct: usize) -> usize {
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
        // Same 4-slot start, same 0.75 threshold, same doubling: equal capacity at every n,
        // so the two hash sets share a load factor point for point (module doc).
        let keys: Vec<f64> = (0..5000).map(|i| i as f64).collect();
        for n in [0usize, 1, 3, 4, 7, 10, 20, 50, 100, 500, 1000, 4000, 5000] {
            let oa = HashSetOaF64::new(&keys, n);
            assert_eq!(oa.capacity(), chaining_capacity(n), "n={n}");
        }
    }

    #[test]
    fn a_hit_on_its_home_slot_costs_what_a_chain_head_hit_costs() {
        // Unit-for-unit with the chaining set: hash + one probe.
        let s = set(&[42.0]);
        assert_eq!(s.search_one_counted(42.0), (true, 2));
        // The empty slot that ends a miss is free, as the end of a chain is.
        let empty = set(&[]);
        assert_eq!(empty.search_one_counted(1.0), (false, 1));
    }

    #[test]
    fn search_walks_past_a_tombstone_to_reach_a_key_behind_it() {
        // Build a cluster, delete its head, and the key behind it must still be found —
        // the reason a deleted slot cannot simply be emptied.
        let keys: Vec<f64> = (0..200).map(|i| i as f64).collect();
        let mut s = set(&keys);
        // Find a key that sits displaced from its home slot (part of a cluster).
        let slots = s.slots();
        let mask = s.capacity() - 1;
        let (pos, displaced) = slots
            .iter()
            .enumerate()
            .find_map(|(i, sl)| match sl {
                Some(Some(k)) if (mix_f64(*k) as usize & mask) != i => Some((i, *k)),
                _ => None,
            })
            .expect("200 keys in 512 slots must collide somewhere");
        let blocker = match slots[(pos + mask) & mask] {
            Some(Some(k)) => k,
            _ => unreachable!("a displaced key's predecessor slot is occupied"),
        };
        let (_, before) = s.search_one_counted(displaced);
        assert!(s.delete_one_counted(blocker).0);
        let (found, after) = s.search_one_counted(displaced);
        assert!(found, "a key behind a tombstone must stay reachable");
        assert_eq!(after, before, "the tombstone still costs the probe the live key did");
    }

    #[test]
    fn tombstones_count_toward_the_load_factor_so_a_miss_always_terminates() {
        // Fill, tear down, refill with *different* keys, over and over. If tombstones did
        // not count toward the load, the table would end up with no empty slot and a miss
        // would never stop. With the purge rule the table stays bounded and clean.
        let mut s = set(&(0..6).map(|i| i as f64).collect::<Vec<_>>());
        for round in 0..200 {
            let base = (round * 100) as f64;
            for k in 0..6 {
                s.insert_one_counted(base + k as f64);
            }
            for k in 0..6 {
                s.delete_one_counted(base + k as f64);
            }
            assert!(
                s.len() + s.tombstones() <= (MAX_LOAD * s.capacity() as f64) as usize,
                "round {round}: live {} + tombs {} over the threshold of {} slots",
                s.len(),
                s.tombstones(),
                s.capacity()
            );
            assert!(!s.search_one_counted(-1.0).0); // terminates
        }
        // Purged rather than grown: six live keys never needed more than 16 slots.
        assert!(s.capacity() <= 16, "capacity grew to {}", s.capacity());
    }

    #[test]
    fn churn_holds_size_and_leaves_exactly_one_tombstone() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_churn_key(99.0); // absent; primes one pair
        assert_eq!(s.tombstones(), 1);
        s.churn_n(10);
        assert_eq!(s.len(), 3);
        assert_eq!(s.tombstones(), 1, "reuse keeps churn to one tombstone");
        assert!(!s.search_one_counted(99.0).0);
        assert!(s.churn_counted() >= 2.0);
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn a_present_churn_key_is_not_primed_away() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_churn_key(2.0); // a caller error — priming must not delete a real key
        assert_eq!(s.len(), 3);
        assert!(s.search_one_counted(2.0).0);
    }

    /// **The policy pin (docs/METHODOLOGY.md §2.8).** At fixed n, the op-count of one churn
    /// pair is the same whether it is read straight after `set_churn_key`, or after 1, 100
    /// or 100 000 timed pairs — so neither the adaptive batcher's choice of `k` nor the
    /// order `measure.ts` interleaves timed and counted calls can move the signal. And the
    /// table's layout after any number of pairs is the layout after the priming pair.
    #[test]
    fn churn_cost_does_not_drift_with_repetition_count() {
        let keys = shuffled_keys(3000);
        for n in [250usize, 1000, 3000] {
            let mut s = HashSetOaF64::new(&keys, n);
            s.set_churn_key(1e9);
            let primed = s.slots();
            let tombs = s.tombstones();
            assert!(tombs >= 1 && tombs <= churn_block(n), "n={n}: {tombs} tombstones");
            let first = s.churn_counted();
            for reps in [1u32, 7, 100, 100_000] {
                s.churn_n(reps); // 7: a partial cycle of the block leaves no residue either
                assert_eq!(s.churn_counted(), first, "n={n}: drift after {reps} reps");
            }
            assert_eq!(s.slots(), primed, "n={n}: a churn pair must restore the layout");
            assert_eq!(s.tombstones(), tombs);
        }
    }

    /// Why rule 3 exists: without the priming pair, the *first* pair is cheaper than the
    /// rest — it lands on an empty slot, while every later insert walks past the key's own
    /// tombstone to the next empty slot before reusing it. A difference of at least one
    /// probe, exactly on the boundary the counted call could fall either side of.
    #[test]
    fn an_unprimed_first_pair_is_cheaper_than_the_steady_state() {
        let keys = shuffled_keys(1000);
        let mut s = HashSetOaF64::new(&keys, 1000);
        s.churn_keys = vec![1e9]; // set without priming
        let first = s.churn_counted();
        let second = s.churn_counted();
        let third = s.churn_counted();
        assert!(second > first, "steady state {second} must exceed the unprimed first pair {first}");
        assert_eq!(third, second, "and from the second pair on it is fixed");
    }

    /// **The landmine rule 1 defuses.** With the naive policy — always place the key in the
    /// empty slot that ended the dedupe walk, never in a tombstone — every churn pair strands
    /// one more tombstone in the churn key's own cluster, so the walk grows by a slot per
    /// pair until the load-factor purge finally fires. The *mean* cost per pair then depends
    /// on how many pairs were run: exactly what the adaptive batcher varies. And because the
    /// headroom before a purge is proportional to the table size, a naive churn curve would
    /// rise with n — an O(1) structure reported as growing.
    #[test]
    fn without_tombstone_reuse_churn_drifts_with_repetition_count() {
        let keys = shuffled_keys(2000);
        let mean_naive = |n: usize, reps: usize| -> f64 {
            let mut s = HashSetOaF64::new(&keys, n);
            let key = 1e9;
            let mut ops = 0u64;
            for _ in 0..reps {
                s.insert_generic::<true, false>(key, &mut ops);
                s.remove_key::<true>(key, &mut ops);
            }
            ops as f64 / reps as f64
        };
        let mean_real = |n: usize, reps: u32| -> f64 {
            let mut s = HashSetOaF64::new(&keys, n);
            s.set_churn_key(1e9);
            s.churn_n(reps);
            s.churn_counted()
        };
        // Real policy: identical at 10 and 300 reps.
        assert_eq!(mean_real(2000, 10), mean_real(2000, 300));
        // Naive policy: the mean pair cost climbs with the rep count at fixed n …
        let (few, many) = (mean_naive(2000, 10), mean_naive(2000, 300));
        assert!(many > 5.0 * few, "naive churn must drift: {few} at 10 reps vs {many} at 300");
        // … and at a fixed rep budget it reads higher on the bigger table (more headroom
        // before the purge), so the drift masquerades as growth in n.
        assert!(mean_naive(2000, 600) > mean_naive(250, 600));
    }

    #[test]
    fn insert_reuses_the_first_tombstone_on_its_path() {
        let keys: Vec<f64> = (0..200).map(|i| i as f64).collect();
        let mut s = set(&keys);
        assert!(s.delete_one_counted(17.0).0);
        assert_eq!(s.tombstones(), 1);
        let cap = s.capacity();
        // Re-inserting the same key lands back on its own tombstone.
        let before = s.slots();
        assert!(s.insert_one_counted(17.0).0);
        assert_eq!(s.tombstones(), 0);
        assert_eq!(s.capacity(), cap);
        let after = s.slots();
        let diffs: Vec<usize> = (0..cap).filter(|&i| before[i] != after[i]).collect();
        assert_eq!(diffs.len(), 1, "exactly the tombstone slot changed");
        assert_eq!(after[diffs[0]], Some(Some(17.0)));
    }

    #[test]
    fn build_and_teardown_round_trip() {
        let keys: Vec<f64> = (0..50).map(|i| i as f64).collect();
        assert_eq!(HashSetOaF64::build_insert_n(&keys, 50), 50);
        assert!(HashSetOaF64::build_insert_counted(&keys, 50) >= 50.0);
        let mut s = HashSetOaF64::new(&keys, 50);
        assert_eq!(s.teardown_all(), 50);
        assert_eq!(s.len(), 0);
        let teardown_ops = HashSetOaF64::teardown_counted(&keys, 50);
        assert!(teardown_ops >= 100.0 && teardown_ops < 50.0 * 8.0, "{teardown_ops}");
    }

    #[test]
    fn search_n_counts_hits() {
        let mut s = set(&[1.0, 2.0, 3.0]);
        s.set_probes(&[2.0, 99.0]);
        assert_eq!(s.search_n(4), 2);
    }

    /// Churn one key only, primed — the chaining set's old recipe, kept here as the contrast.
    fn single_key_churn(keys: &[f64], n: usize, key: f64) -> f64 {
        let mut s = HashSetOaF64::new(keys, n);
        let (inserted, _) = s.insert_one_counted(key);
        assert!(inserted);
        s.delete_one_counted(key);
        s.churn_keys = vec![key];
        s.churn_counted()
    }

    /// **Why churn cycles a block (module doc, rule 4; docs/METHODOLOGY.md §2.8).** The
    /// chaining set once churned a single `max + 1` key (it now churns this same block, for
    /// a milder form of the same reason — `hash_set::tests::a_single_churn_key_samples_one_bucket`).
    /// Under linear probing that key's cost is
    /// the length of whichever run its home slot falls in — a heavy-tailed quantity — so a
    /// one-key churn curve jumps several-fold between neighbouring sweep points with no
    /// trend behind the jumps, and a fitted slope through it is luck. The real recipe (the
    /// block `set_churn_key` builds) is far steadier; a 64-key average is the reference
    /// underneath both. Measured on two key sets over the mutation ladder 250 … 4000: one
    /// key 9, 8, 4, 26, 13 (a 6.5× swing) and 5, 4, 11, 5, 11 (2.75×); the block 7.8 … 11.5
    /// (1.47×) and 5.8 … 9.0 (1.55×); the 64-key mean within 1.31× and 1.18×.
    #[test]
    fn a_single_churn_key_samples_one_cluster() {
        let swing = |v: &[f64]| {
            v.iter().copied().fold(f64::MIN, f64::max) / v.iter().copied().fold(f64::MAX, f64::min)
        };
        let ladder = [250usize, 500, 1000, 2000, 4000];
        let key_sets: [Vec<f64>; 2] = [
            shuffled_keys(4000),
            shuffled_keys(4000).iter().map(|k| k * 7.0 + 3.0).collect(),
        ];
        let mut worst_single: f64 = 0.0;
        for keys in &key_sets {
            let (mut single, mut block, mut mean) = (Vec::new(), Vec::new(), Vec::new());
            for &n in &ladder {
                let max = keys[..n].iter().copied().fold(f64::NEG_INFINITY, f64::max);
                single.push(single_key_churn(keys, n, max + 1.0));
                let mut s = HashSetOaF64::new(keys, n);
                s.set_churn_key(max + 1.0);
                block.push(s.churn_counted());
                let m: f64 = (0..64).map(|j| single_key_churn(keys, n, max + 1.0 + j as f64)).sum();
                mean.push(m / 64.0);
            }
            worst_single = worst_single.max(swing(&single));
            assert!(swing(&block) < 2.0, "the block recipe is steady: {block:?}");
            assert!(swing(&block) < swing(&single), "and steadier than one key: {block:?}");
            assert!(swing(&mean) < 1.5, "the 64-key mean is smooth: {mean:?}");
        }
        assert!(worst_single > 3.0, "one key jumps several-fold between sweep points");
    }

    /// The `purge` corpus case must really exercise the same-size purge (rehash rule 2's
    /// other branch) — otherwise the corpus would pin only the doubling path and a twin
    /// that always doubled would pass it.
    #[test]
    fn the_purge_corpus_case_really_purges() {
        let c = corpus::cases().into_iter().find(|c| c.name == "purge").unwrap();
        let mut s = HashSetOaF64::new(&c.keys, c.keys.len());
        let cap = s.capacity();
        for &d in &c.deletes {
            s.delete_one_counted(d);
        }
        assert_eq!(s.tombstones(), 4);
        // A reuse drops the tombstone count by exactly one; only a purge drops it by more.
        let before = s.tombstones();
        assert!(s.insert_one_counted(c.reinserts[0]).0);
        assert_eq!(s.tombstones(), 0, "the first re-insert must purge (it was {before})");
        assert_eq!(s.capacity(), cap, "purged in place, not grown");
        assert_eq!(s.len(), 3);
    }

    /// The `cluster` case's keys really do share one home slot, so its layout line pins a
    /// genuine primary-clustering run rather than scattered keys.
    #[test]
    fn the_cluster_corpus_case_is_a_real_cluster() {
        let c = corpus::cases().into_iter().find(|c| c.name == "cluster").unwrap();
        let s = HashSetOaF64::new(&c.keys, c.keys.len());
        assert!(s.max_cluster() >= 5, "max cluster {}", s.max_cluster());
    }

    // ── The load-factor control (module doc; docs/PLAN.md §13) ──
    //
    // Every rule above is stated in terms of the threshold `L`, so the other thresholds get
    // the same pins at their own `L`. The TS twin (`src/structures/hashSetOa.test.ts`) holds
    // the same literal lists, which is what ties the two twins at a load the corpus (0.75
    // only) never sees.

    /// The growth rule at threshold `l`: start at 4 slots, double whenever `len > l · slots`.
    fn capacity_at(distinct: usize, l: f64) -> usize {
        let mut slots = 4usize;
        for len in 1..=distinct {
            if len as f64 > l * slots as f64 {
                slots *= 2;
            }
        }
        slots
    }

    const GROWTH_NS: [usize; 15] = [0, 1, 2, 3, 4, 5, 7, 10, 20, 50, 100, 500, 1000, 4000, 5000];

    #[test]
    fn grows_at_each_thresholds_own_points() {
        let keys: Vec<f64> = (0..5000).map(|i| i as f64).collect();
        let literal: [(f64, [usize; 15]); 3] = [
            (0.5, [4, 4, 4, 8, 8, 16, 16, 32, 64, 128, 256, 1024, 2048, 8192, 16384]),
            (0.75, [4, 4, 4, 4, 8, 8, 16, 16, 32, 128, 256, 1024, 2048, 8192, 8192]),
            (0.9, [4, 4, 4, 4, 8, 8, 8, 16, 32, 64, 128, 1024, 2048, 8192, 8192]),
        ];
        for (l, caps) in literal {
            for (i, &n) in GROWTH_NS.iter().enumerate() {
                let s = HashSetOaF64::with_max_load(&keys, n, l);
                assert_eq!(s.capacity(), caps[i], "L={l} n={n}");
                assert_eq!(s.capacity(), capacity_at(n, l), "L={l} n={n}: the restated rule");
                assert!(s.len() as f64 <= l * s.capacity() as f64, "L={l} n={n}: over the threshold");
            }
        }
        // 0.75 *is* the chaining set's rule, so the default pin above still holds through here.
        for &n in &GROWTH_NS {
            assert_eq!(capacity_at(n, 0.75), chaining_capacity(n));
        }
    }

    /// Every constructor without a load is the 0.75 table, slot for slot and count for count —
    /// so the default page measures exactly what it measured before the control existed.
    #[test]
    fn the_constructors_without_a_load_are_the_075_table() {
        let keys = shuffled_keys(3000);
        for n in [0usize, 7, 100, 1000, 3000] {
            let (a, b) = (HashSetOaF64::new(&keys, n), HashSetOaF64::with_max_load(&keys, n, 0.75));
            assert_eq!(a.slots(), b.slots(), "n={n}");
            assert_eq!(a.max_load(), 0.75);
            assert_eq!(
                HashSetOaF64::build_insert_counted(&keys, n),
                HashSetOaF64::build_insert_counted_at(&keys, n, 0.75)
            );
            assert_eq!(
                HashSetOaF64::teardown_counted(&keys, n),
                HashSetOaF64::teardown_counted_at(&keys, n, 0.75)
            );
            assert_eq!(HashSetOaF64::build_insert_n(&keys, n), HashSetOaF64::build_insert_n_at(&keys, n, 0.75));
            assert_eq!(
                HashSetOaF64::build_then_teardown_n(&keys, n),
                HashSetOaF64::build_then_teardown_n_at(&keys, n, 0.75)
            );
        }
    }

    /// The four statics really take the load (the finite-difference runners build their own
    /// sets, so a load reaching only the instance constructor would mix thresholds in one run).
    #[test]
    fn the_finite_difference_statics_build_at_the_requested_load() {
        let keys = shuffled_keys(3000);
        // n = 3000 sits at α ≈ 0.73 at 0.75 (4096 slots) and at α ≈ 0.37 at 0.5 (8192 slots).
        let (lo, hi) = (
            HashSetOaF64::build_insert_counted_at(&keys, 3000, 0.5),
            HashSetOaF64::build_insert_counted_at(&keys, 3000, 0.75),
        );
        assert!(lo < hi, "a lower ceiling probes less on the way up: {lo} vs {hi}");
        let (tlo, thi) = (
            HashSetOaF64::teardown_counted_at(&keys, 3000, 0.5),
            HashSetOaF64::teardown_counted_at(&keys, 3000, 0.75),
        );
        assert!(tlo < thi, "and on the way down: {tlo} vs {thi}");
    }

    /// Rule 2 at each threshold: tombstones count toward `L`, so a delete-heavy cycle stays
    /// bounded and every miss terminates — 0.9 included, which leaves only a tenth of the
    /// slots empty at the top of each sawtooth.
    #[test]
    fn tombstones_count_toward_every_threshold() {
        for l in [0.5, 0.9] {
            let mut s = HashSetOaF64::with_max_load(&(0..6).map(|i| i as f64).collect::<Vec<_>>(), 6, l);
            for round in 0..200 {
                let base = (round * 100) as f64;
                for k in 0..6 {
                    s.insert_one_counted(base + k as f64);
                }
                for k in 0..6 {
                    s.delete_one_counted(base + k as f64);
                }
                assert!(
                    (s.len() + s.tombstones()) as f64 <= l * s.capacity() as f64,
                    "L={l} round {round}: live {} + tombs {} over {} slots",
                    s.len(),
                    s.tombstones(),
                    s.capacity()
                );
                assert!(!s.search_one_counted(-1.0).0);
            }
            assert!(s.capacity() <= 32, "L={l}: purged rather than grown, got {}", s.capacity());
        }
    }

    /// Rules 1, 3 and 4 at each threshold: priming still reaches a fixed point, so churn does
    /// not drift with the repetition count at 0.5 or 0.9 either.
    #[test]
    fn churn_does_not_drift_at_any_threshold() {
        let keys = shuffled_keys(3000);
        for l in [0.5, 0.9] {
            for n in [250usize, 1000, 3000] {
                let mut s = HashSetOaF64::with_max_load(&keys, n, l);
                s.set_churn_key(1e9);
                let primed = s.slots();
                let first = s.churn_counted();
                for reps in [1u32, 7, 100, 100_000] {
                    s.churn_n(reps);
                    assert_eq!(s.churn_counted(), first, "L={l} n={n}: drift after {reps} reps");
                }
                assert_eq!(s.slots(), primed, "L={l} n={n}");
                assert!((s.len() + s.tombstones()) as f64 <= l * s.capacity() as f64);
            }
        }
    }

    /// One slot of the table as the corpus writes it: `.` empty, `x` tombstone, else the key.
    fn layout(s: &HashSetOaF64) -> String {
        s.slots()
            .iter()
            .map(|sl| match sl {
                None => ".".to_string(),
                Some(None) => "x".to_string(),
                Some(Some(k)) => format!("{k}"),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The purge branch at 0.5, slot for slot: four keys fill 8 slots to the threshold (4),
    /// three deletes leave live 1 + tombs 3, and a fresh key homed on an empty slot tips
    /// live + tombs to 5 > 4 with live 2 ≤ 2 — purge in place, not double. The TS twin's test
    /// holds the same literal layouts; it is the mirror's one check of `L · cap / 2`.
    #[test]
    fn purges_in_place_at_half_the_lower_threshold() {
        let keys = [0.0, 1.0, 2.0, 3.0];
        let mut s = HashSetOaF64::with_max_load(&keys, 4, 0.5);
        assert_eq!((s.capacity(), s.len()), (8, 4));
        for d in [0.0, 1.0, 2.0] {
            assert!(s.delete_one_counted(d).0);
        }
        assert_eq!(layout(&s), "x . . . . x x 3");
        let slots = s.slots();
        let fresh = (10u32..)
            .map(f64::from)
            .find(|&k| slots[(mix_f64(k) as usize) & 7].is_none())
            .unwrap();
        assert_eq!(fresh, 10.0, "the first key from 10 up homed on an empty slot");
        assert!(s.insert_one_counted(fresh).0);
        assert_eq!((s.capacity(), s.len(), s.tombstones()), (8, 2, 0), "purged in place");
        assert_eq!(layout(&s), ". . 10 . . 3 . .");
    }

    #[test]
    #[should_panic(expected = "outside [0.25, 1)")]
    fn a_full_table_threshold_is_rejected() {
        // At 1.0 a miss could find no empty slot to stop at — the insert's `expect` would trap.
        let _ = HashSetOaF64::with_max_load(&[1.0], 1, 1.0);
    }

    #[test]
    #[should_panic(expected = "outside [0.25, 1)")]
    fn a_threshold_one_doubling_cannot_restore_is_rejected() {
        let _ = HashSetOaF64::build_insert_counted_at(&[1.0], 1, 0.2);
    }

    /// **What the threshold buys, clock-free**: Knuth's linear-probing costs at the top of each
    /// threshold's sawtooth (the highest α a build reaches below 20 000 keys). The miss cost is
    /// the curve the control moves: ½(1 + 1/(1−α)²) is 2.5 at 0.5, 8.5 at 0.75 and 50 at 0.9 —
    /// against a chained miss of 1 + α ≤ 1.75 at the chaining set's fixed 0.75.
    /// Measured: α 0.499 miss 2.54 (Knuth 2.49) hit 2.51 (2.50); α 0.899 miss 54.98 (49.44)
    /// hit 6.60 (6.45).
    #[test]
    fn each_threshold_tops_out_where_knuth_says() {
        let ks: Vec<f64> = shuffled_keys(100_000).iter().map(|k| k * 7.0 + 3.0).collect();
        for (l, miss_tol) in [(0.5, 0.15), (0.9, 0.2)] {
            let n = (1000..20_000)
                .step_by(37)
                .max_by(|&a, &b| {
                    let fa = a as f64 / capacity_at(a, l) as f64;
                    let fb = b as f64 / capacity_at(b, l) as f64;
                    fa.partial_cmp(&fb).unwrap()
                })
                .unwrap();
            let s = HashSetOaF64::with_max_load(&ks, n, l);
            let a = n as f64 / s.capacity() as f64;
            assert!(a > l - 0.01 && a <= l, "L={l}: top of the saw at α={a:.3}");
            let miss =
                (0..20_000).map(|i| s.search_one_counted(1e7 + i as f64).1).sum::<u64>() as f64 / 20_000.0;
            let hit = ks[..n].iter().map(|&k| s.search_one_counted(k).1).sum::<u64>() as f64 / n as f64;
            let knuth_miss = 0.5 * (1.0 + 1.0 / ((1.0 - a) * (1.0 - a)));
            let knuth_hit = 1.0 + 0.5 * (1.0 + 1.0 / (1.0 - a));
            assert!((miss - knuth_miss).abs() / knuth_miss < miss_tol, "L={l}: miss {miss:.2} vs {knuth_miss:.2}");
            assert!((hit - knuth_hit).abs() / knuth_hit < 0.1, "L={l}: hit {hit:.2} vs {knuth_hit:.2}");
        }
    }

    /// **What the browser's ladders can see of it — less than the label promises.** The search
    /// sweep is a 1-2-5 ladder and the mutation sweep 500 … 4000; a capacity is a power of two,
    /// so each ladder samples the sawtooth at a handful of fixed positions. On distinct keys:
    /// at 0.9 the search ladder's highest α is 0.78 (n = 50, 100, 200), never near 0.9, and
    /// 0.9 builds the *same* table as 0.875 at every point; and the mutation ladder's final
    /// tables are the same size at all three thresholds, so the churn line moves only where
    /// priming tips a table over. The page therefore reports the α each search point actually
    /// sat at (`src/bench/oaLoad.ts`), rather than the threshold's name alone.
    #[test]
    fn the_browser_ladders_sample_the_sawtooth_at_fixed_points() {
        let search = [10usize, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];
        let top = |l: f64| search.iter().map(|&n| n as f64 / capacity_at(n, l) as f64).fold(0.0, f64::max);
        assert!((top(0.9) - 0.78125).abs() < 1e-12, "0.9 tops out at {}", top(0.9));
        assert!((top(0.75) - 0.625).abs() < 1e-12);
        assert!((top(0.5) - 0.48828125).abs() < 1e-12);
        for &n in &search {
            assert_eq!(capacity_at(n, 0.9), capacity_at(n, 0.875), "n={n}");
        }
        for n in [500usize, 1000, 2000, 4000] {
            assert_eq!(capacity_at(n, 0.5), capacity_at(n, 0.75), "n={n}");
            assert_eq!(capacity_at(n, 0.9), capacity_at(n, 0.75), "n={n}");
        }
    }

    /// **Same final size ⇒ same add/remove line, by construction.** Which slots a linearly
    /// probed table has occupied depends only on its key set and its capacity, never on the
    /// order the keys arrived in or the rehashes on the way — and a churn pair of absent keys,
    /// like a full teardown's total, costs only what that occupied pattern dictates. So wherever
    /// a threshold ends at the 0.75 table's size, its churn and teardown op-counts *equal* the
    /// default's; only the cumulative build moves, because it climbs through every smaller
    /// table. On the browser's mutation ladder that is every point at 0.9, and every point but
    /// 500 at 0.5, where the churn block's priming tips a 1024-slot table (500 + 15 > 512) into
    /// doubling. The page's churn note says exactly this rather than "the tables differ".
    #[test]
    fn a_threshold_that_ends_at_the_same_size_draws_the_same_churn_line() {
        let keys = shuffled_keys(4000);
        let churn = |n: usize, l: f64| {
            let mut s = HashSetOaF64::with_max_load(&keys, n, l);
            s.set_churn_key(1e9);
            (s.capacity(), s.churn_counted())
        };
        for n in [500usize, 1000, 2000, 4000] {
            assert_eq!(churn(n, 0.9), churn(n, 0.75), "n={n}: 0.9 churn");
            assert_eq!(
                HashSetOaF64::teardown_counted_at(&keys, n, 0.9),
                HashSetOaF64::teardown_counted(&keys, n),
                "n={n}: 0.9 teardown"
            );
            assert_ne!(
                HashSetOaF64::build_insert_counted_at(&keys, n, 0.9),
                HashSetOaF64::build_insert_counted(&keys, n),
                "n={n}: the build history differs"
            );
            assert_eq!(
                HashSetOaF64::teardown_counted_at(&keys, n, 0.5),
                HashSetOaF64::teardown_counted(&keys, n),
                "n={n}: 0.5 teardown"
            );
        }
        for n in [1000usize, 2000, 4000] {
            assert_eq!(churn(n, 0.5), churn(n, 0.75), "n={n}: 0.5 churn");
        }
        let (cap_lo, _) = churn(500, 0.5);
        let (cap_def, _) = churn(500, 0.75);
        assert_eq!((cap_lo, cap_def), (2048, 1024), "priming doubles the 0.5 table at n = 500");
        assert_ne!(churn(500, 0.5).1, churn(500, 0.75).1);
    }

    /// A fixed-seed permutation of `0..n` (xorshift; no RNG dependency, no flake).
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

/// Cross-language conformance corpus for the open-addressing set (docs/PLAN.md §12, risk
/// R1) — `conformance/corpus-hoa.txt`, which `src/structures/conformance-hoa.test.ts`
/// holds the TypeScript twin to. Kept in this file rather than in `conformance.rs` so the
/// structure, its rules and the corpus that pins them travel together.
///
/// The dimension this structure needs and the chaining corpus lacks is the **slot
/// layout**: where every key sits and where every tombstone is, before deletes, after
/// them, and after re-inserts. Membership and per-probe counts alone would pass a twin
/// that used a different tombstone rule — never reusing, reusing the *last* tombstone,
/// emptying a slot whose successor is empty, or backward-shift deletion — because each of
/// those answers every query correctly; only the layout (and the counts that follow from
/// it on the *next* operation) tells them apart. The `purge` case drives the same-size
/// purge, the `cluster` case a genuine primary-clustering run, and every case records one
/// primed churn pair, so the priming rule is pinned too.
#[cfg(test)]
pub(crate) mod corpus {
    use super::{mix_f64, HashSetOaF64};

    const CORPUS_HOA_PATH: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-hoa.txt");

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
        // Six keys fill an 8-slot table to exactly its threshold (6 ≤ 0.75·8): five that
        // share home slot 3 — one run of probes — and one homed at 4, displaced by the run.
        let homed_three = keys_homed_at(3, 8, 6);
        let mut cluster = homed_three[..5].to_vec();
        cluster.push(keys_homed_at(4, 8, 1)[0]);
        let late_three = homed_three[5];
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
                // Delete inside the run: everything behind a tombstone must stay reachable,
                // and the next key homed at 3 must take the first tombstone, not the end.
                name: "cluster",
                probes: cluster.iter().copied().chain([late_three, 1000.0]).collect(),
                deletes: vec![cluster[0], cluster[2]],
                reinserts: vec![late_three, cluster[2]],
                keys: cluster,
            },
            purge_case(),
            Case {
                // 100 keys ⇒ a churn block of three (`clamp(100 / 32, 1, 16)`), so the
                // block rule and its priming are pinned, not just the one-key edge.
                name: "block",
                keys: (0..100).map(|i| (i * 3) as f64).collect(),
                probes: vec![0.0, 150.0, 297.0, 298.0, 1000.0],
                deletes: vec![0.0, 150.0, 297.0, 151.0],
                reinserts: vec![150.0, 151.0],
            },
        ]
    }

    /// Six keys fill an 8-slot table to its threshold; four are deleted (live 2, tombs 4).
    /// The first re-insert is *computed* to home on an empty slot, so it cannot reuse a
    /// tombstone: live + tombs becomes 7 > 6 with live 3 ≤ 3, and the table purges in place
    /// (same capacity, tombstones dropped) rather than doubling. A second fresh key and a
    /// deleted one follow, on the clean table.
    fn purge_case() -> Case {
        let keys: Vec<f64> = (0..6).map(|i| i as f64).collect();
        let deletes = vec![0.0, 1.0, 2.0, 3.0];
        let mut m = HashSetOaF64::new(&keys, keys.len());
        for &d in &deletes {
            m.delete_one_counted(d);
        }
        let slots = m.slots();
        let lands_empty = (10u32..)
            .map(f64::from)
            .find(|&k| slots[(mix_f64(k) as usize) & (slots.len() - 1)].is_none())
            .expect("two empty slots exist");
        Case {
            name: "purge",
            probes: vec![0.0, 3.0, 5.0, 6.0],
            reinserts: vec![lands_empty, lands_empty + 1000.0, 2.0],
            keys,
            deletes,
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

    /// One token per slot: `.` empty, `x` tombstone, otherwise the live key.
    fn fmt_slots(s: &HashSetOaF64) -> String {
        s.slots()
            .iter()
            .map(|sl| match sl {
                None => ".".to_string(),
                Some(None) => "x".to_string(),
                Some(Some(k)) => format!("{k}"),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn fmt_shape(s: &HashSetOaF64) -> String {
        format!("{} {} {}", s.capacity(), s.len(), s.tombstones())
    }

    /// The churn key every case records: one past the largest key (`aboveMax`, the recipe
    /// the browser sweep uses), or 1 for an empty set.
    fn churn_key_for(keys: &[f64]) -> f64 {
        if keys.is_empty() {
            return 1.0;
        }
        keys.iter().copied().fold(f64::NEG_INFINITY, f64::max) + 1.0
    }

    pub(crate) fn serialize(cases: &[Case]) -> String {
        let mut out = String::new();
        out.push_str("# Mr Data Structure — open-addressing hash set conformance corpus (docs/PLAN.md §8, §12).\n");
        out.push_str("# Generated from the Rust bench impl (hash_set_oa.rs); the TS teaching twin must match.\n");
        out.push_str("# Op-count = hashes + slot probes (an occupied slot examined; the empty slot that ends a\n");
        out.push_str("# walk is free). `hoa_slots*` is the SLOT LAYOUT: one token per slot, `.` empty, `x`\n");
        out.push_str("# tombstone, else the live key. `hoa_shape*` = capacity live tombstones.\n");
        out.push_str("# `hoa_churn_keys` is the churn block set_churn_key(churn_key) builds (clamp(len/32, 1, 16)\n");
        out.push_str("# consecutive absent keys), `hoa_slots_churn` the layout after its priming pairs, and\n");
        out.push_str("# `hoa_churn` the mean op-count of one counted pair per block key, from that state.\n");
        out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_hoa\n");
        for c in cases {
            let s = HashSetOaF64::new(&c.keys, c.keys.len());
            let search: Vec<(bool, u64)> =
                c.probes.iter().map(|&p| s.search_one_counted(p)).collect();

            // Deletes, then re-inserts, mutate one fresh copy in sequence.
            let mut m = HashSetOaF64::new(&c.keys, c.keys.len());
            let del: Vec<(bool, u64)> =
                c.deletes.iter().map(|&d| m.delete_one_counted(d)).collect();
            let slots_after = fmt_slots(&m);
            let search_after: Vec<(bool, u64)> =
                c.probes.iter().map(|&p| m.search_one_counted(p)).collect();
            let ins: Vec<(bool, u64)> =
                c.reinserts.iter().map(|&r| m.insert_one_counted(r)).collect();

            let churn_key = churn_key_for(&c.keys);
            let mut ch = HashSetOaF64::new(&c.keys, c.keys.len());
            ch.set_churn_key(churn_key);
            let churn_slots = fmt_slots(&ch);
            let churn_ops = ch.churn_counted();

            out.push('\n');
            out.push_str(&format!("case {}\n", c.name));
            out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
            out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
            out.push_str(&format!("hoa_order {}\n", fmt_nums(&s.keys_in_order())));
            out.push_str(&format!("hoa_search {}\n", fmt_flag_ops(&search)));
            out.push_str(&format!("hoa_slots {}\n", fmt_slots(&s)));
            out.push_str(&format!("hoa_shape {}\n", fmt_shape(&s)));
            out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
            out.push_str(&format!("hoa_delete {}\n", fmt_flag_ops(&del)));
            out.push_str(&format!("hoa_slots_after {slots_after}\n"));
            out.push_str(&format!("hoa_search_after {}\n", fmt_flag_ops(&search_after)));
            out.push_str(&format!("reinserts {}\n", fmt_nums(&c.reinserts)));
            out.push_str(&format!("hoa_insert {}\n", fmt_flag_ops(&ins)));
            out.push_str(&format!("hoa_slots_final {}\n", fmt_slots(&m)));
            out.push_str(&format!("hoa_shape_final {}\n", fmt_shape(&m)));
            out.push_str(&format!("churn_key {}\n", fmt_nums(&[churn_key])));
            out.push_str(&format!("hoa_churn_keys {}\n", fmt_nums(&ch.churn_keys)));
            out.push_str(&format!("hoa_slots_churn {churn_slots}\n"));
            out.push_str(&format!("hoa_churn {churn_ops}\n"));
        }
        out
    }

    fn normalize(s: &str) -> String {
        s.replace('\r', "")
    }

    #[test]
    #[ignore = "writes the committed open-addressing corpus; run deliberately after a behavior change"]
    fn regen_corpus_hoa() {
        std::fs::write(CORPUS_HOA_PATH, serialize(&cases())).expect("write hoa corpus");
    }

    #[test]
    fn corpus_hoa_matches_committed() {
        let committed = std::fs::read_to_string(CORPUS_HOA_PATH).expect(
            "open-addressing corpus missing; generate it with: cargo test -- --ignored regen_corpus_hoa",
        );
        assert_eq!(
            normalize(&committed),
            normalize(&serialize(&cases())),
            "open-addressing conformance corpus is stale vs the Rust impl; \
             regenerate with: cargo test -- --ignored regen_corpus_hoa",
        );
    }
}
