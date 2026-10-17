//! Red-black tree conformance corpus (docs/PLAN.md §8 trees, §12, risk R1) —
//! `conformance/corpus-rbt.txt`, generated from the Rust bench impl and reproduced by the
//! TypeScript teaching twin (`src/structures/conformance-rbt.test.ts`).
//!
//! Kept in its own file rather than appended to `conformance.rs` so that structure's corpus
//! code does not grow a merge hotspot; the line format and the regenerate/compare pair are
//! the same as every other corpus there.
//!
//! The dimensions, over the AVL corpus's:
//! - **shape with colours** — a pre-order with `.` for NIL and each node tagged `r`/`b`.
//!   Two trees of the same shape but different colours behave differently on the very next
//!   operation, so the shape alone would let a mis-coloured fix-up pass.
//! - **per-insert op-counts** during the build (`rbt_insert`), which the AVL corpus lacks:
//!   the insert fix-up is where the scheme's rotations happen, so it gets its own column.
//! - the **rotation and recolour totals** for the build and for the delete sequence. The
//!   shared metric (comparisons + rotations) does not include recolours (see the `rbt`
//!   module doc), but the methodology write-up reports them, so the TS twin must agree on
//!   them too.
//!
//! The cases cover every fix-up branch: insert — red uncle, black uncle zig-zag (double
//! rotation), black uncle straight line; delete — red sibling, black sibling with black
//! nephews, near nephew red (then far), far nephew red; plus a red-leaf delete (no fix-up),
//! two-child deletes including the root, equal keys going right, empty and singleton trees,
//! ascending and descending input.

use super::rbt::{Cost, RbtF64};

const CORPUS_RBT_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus-rbt.txt");

struct RbtCase {
    name: &'static str,
    keys: Vec<f64>,
    probes: Vec<f64>,
    deletes: Vec<f64>,
}

fn fs(xs: &[i32]) -> Vec<f64> {
    xs.iter().map(|&x| x as f64).collect()
}

