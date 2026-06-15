//! Cross-language conformance corpus (docs/PLAN.md §12, risk R1).
//!
//! The Rust impls are the declared source of truth (docs/PLAN.md §2.1). This
//! module runs them over a fixed set of input cases and serializes their
//! observable behavior — iteration order plus per-probe `(membership, op-count)`
//! — into a committed text file (`conformance/corpus.txt`). The TypeScript
//! teaching impls must reproduce that same file
//! (`src/structures/conformance.test.ts`), so any algorithm-level drift between
//! the two languages shows up as a corpus mismatch on one side or the other.
//!
//! - [`regen_corpus`] (ignored) rewrites the committed file from the current
//!   Rust impls. Run it deliberately after an intended behavior change:
//!   `cargo test -- --ignored regen_corpus`.
//! - [`corpus_matches_committed`] recomputes from the current impls and asserts
//!   the committed file is still up to date, so Rust drift fails the build.
//!
//! The format is line-oriented (no JSON dependency): blank lines and `#`
//! comments are ignored; each case is `case <name>` followed by `keys`,
//! `probes`, `<struct>_order`, and `<struct>_search` lines. Search results are
//! `<0|1>:<ops>` tokens (membership flag : op-count).

use super::avl::AvlF64;
use super::bst::BstF64;
use super::dyn_array::ArrayF64;
use super::dyn_array_str::ArrayStr;
use super::hash_set::HashSetF64;
use super::hash_set_str::HashSetStr;

const CORPUS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus.txt");
const CORPUS_STR_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-str.txt");
const CORPUS_BST_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-bst.txt");
const CORPUS_AVL_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-avl.txt");

struct Case {
    name: &'static str,
    keys: Vec<f64>,
    probes: Vec<f64>,
}

/// The canonical input cases. Chosen to exercise the divergence-prone paths
/// (docs/PLAN.md §12): empty/singleton edges, iteration order, multiset-vs-set
/// duplicate handling, a key set large enough to force several rehashes, and
/// fractional/negative keys (non-trivial f64 bit patterns through the hash).
fn cases() -> Vec<Case> {
    let zero_to_thirty: Vec<f64> = (0..=30).map(|i| i as f64).collect();
    vec![
        Case { name: "empty", keys: vec![], probes: vec![1.0, 2.0] },
        Case { name: "singleton", keys: vec![42.0], probes: vec![42.0, 7.0] },
        Case {
            name: "ordered",
            keys: vec![10.0, 20.0, 30.0],
            probes: vec![10.0, 20.0, 30.0, 99.0],
        },
        Case {
            name: "duplicates",
            keys: vec![5.0, 5.0, 5.0, 7.0, 5.0, 9.0],
            probes: vec![5.0, 7.0, 9.0, 99.0],
        },
        Case {
            name: "rehash",
            keys: zero_to_thirty,
            probes: vec![0.0, 15.0, 30.0, 31.0, -1.0, 1000.0],
        },
        Case {
            name: "fractional",
            keys: vec![0.0, 0.5, 2.5, -1.0],
            probes: vec![0.5, 2.5, -1.0, 3.0],
        },
    ]
}

/// Render an `f64` so TS `Number()` round-trips it: integer-valued keys print
/// with no decimal point, exact binary fractions print plainly (e.g. `0.5`).
fn fmt_num(x: f64) -> String {
    format!("{x}")
}

fn fmt_nums(xs: &[f64]) -> String {
    xs.iter().map(|&x| fmt_num(x)).collect::<Vec<_>>().join(" ")
}

fn fmt_search(results: &[(bool, u64)]) -> String {
    results
        .iter()
        .map(|&(found, ops)| format!("{}:{ops}", found as u8))
        .collect::<Vec<_>>()
        .join(" ")
}

