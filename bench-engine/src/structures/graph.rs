//! Undirected **graph**, adjacency-list representation (docs/PLAN.md §8, "Specialized"
//! family) — the production/bench twin of the TypeScript teaching impl
//! (`src/structures/graph.ts`), held to it by `conformance/corpus-graph.txt`
//! (docs/PLAN.md §12, risk R1).
//!
//! **A different op set again (docs/PLAN.md §4.1, §8): build (add edges) + traverse.**
//! A graph is not a key container — there is no insert/search/delete of a *key*. Its
//! vertices are dense integer ids `0..V`, and its operations are adding an edge (O(1))
//! and a whole-graph **traversal** from a source: breadth-first (a queue) or depth-first
//! (a stack). So it belongs only **within its own group** and must never be merged onto the
//! canonical insert/search/delete charts (docs/PLAN.md §8, risk R6). This module is the twin
//! only; the registry entry that keeps it off the shared charts (`!isCanonical`, as the heap
//! is) and its own Compare section land with the measured half — and note that
//! `isCanonical` is currently `id != "heap"`, so adding a `"graph"` id there without also
//! excluding it would silently return `true`.
//!
//! **Representation — an adjacency list, held as a multigraph (never deduped).**
//! `adj[u]` is `u`'s neighbours in edge-insertion order. `add_edge(u, v)` pushes `v` onto
//! `adj[u]` **and** `u` onto `adj[v]` (undirected), so a self-loop `(u, u)` appears **twice**
//! in `adj[u]` — the standard convention that keeps `Σ degree = 2E`. Parallel edges are kept
//! (docs/PLAN.md "Keys are identity; never dedupe"), which is also what keeps `add_edge` O(1):
//! no membership check.
//!
//! **Cost metric — vertex-visits + edge-visits, i.e. `V + 2E` (docs/PLAN.md §8).** Two
//! counting rules, and the whole R1 conformance contract rests on them matching `graph.ts`:
//!   1. A **vertex-visit** is counted once, when a vertex is taken off the frontier and
//!      processed (dequeued in BFS, popped in DFS). Every reached vertex is processed once.
//!   2. An **edge-visit** is counted once per adjacency-list entry *examined* — whether or
//!      not it leads somewhere new. A processed vertex examines all `deg(u)` of its entries.
//! On a **connected** undirected graph both traversals therefore cost exactly `V + 2E`:
//! `V` vertex-visits (each reached once) plus `Σ deg = 2E` edge-visits. That exact identity
//! is the graph's clock-free headline (`structures::methodology`), and it is why the cost is
//! `O(V + E)` rather than `O(E)` — an isolated or barely-connected vertex still costs its
//! visit. On a **disconnected** graph a traversal from one source reaches only that
//! component, so the count is that component's `V' + 2E'` and is strictly less.
//!
//! **BFS and DFS cost the same and visit in different orders** — the point of drawing both.
//! BFS (mark-on-enqueue) fans out by distance from the source; DFS (mark-on-**push**, an
//! explicit stack, *never* recursion — a 10^5-vertex path would overflow the WASM stack, the
//! same hazard that forced the BST's arena) dives down one branch first. Same `V + 2E`, two
//! visitation orders, pinned separately by the corpus.
//!
//! **Counting is a zero-overhead `const COUNT: bool` flag** (docs/PLAN.md §6.4), exactly as
//! every other structure: one traversal body, the `*ops` increments compiled away on the
//! timed hot path and alive on the op-count signal.
//!
//! **Timed WASM harness surface (docs/PLAN.md §6.2).** Unlike the key structures there is no
//! churn or finite-difference cross-check — the operation *is* a full traversal, size-
//! preserving by nature — so the surface is just the batched traversal `bfs_n` / `dfs_n`
//! (timed, `COUNT = false`) and the single-traversal op-count `bfs_counted` / `dfs_counted`
//! (`COUNT = true`). The traversal reuses **preallocated** scratch (a generation-stamped
//! `visited` array and a frontier `Vec`), so no allocation happens inside the timed region —
//! otherwise the curve would measure the allocator, not the walk.

use wasm_bindgen::prelude::*;

