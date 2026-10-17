//! B-tree cross-language conformance corpus (docs/PLAN.md §12, risk R1; docs/METHODOLOGY.md
//! §2.10). The Rust bench twin (`btree::BTree`) is the source of truth; the TypeScript
//! teaching twin (`src/structures/btree.ts`) must reproduce `conformance/corpus-btree.txt`
//! line for line (`src/structures/conformance-btree.test.ts`).
//!
//! Kept in its own file, beside `conformance.rs` rather than inside it, so this slice adds a
//! module instead of editing a shared one; the few formatting helpers are restated here.
//!
//! What each case pins, beyond the other corpora's order + per-probe `(found, ops)`:
//! - **`t`** — the minimum degree. Most cases run at `t = 2` (at most 3 keys a node), where a
//!   few dozen keys reach every split, borrow and merge path and a cascade to a root collapse;
//!   two run at the shipped `t = 16`.
//! - **`btree_build_ops`** — the op-count of *every* insert of the build, in order. The other
//!   tree corpora have no insert column (the gap §5's proof map names for the trie and the
//!   skip list); here a split costs an op, so the insert count is where a drifted split would
//!   show first.
//! - **`btree_levels`** — the shape, level by level: nodes left to right separated by a space,
//!   keys inside a node by `,`, levels by ` | ` (`-` for an empty tree). For a valid B-tree
//!   this fixes the structure exactly. Order + counts alone would pass a tree that split at
//!   the wrong key or borrowed from the wrong sibling, since both keep the in-order sequence.
//! - a **delete sequence** with per-delete `(removed, ops)` and the shape after it, because
//!   the repair (borrow-left before borrow-right, merge-left before merge-right, predecessor
//!   from the leaf) is the drift-prone half.

use super::btree::BTree;

const CORPUS_BTREE_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-btree.txt");

fn fmt_nums(xs: &[f64]) -> String {
    xs.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" ")
}

fn fmt_flag_ops(rs: &[(bool, u64)]) -> String {
    rs.iter().map(|&(f, o)| format!("{}:{o}", f as u8)).collect::<Vec<_>>().join(" ")
}