fn serialize(cases: &[Case]) -> String {
    let mut out = String::new();
    out.push_str("# Mr Data Structure — cross-language conformance corpus (docs/PLAN.md §12).\n");
    out.push_str("# Generated from the Rust bench impls; the TS teaching impls must match.\n");
    out.push_str("# Regenerate: cargo test -- --ignored regen_corpus\n");
    for c in cases {
        let array = ArrayF64::new(&c.keys, c.keys.len());
        let array_search: Vec<(bool, u64)> =
            c.probes.iter().map(|&p| array.search_one_counted(p)).collect();

        let set = HashSetF64::new(&c.keys, c.keys.len());
        let set_search: Vec<(bool, u64)> =
            c.probes.iter().map(|&p| set.search_one_counted(p)).collect();

        out.push('\n');
        out.push_str(&format!("case {}\n", c.name));
        out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
        out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
        out.push_str(&format!("array_order {}\n", fmt_nums(&array.keys_in_order())));
        out.push_str(&format!("array_search {}\n", fmt_search(&array_search)));
        out.push_str(&format!("hashset_order {}\n", fmt_nums(&set.keys_in_order())));
        out.push_str(&format!("hashset_search {}\n", fmt_search(&set_search)));
    }
    out
}

/// Strip carriage returns so a CRLF checkout compares equal to LF output.
fn normalize(s: &str) -> String {
    s.replace('\r', "")
}

#[test]
#[ignore = "writes the committed corpus; run deliberately after a behavior change"]
fn regen_corpus() {
    std::fs::write(CORPUS_PATH, serialize(&cases())).expect("write corpus");
}

#[test]
fn corpus_matches_committed() {
    let committed = std::fs::read_to_string(CORPUS_PATH).expect(
        "conformance corpus missing; generate it with: cargo test -- --ignored regen_corpus",
    );
    assert_eq!(
        normalize(&committed),
        normalize(&serialize(&cases())),
        "conformance corpus is stale vs the Rust impls; \
         regenerate with: cargo test -- --ignored regen_corpus",
    );
}

// ── String-key corpus (docs/PLAN.md §10) ────────────────────────────────────
//
// The string structures use the same line format, but keys/probes/orders are
// raw UTF-8 tokens rather than numbers (so the TS parser splits on whitespace
// instead of `Number()`). Keys must therefore contain no whitespace and never be
// empty — the empty-string / `offsets[i]==offsets[i+1]` edge is covered by the
// structures' own constructor tests, where it actually lives (the marshal decode).

struct StrCase {
    name: &'static str,
    keys: Vec<String>,
    probes: Vec<String>,
}

