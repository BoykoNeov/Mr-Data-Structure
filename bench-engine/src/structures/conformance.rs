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

use super::dyn_array::ArrayF64;
use super::hash_set::HashSetF64;

const CORPUS_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../conformance/corpus.txt");

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