fn fmt_levels(b: &BTree) -> String {
    let lv = b.levels();
    if lv.is_empty() {
        return "-".to_string();
    }
    lv.iter()
        .map(|level| {
            level
                .iter()
                .map(|node| node.iter().map(|k| format!("{k}")).collect::<Vec<_>>().join(","))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

struct BTreeCase {
    name: &'static str,
    t: usize,
    keys: Vec<f64>,
    probes: Vec<f64>,
    deletes: Vec<f64>,
}

fn f(xs: impl IntoIterator<Item = i64>) -> Vec<f64> {
    xs.into_iter().map(|x| x as f64).collect()
}

fn btree_cases() -> Vec<BTreeCase> {
    vec![
        BTreeCase { name: "empty", t: 16, keys: vec![], probes: f([1, 2]), deletes: f([1]) },
        BTreeCase {
            name: "singleton", // delete to empty: the root leaf itself is released
            t: 16,
            keys: f([42]),
            probes: f([42, 7]),
            deletes: f([42]),
        },
        BTreeCase {
            name: "ordered", // 2,4 | 1 3 5,6,7 — a separator hit, a predecessor delete, a cascade
            t: 2,
            keys: f(1..=7),
            probes: vec![4.0, 0.0, 8.0, 3.5, 7.0, 1.0],
            deletes: f([4, 99, 1, 2, 3]),
        },
        BTreeCase {
            name: "duplicates", // one occurrence per delete — the first in order
            t: 2,
            keys: f([5, 5, 5, 7, 5, 9, 5, 5, 3, 5]),
            probes: f([5, 7, 9, 3, 4, 10, 2]),
            deletes: f([5, 5, 9, 5, 5, 4, 5, 3]),
        },
        BTreeCase {
            name: "ascending", // the proactive split's half-full left spine
            t: 2,
            keys: f(0..40),
            probes: f([0, 19, 39, 40, -1]),
            deletes: f([0, 1, 2, 3, 39, 38, 20, 21, 22, 10, 11, 12, 13, 14]),
        },
        BTreeCase {
            name: "descending",
            t: 3,
            keys: f((0..40).rev()),
            probes: f([0, 20, 39, 40, -1]),
            deletes: f([39, 38, 37, 0, 1, 2, 3, 4, 5, 25, 26, 27]),
        },
        BTreeCase {
            name: "shuffled",
            t: 2,
            keys: f((0..64).map(|i| (i * 37) % 64)),
            probes: f([0, 31, 63, 64, -5, 17]),
            deletes: f((0..40).map(|i| (i * 11) % 64)),
        },
        BTreeCase {
            name: "dup-span", // runs of equal keys straddling separators at every level
            t: 2,
            keys: f((0..40).map(|i| i % 4)),
            probes: f([0, 1, 2, 3, 4, -1]),
            deletes: f([2, 2, 2, 0, 0, 3, 1, 2, 2, 2, 2, 3, 3, 0, 1, 1, 9]),
        },
        BTreeCase {
            name: "drain", // every key deleted — merges cascade until the tree is empty
            t: 2,
            keys: f((1..=20).map(|i| (i * 7) % 21)),
            probes: f([1, 20, 0]),
            deletes: f((1..=20).map(|i| (i * 13) % 21)),
        },
        BTreeCase {
            name: "fractional",
            t: 2,
            keys: vec![0.0, 0.5, 2.5, -1.0, -3.25, 1e6, 0.5, 7.75],
            probes: vec![0.5, 2.5, -1.0, 3.0, 1e6, -4.0],
            deletes: vec![0.5, -1.0, 1e6, 0.5],
        },
        BTreeCase {
            name: "t16-ascending", // the shipped degree: 31-key nodes, depth 2, real merges
            t: 16,
            keys: f(0..200),
            probes: f([0, 15, 16, 100, 199, 200, -1]),
            deletes: f((0..120).map(|i| (i * 7) % 200)),
        },
        BTreeCase {
            name: "t16-duplicates", // 150 keys over five values at the shipped degree
            t: 16,
            keys: f((0..150).map(|i| (i * 7) % 5)),
            probes: f([0, 1, 2, 3, 4, 5, -1]),
            deletes: f((0..60).map(|i| i % 3)),
        },
    ]
}

fn serialize_btree(cases: &[BTreeCase]) -> String {
    let mut out = String::new();
    out.push_str("# Mr Data Structure — B-tree conformance corpus (docs/PLAN.md §8, §12).\n");
    out.push_str("# Generated from the Rust bench impl; the TS teaching twin must match.\n");
    out.push_str("# Op-count = key comparisons + one per split / merge / borrow.\n");
    out.push_str("# `t` = minimum degree (<= 2t-1 keys a node). `btree_build_ops` = each build\n");
    out.push_str("# insert's op-count, in order. `btree_levels` = the shape: levels root-first\n");
    out.push_str("# separated by `|`, nodes by a space, a node's keys by `,` (`-` = empty).\n");
    out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_btree\n");
    for c in cases {
        let mut b = BTree::new(c.t);
        let build: Vec<f64> = c.keys.iter().map(|&k| b.insert_one_counted(k) as f64).collect();
        b.check().expect("corpus tree must be valid");
        let search: Vec<(bool, u64)> = c.probes.iter().map(|&p| b.search_one_counted(p)).collect();
        let order = b.keys_in_order();
        let levels = fmt_levels(&b);
        let del: Vec<(bool, u64)> = c.deletes.iter().map(|&d| b.delete_one_counted(d)).collect();
        b.check().expect("corpus tree must stay valid");

        out.push('\n');
        out.push_str(&format!("case {}\n", c.name));
        out.push_str(&format!("t {}\n", c.t));
        out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
        out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
        out.push_str(&format!("btree_build_ops {}\n", fmt_nums(&build)));
        out.push_str(&format!("btree_order {}\n", fmt_nums(&order)));
        out.push_str(&format!("btree_search {}\n", fmt_flag_ops(&search)));
        out.push_str(&format!("btree_levels {levels}\n"));
        out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
        out.push_str(&format!("btree_delete {}\n", fmt_flag_ops(&del)));
        out.push_str(&format!("btree_order_after {}\n", fmt_nums(&b.keys_in_order())));
        out.push_str(&format!("btree_levels_after {}\n", fmt_levels(&b)));
    }
    out
}

#[test]
#[ignore = "writes the committed B-tree corpus; run deliberately after a behavior change"]
fn regen_corpus_btree() {
    std::fs::write(CORPUS_BTREE_PATH, serialize_btree(&btree_cases())).expect("write btree corpus");
}

#[test]
fn corpus_btree_matches_committed() {
    let committed = std::fs::read_to_string(CORPUS_BTREE_PATH).expect(
        "B-tree corpus missing; generate it with: cargo test -- --ignored regen_corpus_btree",
    );
    assert_eq!(
        committed.replace('\r', ""),
        serialize_btree(&btree_cases()),
        "B-tree conformance corpus is stale vs the Rust impl; \
         regenerate with: cargo test -- --ignored regen_corpus_btree",
    );
}

/// The corpus must actually reach the paths it claims to: across all cases, every kind of
/// structural event fires at least once.
#[test]
fn corpus_cases_exercise_every_structural_event() {
    let mut total = [0u64; 5];
    for c in btree_cases() {
        let mut b = BTree::from_keys(c.t, &c.keys, c.keys.len());
        for &d in &c.deletes {
            b.delete_one_counted(d);
        }
        for (t, e) in total.iter_mut().zip(b.event_counts()) {
            *t += e;
        }
    }
    assert!(total.iter().all(|&e| e > 0), "some structural event never fires: {total:?}");
}