fn svec(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

/// Marshal `keys` into the offsets+UTF-8 layout the string constructors consume
/// (the test-side mirror of `src/data/marshal.ts`).
fn marshal_strs(keys: &[String]) -> (Vec<u32>, Vec<u8>) {
    let mut offsets = vec![0u32];
    let mut bytes = Vec::new();
    for k in keys {
        bytes.extend_from_slice(k.as_bytes());
        offsets.push(bytes.len() as u32);
    }
    (offsets, bytes)
}

/// String input cases, mirroring [`cases`]: empty/singleton edges, iteration
/// order, multiset-vs-set duplicates, a set large enough to force several
/// rehashes, and a **unicode** case whose multi-byte keys (accents, CJK, an
/// emoji) exercise byte-length ≠ char-length through the hash and the marshal
/// layout (docs/PLAN.md §4.2, §12).
fn str_cases() -> Vec<StrCase> {
    let rehash_keys: Vec<String> = (0..31).map(|i| format!("k{i}")).collect();
    vec![
        StrCase { name: "empty", keys: vec![], probes: svec(&["a", "b"]) },
        StrCase { name: "singleton", keys: svec(&["hello"]), probes: svec(&["hello", "world"]) },
        StrCase {
            name: "ordered",
            keys: svec(&["apple", "banana", "cherry"]),
            probes: svec(&["apple", "banana", "cherry", "durian"]),
        },
        StrCase {
            name: "duplicates",
            keys: svec(&["a", "a", "b", "a", "c"]),
            probes: svec(&["a", "b", "c", "z"]),
        },
        StrCase {
            name: "rehash",
            keys: rehash_keys,
            probes: svec(&["k0", "k15", "k30", "k31", "zzz"]),
        },
        StrCase {
            name: "unicode",
            keys: svec(&["café", "naïve", "日本", "🍎", "Москва"]),
            probes: svec(&["café", "日本", "🍎", "cafe"]),
        },
    ]
}

fn fmt_strs(xs: &[String]) -> String {
    xs.join(" ")
}

fn serialize_str(cases: &[StrCase]) -> String {
    let mut out = String::new();
    out.push_str("# Mr Data Structure — string-key conformance corpus (docs/PLAN.md §12).\n");
    out.push_str("# Generated from the Rust bench impls; the TS teaching impls must match.\n");
    out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_str\n");
    for c in cases {
        let (offsets, bytes) = marshal_strs(&c.keys);

        let array = ArrayStr::new(&offsets, &bytes, c.keys.len());
        let array_search: Vec<(bool, u64)> =
            c.probes.iter().map(|p| array.search_one_counted(p)).collect();

        let set = HashSetStr::new(&offsets, &bytes, c.keys.len());
        let set_search: Vec<(bool, u64)> =
            c.probes.iter().map(|p| set.search_one_counted(p)).collect();

        out.push('\n');
        out.push_str(&format!("case {}\n", c.name));
        out.push_str(&format!("keys {}\n", fmt_strs(&c.keys)));
        out.push_str(&format!("probes {}\n", fmt_strs(&c.probes)));
        out.push_str(&format!("array_order {}\n", fmt_strs(&array.keys_in_order())));
        out.push_str(&format!("array_search {}\n", fmt_search(&array_search)));
        out.push_str(&format!("hashset_order {}\n", fmt_strs(&set.keys_in_order())));
        out.push_str(&format!("hashset_search {}\n", fmt_search(&set_search)));
    }
    out
}

#[test]
#[ignore = "writes the committed string corpus; run deliberately after a behavior change"]
fn regen_corpus_str() {
    std::fs::write(CORPUS_STR_PATH, serialize_str(&str_cases())).expect("write str corpus");
}

#[test]
fn corpus_str_matches_committed() {
    let committed = std::fs::read_to_string(CORPUS_STR_PATH).expect(
        "string corpus missing; generate it with: cargo test -- --ignored regen_corpus_str",
    );
    assert_eq!(
        normalize(&committed),
        normalize(&serialize_str(&str_cases())),
        "string conformance corpus is stale vs the Rust impls; \
         regenerate with: cargo test -- --ignored regen_corpus_str",
    );
}

// ── BST corpus (docs/PLAN.md §8 trees, §12) ──────────────────────────────────
//
// A tree needs two dimensions the linear/hash corpus format doesn't carry:
//   • shape — in-order alone can't distinguish a balanced tree from a degenerate
//     chain (they share an in-order), so each case pins the **pre-order with
//     explicit null markers** (`.`), an unambiguous serialization of the shape; and
//   • a **delete sequence** — Hibbard (value-copy) delete is the drift-prone part,
//     and the cost-metric contract (the in-order-successor walk is *not* a
//     comparison, risk R1) only shows up under deletes. Each case therefore runs a
//     delete sequence on a fresh tree and pins per-delete `(removed:ops)` plus the
//     resulting shape.
// Keys are integer-valued (the shape/delete dimensions, not float formatting, are
// the point), so `Number()` round-trips them exactly on the TS side.

struct BstCase {
    name: &'static str,
    keys: Vec<f64>,
    probes: Vec<f64>,
    deletes: Vec<f64>,
}

/// BST input cases, chosen to exercise every divergence-prone path (docs/PLAN.md
/// §12): empty/singleton edges, the **sorted-input degeneration** to an O(n) chain
/// (which only the shape pin catches — its in-order is identical to a balanced
/// tree's), **equal-keys-go-right**, and every Hibbard delete branch — leaf,
/// one-child each side, two-child, two-child root, delete-to-empty, one-of-duplicates.
fn bst_cases() -> Vec<BstCase> {
    vec![
        BstCase { name: "empty", keys: vec![], probes: vec![1.0, 2.0], deletes: vec![1.0] },
        BstCase {
            name: "singleton", // delete-to-empty
            keys: vec![42.0],
            probes: vec![42.0, 7.0],
            deletes: vec![42.0],
        },
        BstCase {
            name: "degenerate", // sorted ⇒ right chain; one-child-right deletes
            keys: vec![10.0, 20.0, 30.0, 40.0, 50.0],
            probes: vec![50.0, 10.0, 35.0],
            deletes: vec![10.0, 40.0, 30.0],
        },
        BstCase {
            name: "equal_right", // equal keys go right; delete one of the duplicates
            keys: vec![50.0, 50.0, 50.0, 70.0],
            probes: vec![50.0, 70.0, 99.0],
            deletes: vec![50.0],
        },
        BstCase {
            name: "one_child_left",
            keys: vec![50.0, 30.0, 20.0, 70.0],
            probes: vec![30.0],
            deletes: vec![30.0],
        },
        BstCase {
            name: "hibbard", // leaf, two-child, two-child-root
            keys: vec![50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0],
            probes: vec![50.0, 20.0, 35.0],
            deletes: vec![20.0, 70.0, 50.0],
        },
    ]
}

/// Pre-order shape (`.` = null) — the line-format mirror of [`BstF64::preorder`].
fn fmt_preorder(nodes: &[Option<f64>]) -> String {
    nodes
        .iter()
        .map(|n| match n {
            Some(v) => fmt_num(*v),
            None => ".".to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn serialize_bst(cases: &[BstCase]) -> String {
    let mut out = String::new();
    out.push_str("# Mr Data Structure — BST conformance corpus (docs/PLAN.md §8, §12).\n");
    out.push_str("# Generated from the Rust bench impl; the TS teaching twin must match.\n");
    out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_bst\n");
    for c in cases {
        let t = BstF64::new(&c.keys, c.keys.len());
        let search: Vec<(bool, u64)> =
            c.probes.iter().map(|&p| t.search_one_counted(p)).collect();

        // Deletes mutate, so run them on a fresh tree built from the same keys.
        let mut td = BstF64::new(&c.keys, c.keys.len());
        let del: Vec<(bool, u64)> =
            c.deletes.iter().map(|&d| td.delete_one_counted(d)).collect();

        out.push('\n');
        out.push_str(&format!("case {}\n", c.name));
        out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
        out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
        out.push_str(&format!("bst_order {}\n", fmt_nums(&t.keys_in_order())));
        out.push_str(&format!("bst_search {}\n", fmt_search(&search)));
        out.push_str(&format!("bst_shape {}\n", fmt_preorder(&t.preorder())));
        out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
        out.push_str(&format!("bst_delete {}\n", fmt_search(&del)));
        out.push_str(&format!("bst_shape_after {}\n", fmt_preorder(&td.preorder())));
    }
    out
}

#[test]
#[ignore = "writes the committed BST corpus; run deliberately after a behavior change"]
fn regen_corpus_bst() {
    std::fs::write(CORPUS_BST_PATH, serialize_bst(&bst_cases())).expect("write bst corpus");
}

#[test]
fn corpus_bst_matches_committed() {
    let committed = std::fs::read_to_string(CORPUS_BST_PATH).expect(
        "BST corpus missing; generate it with: cargo test -- --ignored regen_corpus_bst",
    );
    assert_eq!(
        normalize(&committed),
        normalize(&serialize_bst(&bst_cases())),
        "BST conformance corpus is stale vs the Rust impl; \
         regenerate with: cargo test -- --ignored regen_corpus_bst",
    );
}

// ── AVL corpus (docs/PLAN.md §8 trees, §12) ──────────────────────────────────
//
// Same two extra dimensions as the BST corpus — pre-order **shape** (rotations are
// invisible to in-order, so only the shape pin proves they fired identically across
// languages) and a **delete sequence** with per-delete `(removed:ops)` — but the
// op-count now folds in **rotations** alongside comparisons, and the cases are chosen
// to exercise every rotation kind: single (LL/RR), double (LR/RL), the multiset
// interaction (equal keys go right, then rebalance), and crucially a delete that
// *triggers* a rotation (a distinct path from insert-triggered rebalancing). The
// sorted/descending cases are the AVL's reason to exist — the same inputs that
// degenerate the BST to an O(n) chain stay balanced here, which the shape pin verifies.

struct AvlCase {
    name: &'static str,
    keys: Vec<f64>,
    probes: Vec<f64>,
    deletes: Vec<f64>,
}

/// AVL input cases (docs/PLAN.md §12). Integer-valued keys (the shape/rotation/delete
/// dimensions are the point, not float formatting), so `Number()` round-trips on TS.
fn avl_cases() -> Vec<AvlCase> {
    vec![
        AvlCase { name: "empty", keys: vec![], probes: vec![1.0, 2.0], deletes: vec![1.0] },
        AvlCase {
            name: "singleton",
            keys: vec![42.0],
            probes: vec![42.0, 7.0],
            deletes: vec![42.0],
        },
        // Sorted input — the BST's degenerate chain — kept balanced by repeated left
        // rotations. Deletes from the small end may rebalance on the way back up.
        AvlCase {
            name: "sorted_stays_balanced",
            keys: vec![10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0],
            probes: vec![10.0, 70.0, 35.0],
            deletes: vec![10.0, 20.0],
        },
        // Descending input — the mirror, exercising left-leaning (LL → right rotation) inserts.
        AvlCase {
            name: "descending",
            keys: vec![70.0, 60.0, 50.0, 40.0, 30.0, 20.0, 10.0],
            probes: vec![70.0, 10.0, 5.0],
            deletes: vec![70.0, 60.0],
        },
        // Insertion orders that force the double rotations (LR and RL within one tree).
        AvlCase {
            name: "double_rotations",
            keys: vec![50.0, 30.0, 70.0, 60.0, 80.0, 65.0],
            probes: vec![65.0, 99.0],
            deletes: vec![80.0],
        },
        // Equal keys go right and still rebalance (multiset + rotation interaction).
        AvlCase {
            name: "equal_right",
            keys: vec![50.0, 50.0, 50.0, 70.0],
            probes: vec![50.0, 70.0, 99.0],
            deletes: vec![50.0],
        },
        // A delete that *triggers* a rotation: removing 30 leaves 20 left-heavy → right rotation.
        AvlCase {
            name: "delete_rebalance",
            keys: vec![20.0, 10.0, 30.0, 5.0],
            probes: vec![5.0, 30.0],
            deletes: vec![30.0],
        },
        // Two-child (Hibbard) deletes on a fuller balanced tree, including the root.
        AvlCase {
            name: "hibbard",
            keys: vec![50.0, 30.0, 70.0, 20.0, 40.0, 60.0, 80.0],
            probes: vec![50.0, 20.0, 35.0],
            deletes: vec![30.0, 70.0, 50.0],
        },
    ]
}

fn serialize_avl(cases: &[AvlCase]) -> String {
    let mut out = String::new();
    out.push_str("# Mr Data Structure — AVL conformance corpus (docs/PLAN.md §8, §12).\n");
    out.push_str("# Generated from the Rust bench impl; the TS teaching twin must match.\n");
    out.push_str("# Op-count = comparisons + rotations. Regenerate: cargo test -- --ignored regen_corpus_avl\n");
    for c in cases {
        let t = AvlF64::new(&c.keys, c.keys.len());
        let search: Vec<(bool, u64)> =
            c.probes.iter().map(|&p| t.search_one_counted(p)).collect();

        // Deletes mutate, so run them on a fresh tree built from the same keys.
        let mut td = AvlF64::new(&c.keys, c.keys.len());
        let del: Vec<(bool, u64)> =
            c.deletes.iter().map(|&d| td.delete_one_counted(d)).collect();

        out.push('\n');
        out.push_str(&format!("case {}\n", c.name));
        out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
        out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
        out.push_str(&format!("avl_order {}\n", fmt_nums(&t.keys_in_order())));
        out.push_str(&format!("avl_search {}\n", fmt_search(&search)));
        out.push_str(&format!("avl_shape {}\n", fmt_preorder(&t.preorder())));
        out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
        out.push_str(&format!("avl_delete {}\n", fmt_search(&del)));
        out.push_str(&format!("avl_shape_after {}\n", fmt_preorder(&td.preorder())));
    }
    out
}

#[test]
#[ignore = "writes the committed AVL corpus; run deliberately after a behavior change"]
fn regen_corpus_avl() {
    std::fs::write(CORPUS_AVL_PATH, serialize_avl(&avl_cases())).expect("write avl corpus");
}

#[test]
fn corpus_avl_matches_committed() {
    let committed = std::fs::read_to_string(CORPUS_AVL_PATH).expect(
        "AVL corpus missing; generate it with: cargo test -- --ignored regen_corpus_avl",
    );
    assert_eq!(
        normalize(&committed),
        normalize(&serialize_avl(&avl_cases())),
        "AVL conformance corpus is stale vs the Rust impl; \
         regenerate with: cargo test -- --ignored regen_corpus_avl",
    );
}