/// An undirected graph over dense integer vertex ids `0..num_vertices`, stored as an
/// adjacency-list multigraph (parallel edges and self-loops kept).
#[wasm_bindgen]
pub struct GraphAdj {
    /// `adj[u]` = `u`'s neighbours, in edge-insertion order. Length is `num_vertices`.
    adj: Vec<Vec<u32>>,
    /// Number of undirected edges added (a self-loop counts once here, twice in `adj`).
    edges: usize,
    /// Generation-stamped visited marks: vertex `v` is visited in the current traversal
    /// iff `visited[v] == gen`. Bumping `gen` clears the whole array in O(1), so a traversal
    /// allocates nothing (the timed-region requirement). `gen` wraps only after 2^32
    /// traversals, at which point the array is genuinely rewritten (see `begin_traversal`).
    visited: Vec<u32>,
    /// The current traversal generation.
    gen: u32,
    /// Reused frontier buffer (BFS queue via a head cursor, DFS stack via push/pop). Cleared
    /// with `.clear()` — which keeps the capacity — before each traversal, so it never
    /// reallocates once warmed. Capacity grows to at most `num_vertices`.
    frontier: Vec<u32>,
}

#[wasm_bindgen]
impl GraphAdj {
    /// Build from a flat `edges` buffer of `[u0, v0, u1, v1, …]` vertex-id pairs and an
    /// explicit `num_vertices` (so isolated high-numbered vertices are representable). Pairs
    /// whose endpoints are `< num_vertices` are added as undirected edges; any pair out of
    /// range is skipped (a defensive guard — the TS marshaller keeps ids in range). Mirrors
    /// the other constructors' "build from a marshalled buffer" shape (docs/PLAN.md §4.2).
    #[wasm_bindgen(constructor)]
    pub fn new(edges: &[u32], num_vertices: usize) -> GraphAdj {
        let mut g = GraphAdj {
            adj: vec![Vec::new(); num_vertices],
            edges: 0,
            visited: vec![0u32; num_vertices],
            gen: 0,
            frontier: Vec::with_capacity(num_vertices),
        };
        let mut i = 0;
        while i + 1 < edges.len() {
            let (u, v) = (edges[i], edges[i + 1]);
            g.add_edge(u, v);
            i += 2;
        }
        g
    }

    /// Number of vertices (`V`); the traversal's `O(V + E)` `V`.
    pub fn num_vertices(&self) -> usize {
        self.adj.len()
    }

    /// Number of undirected edges (`E`). A self-loop counts **once** here (it counts twice
    /// toward degree, and toward the `2E` edge-visits, but is one edge).
    pub fn num_edges(&self) -> usize {
        self.edges
    }

    /// Add an undirected edge `u–v`: push each endpoint onto the other's list. A self-loop
    /// (`u == v`) pushes `u` onto `adj[u]` **twice**, the convention that keeps `Σ deg = 2E`.
    /// O(1) — no dedup, so the graph is a multigraph. Out-of-range endpoints are ignored.
    pub fn add_edge(&mut self, u: u32, v: u32) {
        let n = self.adj.len() as u32;
        if u >= n || v >= n {
            return;
        }
        self.adj[u as usize].push(v);
        self.adj[v as usize].push(u);
        self.edges += 1;
    }

    // ── Traversal: the timed harness surface (docs/PLAN.md §6.2) ──

    /// Timed hot path: run `k` full **BFS** traversals from vertex 0, returning the total
    /// number of vertices reached across all runs (so the optimizer can't elide the work,
    /// docs/PLAN.md §6.2). No op-counting overhead (`COUNT = false`). Each run reuses the
    /// preallocated scratch — no allocation in the timed region.
    pub fn bfs_n(&mut self, k: u32) -> u32 {
        let mut ops = 0u64;
        let mut reached = 0u32;
        for _ in 0..k {
            reached = reached.wrapping_add(self.bfs::<false>(0, &mut ops) as u32);
        }
        reached
    }

    /// Op-count signal (§6.4): one BFS from vertex 0 with `COUNT = true`, returning the
    /// vertex-visits + edge-visits (`V + 2E` on a connected graph). `f64` keeps it a plain
    /// JS number.
    pub fn bfs_counted(&mut self) -> f64 {
        let mut ops = 0u64;
        let _ = self.bfs::<true>(0, &mut ops);
        ops as f64
    }

    /// Timed hot path: run `k` full **DFS** traversals from vertex 0 (iterative, explicit
    /// stack, mark-on-push). Returns total vertices reached, to defeat dead-code
    /// elimination. No op-counting overhead (`COUNT = false`).
    pub fn dfs_n(&mut self, k: u32) -> u32 {
        let mut ops = 0u64;
        let mut reached = 0u32;
        for _ in 0..k {
            reached = reached.wrapping_add(self.dfs::<false>(0, &mut ops) as u32);
        }
        reached
    }

