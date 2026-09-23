//! Property tests for the graph bench twin (docs/PLAN.md §12, risk R1). Random undirected
//! graphs must keep the twin's observable behaviour in step with two independent references:
//! a **union-find** for connectivity (which vertices a traversal should reach) and a **degree
//! sum** over that component (what the `V + 2E` op-count should be).
//!
//! Scope is **correctness of reachability and the cost identity**. The exact BFS/DFS visit
//! *orders* are deliberately not checked here — a reference able to reproduce them would just
//! be a second graph traversal (circular); those are pinned by the hand-written unit tests in
//! `src/structures/graph.rs` and the cross-language `conformance/corpus-graph.txt`.

use bench_engine::structures::graph::GraphAdj;
use proptest::prelude::*;
use std::collections::BTreeSet;

/// Minimal union-find over `n` vertices, unioning each edge — the independent reachability
/// reference. The set of roots equal to `find(source)` is `source`'s connected component.
struct UnionFind {
    parent: Vec<usize>,
}
impl UnionFind {
    fn new(n: usize) -> Self {
        UnionFind { parent: (0..n).collect() }
    }
    fn find(&mut self, x: usize) -> usize {
        let mut r = x;
        while self.parent[r] != r {
            r = self.parent[r];
        }
        // Path-compress.
        let mut c = x;
        while self.parent[c] != r {
            let next = self.parent[c];
            self.parent[c] = r;
            c = next;
        }
        r
    }
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[ra] = rb;
        }
    }
}

/// The connected component of `source`, as a sorted set, computed independently of the twin.
fn component(n: usize, edges: &[(u32, u32)], source: usize) -> BTreeSet<u32> {
    let mut uf = UnionFind::new(n);
    for &(u, v) in edges {
        uf.union(u as usize, v as usize);
    }
    let root = uf.find(source);
    (0..n).filter(|&v| uf.find(v) == root).map(|v| v as u32).collect()
}

proptest! {
    /// From vertex 0, BFS and DFS reach the *same* set of vertices, that set is exactly 0's
    /// connected component (union-find reference), and each traversal's op-count equals
    /// `|C| + Σ_{v∈C} deg(v)` — one vertex-visit per reached vertex plus one edge-visit per
    /// adjacency entry those vertices hold. That degree sum is `2·(edges inside C)`, so the
    /// identity is the `V + 2E` rule restricted to the reached component.
    #[test]
    fn graph_reachability_and_cost_match_references(
        n in 1usize..30,
        raw_edges in prop::collection::vec((0u32..30, 0u32..30), 0..80),
    ) {
        // Keep only in-range endpoints, matching the twin's own guard.
        let edges: Vec<(u32, u32)> =
            raw_edges.into_iter().filter(|&(u, v)| (u as usize) < n && (v as usize) < n).collect();
        let flat: Vec<u32> = edges.iter().flat_map(|&(u, v)| [u, v]).collect();
        let mut g = GraphAdj::new(&flat, n);

        let comp = component(n, &edges, 0);

        // Both traversals reach exactly the component.
        let bfs_set: BTreeSet<u32> = g.bfs_order(0).into_iter().collect();
        let dfs_set: BTreeSet<u32> = g.dfs_order(0).into_iter().collect();
        prop_assert_eq!(&bfs_set, &comp, "BFS must reach exactly 0's component");
        prop_assert_eq!(&dfs_set, &comp, "DFS must reach exactly 0's component");

        // The cost identity: |C| + Σ deg over the component, from the adjacency the twin holds.
        let adj = g.adjacency();
        let degree_sum: u64 = comp.iter().map(|&v| adj[v as usize].len() as u64).sum();
        let expected = comp.len() as u64 + degree_sum;

        let (bfs_reached, bfs_ops) = g.bfs_counted_from(0);
        let (dfs_reached, dfs_ops) = g.dfs_counted_from(0);
        prop_assert_eq!(bfs_reached, comp.len());
        prop_assert_eq!(dfs_reached, comp.len());
        prop_assert_eq!(bfs_ops, expected, "BFS op-count must be |C| + Σ deg");
        prop_assert_eq!(dfs_ops, expected, "DFS op-count must equal BFS's");
    }
}