fn rbt_cases() -> Vec<RbtCase> {
    // A fixed permutation of 0..32 (integer keys round-trip through TS `Number()`).
    let perm = [
        17, 3, 29, 8, 22, 0, 14, 31, 5, 26, 11, 19, 1, 24, 9, 30, 6, 15, 27, 2, 20, 12, 28, 4, 18,
        10, 23, 7, 25, 13, 21, 16,
    ];
    vec![
        RbtCase { name: "empty", keys: vec![], probes: fs(&[1, 2]), deletes: fs(&[1]) },
        RbtCase { name: "singleton", keys: fs(&[42]), probes: fs(&[42, 7]), deletes: fs(&[42]) },
        // Ascending — the BST's chain: straight-line rotations and red-uncle recolours in turn.
        RbtCase {
            name: "ascending",
            keys: fs(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
            probes: fs(&[1, 10, 5, 11, 0]),
            deletes: fs(&[1, 2, 3]),
        },
        // Descending — the mirror image (the left-hand branch of every fix-up).
        RbtCase {
            name: "descending",
            keys: fs(&[10, 9, 8, 7, 6, 5, 4, 3, 2, 1]),
            probes: fs(&[10, 1, 0]),
            deletes: fs(&[10, 9, 8]),
        },
        // Insert, black uncle, zig-zag: the double rotation (left-right, then right-left).
        RbtCase { name: "zig_zag_left", keys: fs(&[30, 10, 20]), probes: fs(&[20]), deletes: vec![] },
        RbtCase { name: "zig_zag_right", keys: fs(&[10, 30, 20]), probes: fs(&[20]), deletes: vec![] },
        // Insert, red uncle: recolour only, the root goes red and back.
        RbtCase { name: "red_uncle", keys: fs(&[20, 10, 30, 5]), probes: fs(&[5, 25]), deletes: fs(&[5]) },
        // Equal keys go right and still rebalance; deletes remove one occurrence at a time.
        RbtCase {
            name: "equal_right",
            keys: fs(&[50, 50, 50, 70, 50]),
            probes: fs(&[50, 70, 99]),
            deletes: fs(&[50, 50, 99]),
        },
        // Delete, red sibling (case 1) then black sibling with black nephews (case 2).
        RbtCase {
            name: "delete_red_sibling",
            keys: fs(&[10, 5, 20, 15, 25, 30]),
            probes: fs(&[30]),
            deletes: fs(&[5]),
        },
        // Delete, black sibling with two black nephews: recolour and move up (case 2).
        RbtCase {
            name: "delete_black_nephews",
            keys: fs(&[20, 10, 30, 5]),
            probes: fs(&[10]),
            deletes: fs(&[5, 30]),
        },
        // Delete, near nephew red, far black: case 3 into case 4 (two rotations).
        RbtCase {
            name: "delete_near_nephew",
            keys: fs(&[20, 10, 30, 15]),
            probes: fs(&[15]),
            deletes: fs(&[30]),
        },
        // Delete, far nephew red: case 4 directly (one rotation).
        RbtCase {
            name: "delete_far_nephew",
            keys: fs(&[20, 10, 30, 5]),
            probes: fs(&[5]),
            deletes: fs(&[30]),
        },
        // Two-child (value-copy) deletes, including the root.
        RbtCase {
            name: "two_child_root",
            keys: fs(&[50, 30, 70, 20, 40, 60, 80]),
            probes: fs(&[50, 20, 35]),
            deletes: fs(&[50, 30, 70]),
        },
        // A shuffled build torn down completely by alternating max / min — the engine's
        // teardown order — so every delete branch is exercised at depth.
        RbtCase {
            name: "teardown",
            keys: fs(&perm),
            probes: fs(&[0, 31, 16, 32, -1]),
            deletes: fs(&[
                31, 0, 30, 1, 29, 2, 28, 3, 27, 4, 26, 5, 25, 6, 24, 7, 23, 8, 22, 9, 21, 10, 20,
                11, 19, 12, 18, 13, 17, 14, 16, 15,
            ]),
        },
        // The same build, deleted in an order unrelated to it (with misses mixed in).
        RbtCase {
            name: "mixed",
            keys: fs(&perm),
            probes: fs(&[7, 99]),
            deletes: fs(&[16, 99, 8, 24, 4, 12, 20, 28, 2, 6, 10, 14, 18, 22, 26, 30, -5]),
        },
    ]
}

fn fmt_nums(xs: &[f64]) -> String {
    xs.iter().map(|x| format!("{x}")).collect::<Vec<_>>().join(" ")
}

fn fmt_flag_ops(results: &[(bool, u64)]) -> String {
    results
        .iter()
        .map(|&(flag, ops)| format!("{}:{ops}", flag as u8))
        .collect::<Vec<_>>()
        .join(" ")
}

fn fmt_shape(t: &RbtF64) -> String {
    t.preorder()
        .iter()
        .map(|n| match n {
            Some((v, red)) => format!("{v}{}", if *red { 'r' } else { 'b' }),
            None => ".".to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn serialize_rbt(cases: &[RbtCase]) -> String {
    let mut out = String::new();
    out.push_str("# Mr Data Structure — red-black tree conformance corpus (docs/PLAN.md §8, §12).\n");
    out.push_str("# Generated from the Rust bench impl; the TS teaching twin must match.\n");
    out.push_str("# Op-count = comparisons + rotations (recolours are reported separately).\n");
    out.push_str("# Shape = pre-order, `.` for NIL, each node tagged r (red) / b (black).\n");
    out.push_str("# Regenerate: cargo test -- --ignored regen_corpus_rbt\n");
    for c in cases {
        // Build key by key, recording each insert's op-count and the build totals.
        let mut t = RbtF64::new_empty();
        let mut build = Cost::default();
        let mut inserts = Vec::with_capacity(c.keys.len());
        for &k in &c.keys {
            let cost = t.insert_one_detail(k);
            inserts.push(cost.ops());
            build.comparisons += cost.comparisons;
            build.rotations += cost.rotations;
            build.recolours += cost.recolours;
        }
        let search: Vec<(bool, u64)> = c.probes.iter().map(|&p| t.search_one_counted(p)).collect();
        let shape = fmt_shape(&t);

        let mut dels = Cost::default();
        let del: Vec<(bool, u64)> = c
            .deletes
            .iter()
            .map(|&d| {
                let (removed, cost) = t.delete_one_detail(d);
                dels.comparisons += cost.comparisons;
                dels.rotations += cost.rotations;
                dels.recolours += cost.recolours;
                (removed, cost.ops())
            })
            .collect();
        assert!(t.check_rb(), "corpus case {} left an invalid tree", c.name);

        out.push('\n');
        out.push_str(&format!("case {}\n", c.name));
        out.push_str(&format!("keys {}\n", fmt_nums(&c.keys)));
        out.push_str(&format!("probes {}\n", fmt_nums(&c.probes)));
        out.push_str(&format!(
            "rbt_insert {}\n",
            inserts.iter().map(|o| o.to_string()).collect::<Vec<_>>().join(" ")
        ));
        out.push_str(&format!("rbt_order {}\n", fmt_nums(&RbtF64::new(&c.keys, c.keys.len()).keys_in_order())));
        out.push_str(&format!("rbt_search {}\n", fmt_flag_ops(&search)));
        out.push_str(&format!("rbt_shape {shape}\n"));
        out.push_str(&format!("deletes {}\n", fmt_nums(&c.deletes)));
        out.push_str(&format!("rbt_delete {}\n", fmt_flag_ops(&del)));
        out.push_str(&format!("rbt_shape_after {}\n", fmt_shape(&t)));
        out.push_str(&format!("rbt_rotations {} {}\n", build.rotations, dels.rotations));
        out.push_str(&format!("rbt_recolours {} {}\n", build.recolours, dels.recolours));
    }
    out
}

/// Strip carriage returns so a CRLF checkout compares equal to LF output.
fn normalize(s: &str) -> String {
    s.replace('\r', "")
}

#[test]
#[ignore = "writes the committed red-black corpus; run deliberately after a behavior change"]
fn regen_corpus_rbt() {
    std::fs::write(CORPUS_RBT_PATH, serialize_rbt(&rbt_cases())).expect("write rbt corpus");
}

#[test]
fn corpus_rbt_matches_committed() {
    let committed = std::fs::read_to_string(CORPUS_RBT_PATH).expect(
        "red-black corpus missing; generate it with: cargo test -- --ignored regen_corpus_rbt",
    );
    assert_eq!(
        normalize(&committed),
        normalize(&serialize_rbt(&rbt_cases())),
        "red-black conformance corpus is stale vs the Rust impl; \
         regenerate with: cargo test -- --ignored regen_corpus_rbt",
    );
}

/// The corpus is only worth its name if it reaches every fix-up branch. This counts, over
/// all the cases, the operations that rotated and recoloured in each characteristic way, so
/// a later edit that trims a case cannot quietly drop a branch.
#[test]
fn corpus_rbt_reaches_every_rotation_count() {
    let mut insert_rot = [0usize; 3]; // inserts that rotated 0 / 1 / 2 times
    let mut delete_rot = [0usize; 4]; // deletes that rotated 0..=3 times
    for c in rbt_cases() {
        let mut t = RbtF64::new_empty();
        for &k in &c.keys {
            insert_rot[t.insert_one_detail(k).rotations as usize] += 1;
        }
        for &d in &c.deletes {
            let (removed, cost) = t.delete_one_detail(d);
            if removed {
                delete_rot[cost.rotations as usize] += 1;
            }
        }
    }
    assert!(insert_rot.iter().all(|&n| n > 0), "insert rotation counts reached: {insert_rot:?}");
    assert!(delete_rot.iter().all(|&n| n > 0), "delete rotation counts reached: {delete_rot:?}");
}