    /// Op-count signal (§6.4): one DFS from vertex 0 with `COUNT = true`, returning the
    /// vertex-visits + edge-visits (`V + 2E` on a connected graph — the *same* total as BFS,
    /// a different order).
    pub fn dfs_counted(&mut self) -> f64 {
        let mut ops = 0u64;
        let _ = self.dfs::<true>(0, &mut ops);
        ops as f64
    }
}

impl GraphAdj {
    /// Start a fresh traversal: bump the generation (an O(1) clear of `visited`) and empty
    /// the frontier without freeing it. On the rare `gen` wrap back to 0, rewrite the array
    /// once so a stale `0` mark can't read as visited.
    #[inline]
    fn begin_traversal(&mut self) {
        self.gen = self.gen.wrapping_add(1);
        if self.gen == 0 {
            for m in &mut self.visited {
                *m = 0;
            }
            self.gen = 1;
        }
        self.frontier.clear();
    }

    #[inline]
    fn is_visited(&self, v: u32) -> bool {
        self.visited[v as usize] == self.gen
    }

    #[inline]
    fn mark(&mut self, v: u32) {
        self.visited[v as usize] = self.gen;
    }

    /// Breadth-first traversal from `source`, **mark-on-enqueue**. Returns the number of
    /// vertices reached. Counts (rule 1) one vertex-visit per dequeue and (rule 2) one
    /// edge-visit per adjacency entry examined. The frontier is used as a queue via a head
    /// cursor `head` into `self.frontier` (which only grows), so nothing is allocated.
    #[inline]
    fn bfs<const COUNT: bool>(&mut self, source: u32, ops: &mut u64) -> usize {
        self.begin_traversal();
        if source as usize >= self.adj.len() {
            return 0;
        }
        self.mark(source);
        self.frontier.push(source);
        let mut head = 0usize;
        let mut reached = 0usize;
        while head < self.frontier.len() {
            let u = self.frontier[head];
            head += 1;
            if COUNT {
                *ops += 1; // rule 1: a vertex is visited (dequeued)
            }
            reached += 1;
            // Iterate `adj[u]` without holding a borrow across the `mark`/`push` below.
            let deg = self.adj[u as usize].len();
            for i in 0..deg {
                let w = self.adj[u as usize][i];
                if COUNT {
                    *ops += 1; // rule 2: an adjacency entry is examined
                }
                if !self.is_visited(w) {
                    self.mark(w);
                    self.frontier.push(w);
                }
            }
        }
        reached
    }

    /// Depth-first traversal from `source`, **iterative, mark-on-push** (never recursion —
    /// the WASM-stack hazard a long path would trip). Returns the number of vertices reached.
    /// Same two counting rules as BFS, so the total is identical (`V + 2E` when connected)
    /// while the visitation order differs. Neighbours are pushed in adjacency order, so they
    /// are popped last-to-first — the pinned DFS order (the corpus fixes it; only reachability
    /// is a correctness property).
    #[inline]
    fn dfs<const COUNT: bool>(&mut self, source: u32, ops: &mut u64) -> usize {
        self.begin_traversal();
        if source as usize >= self.adj.len() {
            return 0;
        }
        self.mark(source);
        self.frontier.push(source);
        let mut reached = 0usize;
        while let Some(u) = self.frontier.pop() {
            if COUNT {
                *ops += 1; // rule 1: a vertex is visited (popped)
            }
            reached += 1;
            let deg = self.adj[u as usize].len();
            for i in 0..deg {
                let w = self.adj[u as usize][i];
                if COUNT {
                    *ops += 1; // rule 2: an adjacency entry is examined
                }
                if !self.is_visited(w) {
                    self.mark(w);
                    self.frontier.push(w);
                }
            }
        }
        reached
    }

    // ── Conformance / test surface (docs/PLAN.md §12) ──

    /// The order BFS from `source` visits vertices (dequeue order). A conformance hook; not
    /// on the wasm surface. Uses a private counter, leaving the shared scratch's generation
    /// consistent for the next call.
    pub fn bfs_order(&mut self, source: u32) -> Vec<u32> {
        self.traversal_order::<false>(source)
    }

    /// The order DFS from `source` visits vertices (pop order). A conformance hook.
    pub fn dfs_order(&mut self, source: u32) -> Vec<u32> {
        self.traversal_order::<true>(source)
    }

    /// Shared body for `bfs_order` / `dfs_order`: `DFS = false` ⇒ BFS (queue), `true` ⇒ DFS
    /// (stack). Records the visit order rather than counting. Kept separate from the counted
    /// `bfs`/`dfs` so the timed body stays free of an output `Vec`.
    fn traversal_order<const DFS: bool>(&mut self, source: u32) -> Vec<u32> {
        self.begin_traversal();
        let mut order = Vec::new();
        if source as usize >= self.adj.len() {
            return order;
        }
        self.mark(source);
        self.frontier.push(source);
        let mut head = 0usize;
        loop {
            let u = if DFS {
                match self.frontier.pop() {
                    Some(u) => u,
                    None => break,
                }
            } else {
                if head >= self.frontier.len() {
                    break;
                }
                let u = self.frontier[head];
                head += 1;
                u
            };
            order.push(u);
            let deg = self.adj[u as usize].len();
            for i in 0..deg {
                let w = self.adj[u as usize][i];
                if !self.is_visited(w) {
                    self.mark(w);
                    self.frontier.push(w);
                }
            }
        }
        order
    }

    /// `(vertices reached, op-count)` for one BFS from `source`, with `COUNT = true`. The
    /// corpus's per-traversal `(reached : ops)` cell.
    pub fn bfs_counted_from(&mut self, source: u32) -> (usize, u64) {
        let mut ops = 0u64;
        let reached = self.bfs::<true>(source, &mut ops);
        (reached, ops)
    }

    /// `(vertices reached, op-count)` for one DFS from `source`, with `COUNT = true`.
    pub fn dfs_counted_from(&mut self, source: u32) -> (usize, u64) {
        let mut ops = 0u64;
        let reached = self.dfs::<true>(source, &mut ops);
        (reached, ops)
    }

    /// The adjacency lists, one per vertex, in edge-insertion order — the structure's
    /// observable shape, the counterpart to the skip list's express-lane profile and the
    /// BST's pre-order. A divergent edge-insertion (e.g. pushing only one direction, or
    /// deduping) shows up here even when every traversal still reaches every vertex. A
    /// conformance hook; not on the wasm surface.
    pub fn adjacency(&self) -> Vec<Vec<u32>> {
        self.adj.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build from `(num_vertices, edge pairs)`.
    fn graph(num_vertices: usize, edges: &[(u32, u32)]) -> GraphAdj {
        let flat: Vec<u32> = edges.iter().flat_map(|&(u, v)| [u, v]).collect();
        GraphAdj::new(&flat, num_vertices)
    }

    /// A path `0–1–2–…–(n-1)`: `E = n − 1`, connected, so a traversal costs `n + 2(n−1)`.
    fn path(n: usize) -> GraphAdj {
        let edges: Vec<(u32, u32)> = (0..n as u32 - 1).map(|i| (i, i + 1)).collect();
        graph(n, &edges)
    }

    #[test]
    fn builds_undirected_adjacency_with_both_directions() {
        let g = graph(3, &[(0, 1), (1, 2)]);
        assert_eq!(g.num_vertices(), 3);
        assert_eq!(g.num_edges(), 2);
        // Each edge appears in both endpoints' lists, in insertion order.
        assert_eq!(g.adjacency(), vec![vec![1], vec![0, 2], vec![1]]);
    }

    #[test]
    fn keeps_parallel_edges_and_self_loops() {
        // A parallel edge 0–1 twice, plus a self-loop on 2.
        let g = graph(3, &[(0, 1), (0, 1), (2, 2)]);
        assert_eq!(g.num_edges(), 3);
        // Parallel edges are kept (multigraph); the self-loop appears TWICE in adj[2].
        assert_eq!(g.adjacency(), vec![vec![1, 1], vec![0, 0], vec![2, 2]]);
    }

    #[test]
    fn out_of_range_edges_are_ignored() {
        let g = graph(2, &[(0, 1), (0, 5), (9, 1)]);
        assert_eq!(g.num_edges(), 1);
        assert_eq!(g.adjacency(), vec![vec![1], vec![0]]);
    }

    #[test]
    fn bfs_visits_by_distance_dfs_dives_deep() {
        // A small tree:  0 – 1 – 3
        //                0 – 2
        let mut g = graph(4, &[(0, 1), (0, 2), (1, 3)]);
        // BFS from 0: 0, then its neighbours 1,2 (in order), then 3.
        assert_eq!(g.bfs_order(0), vec![0, 1, 2, 3]);
        // DFS mark-on-push: push 1,2 (stack [1,2]); pop 2 (leaf); pop 1; push 3; pop 3.
        assert_eq!(g.dfs_order(0), vec![0, 2, 1, 3]);
    }

    #[test]
    fn connected_traversal_costs_exactly_v_plus_2e() {
        // A triangle 0-1-2-0: V = 3, E = 3, so V + 2E = 9.
        let mut g = graph(3, &[(0, 1), (1, 2), (2, 0)]);
        let (bfs_reached, bfs_ops) = g.bfs_counted_from(0);
        let (dfs_reached, dfs_ops) = g.dfs_counted_from(0);
        assert_eq!((bfs_reached, bfs_ops), (3, 9), "BFS on a connected graph is V + 2E");
        assert_eq!((dfs_reached, dfs_ops), (3, 9), "DFS costs the same V + 2E, different order");

        // A path of 5: V = 5, E = 4, V + 2E = 13.
        let mut p = path(5);
        assert_eq!(p.bfs_counted_from(0), (5, 13));
        assert_eq!(p.dfs_counted_from(0), (5, 13));
    }

    #[test]
    fn growing_edges_at_fixed_v_moves_the_count_by_exactly_two_per_edge() {
        // Same 4 vertices; add one chord and the count rises by exactly 2 (one edge = two
        // edge-visits). This is the "+E" term the degree-sweep isolates.
        let mut sparse = graph(4, &[(0, 1), (1, 2), (2, 3)]); // path: E = 3
        let mut dense = graph(4, &[(0, 1), (1, 2), (2, 3), (0, 3)]); // + chord: E = 4
        let (_, sparse_ops) = sparse.bfs_counted_from(0);
        let (_, dense_ops) = dense.bfs_counted_from(0);
        assert_eq!(sparse_ops, 4 + 2 * 3, "V + 2E = 4 + 6");
        assert_eq!(dense_ops, 4 + 2 * 4, "V + 2E = 4 + 8");
        assert_eq!(dense_ops - sparse_ops, 2, "one extra edge = two extra edge-visits");
    }

    #[test]
    fn disconnected_traversal_reaches_only_its_component() {
        // Two triangles, 0-1-2 and 3-4-5, with no edge between them.
        let mut g = graph(6, &[(0, 1), (1, 2), (2, 0), (3, 4), (4, 5), (5, 3)]);
        // From 0 we reach only {0,1,2}: V' = 3, E' = 3 ⇒ 9, not the whole graph's 18.
        let (reached, ops) = g.bfs_counted_from(0);
        assert_eq!((reached, ops), (3, 9), "a traversal reaches only the source's component");
        // From 3 we reach the other component, symmetric.
        assert_eq!(g.dfs_counted_from(3), (3, 9));
    }

    #[test]
    fn self_loop_costs_two_edge_visits_but_reaches_one_vertex() {
        // A single vertex with a self-loop: V = 1, E = 1, adj[0] = [0, 0] ⇒ 2 edge-visits.
        let mut g = graph(1, &[(0, 0)]);
        assert_eq!(g.bfs_counted_from(0), (1, 1 + 2), "V + 2E = 1 + 2");
    }

    #[test]
    fn empty_and_isolated_edges() {
        // No vertices at all.
        let mut empty = graph(0, &[]);
        assert_eq!(empty.bfs_counted_from(0), (0, 0));
        assert_eq!(empty.dfs_order(0), Vec::<u32>::new());

        // Isolated vertices, no edges: BFS from 0 reaches just {0}, costs V-visit only.
        let mut iso = graph(3, &[]);
        assert_eq!(iso.bfs_counted_from(0), (1, 1), "an isolated source: one vertex-visit, no edges");
    }

    #[test]
    fn the_timed_and_counted_paths_agree() {
        // bfs_n / dfs_n reach the same vertices the counted variants report.
        let mut g = graph(4, &[(0, 1), (0, 2), (1, 3)]);
        assert_eq!(g.bfs_n(3), 4 * 3, "3 runs × 4 reached");
        assert_eq!(g.dfs_n(2), 4 * 2);
        assert_eq!(g.bfs_counted(), 4.0 + 2.0 * 3.0); // V + 2E = 4 + 6 = 10
        assert_eq!(g.dfs_counted(), 10.0);
    }

    /// A test-only **mark-on-pop** DFS (the same push order, but vertices marked when popped
    /// and re-pops discarded). It is the variant a porter is most likely to write instead of
    /// the impl's mark-on-**push**, and it produces identical orders *and* identical `V + 2E`
    /// counts on every simple case — so only a graph where a vertex is pushed early and then
    /// reached again from deeper in the stack tells them apart. This mirrors the counterexample
    /// tests the heap and trie carry (`a_high_churn_key_would_drain_the_heap`,
    /// `a_prefix_free_churn_key_allocates_a_whole_branch`): it pins that the corpus's DFS-order
    /// line actually discriminates the two implementations, so a silent regression to mark-on-pop
    /// would fail conformance rather than pass it.
    fn mark_on_pop_dfs_order(g: &GraphAdj, source: u32) -> Vec<u32> {
        let mut order = Vec::new();
        let mut visited = vec![false; g.adjacency().len()];
        if (source as usize) >= visited.len() {
            return order;
        }
        let mut stack = vec![source];
        let adj = g.adjacency();
        while let Some(u) = stack.pop() {
            if visited[u as usize] {
                continue; // a duplicate push, reached first from elsewhere
            }
            visited[u as usize] = true;
            order.push(u);
            for &w in &adj[u as usize] {
                if !visited[w as usize] {
                    stack.push(w);
                }
            }
        }
        order
    }

    #[test]
    fn the_corpus_dfs_case_distinguishes_mark_on_push_from_mark_on_pop() {
        // The `dfs_variant` corpus case (V = 5).
        let mut g = graph(5, &[(0, 1), (0, 4), (0, 2), (2, 3), (3, 1)]);
        let push_order = g.dfs_order(0);
        let pop_order = mark_on_pop_dfs_order(&g, 0);
        // Both traversals cost the same and reach everything — only the ORDER separates them.
        assert_eq!(g.dfs_counted_from(0), (5, 5 + 2 * 5));
        assert_eq!(push_order, vec![0, 2, 3, 4, 1], "mark-on-push (the impl)");
        assert_eq!(pop_order, vec![0, 2, 3, 1, 4], "mark-on-pop (the wrong variant)");
        assert_ne!(push_order, pop_order, "the corpus DFS-order line must catch the difference");
    }

    #[test]
    fn generation_stamp_survives_many_traversals() {
        // Running many traversals must not corrupt the visited marks (no O(V) clear bug).
        let mut g = path(10);
        for _ in 0..1000 {
            assert_eq!(g.bfs_counted_from(0), (10, 10 + 2 * 9));
        }
    }
    /// **Nothing is allocated inside the timed region** (docs/METHODOLOGY.md §2.7) — the
    /// measured half's precondition, pinned on the scratch buffers themselves. `bfs_n` /
    /// `dfs_n` are what the browser times; if either grew `frontier` or rebuilt `visited`, the
    /// curve would carry the allocator's cost, and the first timed batch would pay a growth the
    /// later ones do not. Same capacity and same heap pointers before and after many runs.
    ///
    /// The graph is chosen to be the worst case for the frontier: a dense multigraph with
    /// parallel edges and self-loops, where a *mark-on-pop* DFS would push a vertex once per
    /// incoming entry and overflow a `V`-sized buffer. Mark-on-push pushes each vertex at most
    /// once, so the preallocated `V` slots always suffice.
    #[test]
    fn the_timed_traversals_never_grow_their_scratch() {
        let n = 64u32;
        let mut edges = Vec::new();
        for u in 0..n {
            for v in 0..n {
                edges.push((u, v)); // every ordered pair: K_n twice over, plus a loop on each
            }
        }
        let mut g = graph(n as usize, &edges);
        let (cap, fptr, vptr) = (g.frontier.capacity(), g.frontier.as_ptr(), g.visited.as_ptr());
        assert!(cap >= n as usize, "frontier preallocated to V");
        assert_eq!(g.bfs_n(200), 200 * n);
        assert_eq!(g.dfs_n(200), 200 * n);
        assert_eq!(g.frontier.capacity(), cap, "the frontier never reallocates");
        assert_eq!(g.frontier.as_ptr(), fptr);
        assert_eq!(g.visited.as_ptr(), vptr, "visited is cleared by generation, never rebuilt");
        // The counted (op-count) path shares the same scratch and leaves it untouched too.
        let ops = (n + 2 * n * n) as f64;
        assert_eq!(g.bfs_counted(), ops);
        assert_eq!(g.dfs_counted(), ops);
        assert_eq!(g.frontier.as_ptr(), fptr);
    }
}
