// Phase 2 runtime proof (docs/PLAN.md §10, risk R2): drive the built app in
// headless Chromium and confirm the *real wall-clock* search sweep produces the
// headline result — array search rises (O(n)) while hash-set search stays flat
// (O(1)). build-green does not prove this; only the browser clock does (R2),
// which is why this lives here rather than in Vitest. Run against a `vite
// preview` server:  node scripts/verify-browser.mjs http://localhost:4173
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:4173';
// VERIFY_CHROMIUM lets a sandbox point at a pre-installed Chromium instead of
// the version-pinned download Playwright would otherwise insist on.
const browser = await chromium.launch(
  process.env.VERIFY_CHROMIUM ? { executablePath: process.env.VERIFY_CHROMIUM } : {},
);
const page = await browser.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let ok = false;
let proof = null;
let mutation = null;
let bst = null;
let avl = null;
let heap = null;
let revBst = null;
let revAvl = null;
let revHeap = null;
let meta = null;
let text = '(no text captured)';
const checks = [];

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The sweeps run in a worker; wait until the **min-heap** mutation proof publishes — it
  // is set last, after the search sweep and the array/hashset, BST and AVL mutation
  // sweeps — or until the app reports an error. Generous timeout: the sweeps do real timed
  // work, and the heap adds a fifth search series plus a sixth mutation sweep.
  await page.waitForFunction(
    () =>
      window.__heapMutationProof !== undefined ||
      /status:\s*error/.test(document.body.innerText),
    { timeout: 90000 },
  );
  text = await page.evaluate(() => document.body.innerText);
  proof = await page.evaluate(() => window.__sweepProof ?? null);
  mutation = await page.evaluate(() => window.__mutationProof ?? null);
  bst = await page.evaluate(() => window.__bstMutationProof ?? null);
  avl = await page.evaluate(() => window.__avlMutationProof ?? null);
  heap = await page.evaluate(() => window.__heapMutationProof ?? null);
  meta = await page.evaluate(() => window.__compareMeta ?? null);

  const want = (name, cond) => checks.push({ name, pass: !!cond });

  // Phase 5: the default Compare run is one *uniform* dataset driving every structure
  // (docs/PLAN.md §10), and every fit carries its uncertainty (docs/METHODOLOGY.md §3).
  if (meta) {
    want('compare meta published (uniform default dataset)', meta.order && meta.order.kind === 'uniform');
    want('default dataset reads as the random shape', meta.shape === 'random');
  }
  if (proof) {
    want(
      'every search fit carries a finite slope stderr + tail slope',
      proof.every((p) => Number.isFinite(p.slopeStderr) && Number.isFinite(p.tailSlope) && typeof p.trend === 'string'),
    );
    const array = proof.find((p) => p.structure === 'array');
    const ll = proof.find((p) => p.structure === 'll');
    const sarrSearch = proof.find((p) => p.structure === 'sarr');
    const hashset = proof.find((p) => p.structure === 'hashset');
    const heapSearch = proof.find((p) => p.structure === 'heap');

    want(
      'five search series measured',
      proof.length === 5 && array && ll && sarrSearch && hashset && heapSearch,
    );
    if (array) {
      const ratio = array.lastNanos / array.firstNanos;
      want('array search labelled O(n)', array.best === 'O(n)');
      want('array search slope ~1 (0.7..1.4)', array.slope >= 0.7 && array.slope <= 1.4);
      want(`array search rises with n (ratio ${ratio.toFixed(1)} > 20)`, ratio > 20);
    }
    // Linked list: O(n) like the array but via pointer-walk, not a contiguous scan — the
    // §2.2 "same shape, different mechanism" contrast. Same slope band + rise assertions.
    if (ll) {
      const ratio = ll.lastNanos / ll.firstNanos;
      want('linked-list search labelled O(n)', ll.best === 'O(n)');
      want('linked-list search slope ~1 (0.7..1.4)', ll.slope >= 0.7 && ll.slope <= 1.4);
      want(`linked-list search rises with n (ratio ${ratio.toFixed(1)} > 20)`, ratio > 20);
    }
    // Sorted array: the "missing middle" — binary search is sub-linear (O(log n)). Assert
    // the slope *band* (well below the array's ~1), NOT the label: the §7.2 fitter cannot
    // reliably separate log n from constant, so `best` may come back O(1) or O(log n).
    if (sarrSearch && array) {
      want(
        `sorted-array search sub-linear (slope ${sarrSearch.slope.toFixed(2)} < 0.4)`,
        sarrSearch.slope < 0.4,
      );
      want(
        `sorted-array search flatter than array (${sarrSearch.slope.toFixed(2)} < ${array.slope.toFixed(2)})`,
        sarrSearch.slope < array.slope,
      );
    }
    if (hashset) {
      const ratio = hashset.lastNanos / hashset.firstNanos;
      want('hashset search labelled O(1)', hashset.best === 'O(1)');
      want('hashset search slope ~0 (< 0.4)', hashset.slope < 0.4);
      want(`hashset search stays flat (ratio ${ratio.toFixed(1)} < 10)`, ratio < 10);
    }
    // Min-heap search (docs/PLAN.md §8, risk R6): the deliberate O(n)-scan **contrast**, not
    // a fifth competitor. A heap is ordered for its root only, so a lookup has no shortcut
    // and must read O(n) exactly like the unsorted array's scan. The UI keeps this series
    // off the shared chart; measuring it on the same ladder is what makes the two
    // comparable at all.
    if (heapSearch) {
      const ratio = heapSearch.lastNanos / heapSearch.firstNanos;
      want('heap search labelled O(n) — no lookup shortcut', heapSearch.best === 'O(n)');
      want(`heap search slope ~1 (0.7..1.4)`, heapSearch.slope >= 0.7 && heapSearch.slope <= 1.4);
      want(`heap search rises with n (ratio ${ratio.toFixed(1)} > 20)`, ratio > 20);
    }
  }

  // Mutation (docs/PLAN.md §6.3): the real clock is too noisy for absolute-ns
  // sum tolerances at these small sizes, so we assert *class*-level agreement —
  // the churn primary's shape and that the finite-difference split orders the
  // ops correctly (array delete grows, insert stays flat).
  if (mutation) {
    const find = (st, op) => mutation.find((m) => m.structure === st && m.op === op);
    const aChurn = find('array', 'churn');
    const hChurn = find('hashset', 'churn');
    const aIns = find('array', 'insert');
    const aDel = find('array', 'delete');

    want('twelve mutation series measured (four flat structures)', mutation.length === 12);
    if (aChurn) {
      const ratio = aChurn.lastNanos / aChurn.firstNanos;
      want(`array churn rises (slope ${aChurn.slope.toFixed(2)} > 0.6)`, aChurn.slope > 0.6);
      want(`array churn grows with n (ratio ${ratio.toFixed(1)} > 3)`, ratio > 3);
    }
    if (hChurn) {
      want(`hashset churn stays flat (slope ${hChurn.slope.toFixed(2)} < 0.4)`, hChurn.slope < 0.4);
    }
    if (aIns && aDel) {
      want(
        `array delete grows faster than insert (del ${aDel.slope.toFixed(2)} > ins ${aIns.slope.toFixed(2)})`,
        aDel.slope > aIns.slope,
      );
    }

    // ── Sorted array (docs/METHODOLOGY.md §2.3 regime 6) ──
    //
    // Its churn key is `min − 1`, deliberately the **front**: every insert and delete
    // shifts the whole array, which is the structure's honest O(n). A tail key would
    // append/pop with zero shifts and report O(log n) — the key's position, not the
    // structure, would have set the class. Measured slope runs a little under 1 (0.80
    // here) because a memmove is fast enough that the binary search's comparisons still
    // show at the small end, so the band is the same > 0.6 used for the array's churn.
    const sChurn = find('sarr', 'churn');
    const sDel = find('sarr', 'delete');
    if (sChurn) {
      const ratio = sChurn.lastNanos / sChurn.firstNanos;
      want(`sorted-array churn rises (slope ${sChurn.slope.toFixed(2)} > 0.6)`, sChurn.slope > 0.6);
      want(`sorted-array churn grows with n (ratio ${ratio.toFixed(1)} > 3)`, ratio > 3);
    }
    // The split that only this structure has, and that until now was proven only
    // clock-free: **sub-linear search, linear mutation on the same structure**. Sorting
    // buys the lookup and charges for every change. (The heap's split is the mirror
    // image: O(n) search, Θ(log n) extract-min.)
    const sarrSearchFit = proof && proof.find((p) => p.structure === 'sarr');
    if (sChurn && sarrSearchFit) {
      want(
        `sorted array: search sub-linear (${sarrSearchFit.slope.toFixed(2)}) but churn linear (${sChurn.slope.toFixed(2)})`,
        sarrSearchFit.slope < 0.4 && sChurn.slope > 0.6,
      );
    }
    if (sDel) {
      want(`sorted-array delete grows (slope ${sDel.slope.toFixed(2)} > 0.6)`, sDel.slope > 0.6);
    }

    // ── Linked list (docs/METHODOLOGY.md §2.3 regime 7) — the class *disagreement*,
    // on the real clock for the first time ──
    //
    // The list head-inserts, so the churn key lands at the head and the paired delete
    // finds it in one visit: churn is honestly **O(1)**, and there is no size-preserving
    // same-key churn on this structure that isn't. Read alone, that flat line is
    // indistinguishable from the hash set's and would suggest a cheap list. The
    // finite-difference `delete` — the canonical delete-by-value, walking from the head —
    // is **O(n)** on the same run. The two methods land in *different complexity
    // classes*, and this gate pins that they do, because the honest reading of the list
    // requires both curves at once (the UI states it next to the chart).
    const lChurn = find('ll', 'churn');
    const lDel = find('ll', 'delete');
    if (lChurn) {
      // Two-sided, and looser than the other flat-line bands, for a measured reason. At ~9
      // ns/op this series sits *on* the timer's quantization floor — one run reported
      // firstNanos === lastNanos to sixteen digits with R² 1.0 and a slope stderr of 5.7e-9,
      // i.e. the clock's granularity, not the list, set the number. Quantization then walks
      // the fitted slope around freely on a curve whose true slope is 0: five runs gave
      // 0.00, −0.35, −0.05, −0.05, 0.00. The noise is *signed*, so a one-sided `< 0.4` band
      // would have failed at random on a run that swung the other way. `|slope| < 0.6` keeps
      // the same sub-linear threshold the bst/avl/heap churn checks use, with headroom past
      // the worst reading actually observed. The class-disagreement claim does not lean on
      // this check anyway — the O(n) delete and the 500×+ cost gap below carry it.
      want(
        `linked-list churn stays flat (|slope| ${Math.abs(lChurn.slope).toFixed(2)} < 0.6)`,
        Math.abs(lChurn.slope) < 0.6,
      );
    }
    if (lDel) {
      const ratio = lDel.lastNanos / lDel.firstNanos;
      want(
        `linked-list delete-by-value reads O(n) (slope ${lDel.slope.toFixed(2)} > 0.6)`,
        lDel.slope > 0.6,
      );
      want(`linked-list delete grows with n (ratio ${ratio.toFixed(1)} > 3)`, ratio > 3);
    }
    if (lChurn && lDel) {
      want(
        `linked list: churn and delete-by-value disagree on class (${lChurn.slope.toFixed(2)} vs ${lDel.slope.toFixed(2)})`,
        Math.abs(lChurn.slope) < 0.6 && lDel.slope > 0.6,
      );
      // ...and by a margin no one can mistake for noise: the same structure, the same
      // run, one op flat at single-digit ns and the other in the thousands.
      const gap = lDel.lastNanos / lChurn.lastNanos;
      want(
        `linked-list delete-by-value costs vastly more than head churn (${gap.toFixed(0)}x > 20x)`,
        gap > 20,
      );
    }
    // Both flat-family structures stay on the *first* pass only: neither is
    // shape-sensitive (a sorted array re-sorts whatever arrives; a list head-inserts
    // regardless), so there is nothing for reverse-sorted input to flip. Note for anyone
    // adding one later: the second pass below does NOT reset `__mutationProof`, so an
    // assert placed after it would read this pass's numbers and pass vacuously.
  }

  // BST mutation (docs/PLAN.md §6.3, §8 trees): the first tree bench twin on a
  // *balanced* (uniform) dataset. The real clock is too noisy for the absolute-ns
  // overshoot sum (proven clock-free in Rust); here we confirm the worker→WASM BST
  // path resolves and that balanced-tree mutation is **sub-linear** (O(log n)) —
  // the churn primary stays far flatter than the array's O(n) churn.
  if (bst) {
    const bChurn = bst.find((m) => m.structure === 'bst' && m.op === 'churn');
    want('three BST mutation series measured', bst.length === 3);
    if (bChurn) {
      const ratio = bChurn.lastNanos / bChurn.firstNanos;
      want(
        `BST churn sub-linear (slope ${bChurn.slope.toFixed(2)} < 0.6)`,
        bChurn.slope < 0.6,
      );
      want(`BST churn stays near-flat (ratio ${ratio.toFixed(1)} < 6)`, ratio < 6);
    }
  }

  // AVL mutation (docs/PLAN.md §6.3, §8 trees): the *balanced* tree bench twin on the
  // same shuffled (uniform) dataset as the BST. Like the BST, the real clock is too
  // noisy for the absolute-ns churn-vs-fd claim (proven clock-free in Rust); here we
  // confirm the worker→WASM AVL path resolves and that balanced-tree mutation is
  // **sub-linear** (O(log n)) — far flatter than the array's O(n) churn.
  if (avl) {
    const aChurn = avl.find((m) => m.structure === 'avl' && m.op === 'churn');
    want('three AVL mutation series measured', avl.length === 3);
    if (aChurn) {
      const ratio = aChurn.lastNanos / aChurn.firstNanos;
      want(
        `AVL churn sub-linear (slope ${aChurn.slope.toFixed(2)} < 0.6)`,
        aChurn.slope < 0.6,
      );
      want(`AVL churn stays near-flat (ratio ${ratio.toFixed(1)} < 6)`, ratio < 6);
    }
  }

  // Min-heap mutation (docs/PLAN.md §6.3, §8 trees/heaps): the churn primary here is
  // insert + **extract-min**, so it is read only against the heap's own split, never
  // against the structures above (risk R6). Two things the real clock can show that the
  // clock-free Rust proof cannot: that the worker→WASM heap path resolves at all, and that
  // the measured curve is **sub-linear** — one root-to-leaf walk per operation. The
  // absolute-ns constant is deliberately high (churn inserts a new global minimum, the
  // worst-case insert), so only the *shape* is asserted (docs/METHODOLOGY.md §4.2).
  if (heap) {
    const hChurn = heap.find((m) => m.structure === 'heap' && m.op === 'churn');
    const hIns = heap.find((m) => m.structure === 'heap' && m.op === 'insert');
    const hDel = heap.find((m) => m.structure === 'heap' && m.op === 'delete');
    want('three heap mutation series measured', heap.length === 3);
    if (hChurn) {
      const ratio = hChurn.lastNanos / hChurn.firstNanos;
      want(
        `heap churn sub-linear (slope ${hChurn.slope.toFixed(2)} < 0.6)`,
        hChurn.slope < 0.6,
      );
      want(`heap churn stays near-flat (ratio ${ratio.toFixed(1)} < 6)`, ratio < 6);
    }
    // The heap's signature asymmetry on a shuffled build: an ordinary insert usually stops
    // after a level or two (most of a heap is leaves), while every extract-min must sift the
    // refill all the way back down. Op-counts put that gap at ~9x (insert_fd 3.6 vs
    // delete_fd 31.3 at n = 4000, pinned in Rust).
    //
    // Asserted on **magnitude, not slope**, deliberately. Both series are sub-linear, so
    // unlike the array's O(n) delete vs O(1) append there is no class gap for a slope
    // comparison to catch — and both of the heap's finite-difference halves are
    // noise-dominated at these sizes. Insert has been measured at 0.31 ± 0.20 (R² 0.93) and
    // 0.26 ± 0.28 (R² 0.89) — a standard error the size of the slope — and one run fitted
    // *extract-min* as O(n log n) (0.89 ± 0.27) when its true class is Θ(log n). So neither
    // half's class label is asserted here, and their slope ordering flips between runs.
    // That is docs/METHODOLOGY.md §4 hurdles 2 and 7 in the wild: differencing two
    // cumulative timings of a cheap op is mostly noise. Only the per-op *cost* gap is stable
    // and is what the mechanism predicts (22.7 ns vs 8.6 ns, and 10.6× on a later run).
    // This check therefore proves a cost claim at the largest swept size, NOT a growth claim
    // — the Θ(log n) extract-min class is carried clock-free by the Rust op-count proofs.
    if (hIns && hDel) {
      const gap = hDel.lastNanos / hIns.lastNanos;
      want(
        `heap extract-min costs more per op than insert (${gap.toFixed(1)}x > 1.3x)`,
        gap > 1.3,
      );
      want(
        `heap insert slope is reported with its uncertainty (stderr ${hIns.slopeStderr.toFixed(2)})`,
        Number.isFinite(hIns.slopeStderr),
      );
    }
  }

  // ── Second pass: the same page, driven onto **reverse-sorted** input ──
  //
  // The default run above is uniform, on which every tree looks balanced. Reverse-sorted
  // is the input that catches the churn-probe bug this gate exists to prevent
  // (docs/METHODOLOGY.md §4.1): it builds the naive BST into a *left* chain, whose right
  // spine is a single node. A one-keyed churn at `max + 1` measured that single node and
  // reported a flat **O(1)** mutation curve for a structure whose search on the same data
  // is **O(n)** — a wrong complexity class on the chart. Churn now alternates `min − 1`
  // and `max + 1`, so the chain gets walked whichever way it leans. Only the real clock
  // can confirm the *curve* the user sees; the op-count side is pinned in Rust
  // (`structures::methodology::bst_reverse_sorted_two_key_churn_recovers_the_linear_class`).
  await page.evaluate(() => {
    window.__bstMutationProof = undefined;
    window.__avlMutationProof = undefined;
    window.__heapMutationProof = undefined;
  });
  await page.locator('select').first().selectOption('reverse-sorted');
  await page.getByRole('button', { name: /run|sweep/i }).first().click();
  await page.waitForFunction(
    () =>
      window.__heapMutationProof !== undefined ||
      /status:\s*error/.test(document.body.innerText),
    { timeout: 150000 },
  );
  revBst = await page.evaluate(() => window.__bstMutationProof ?? null);
  revAvl = await page.evaluate(() => window.__avlMutationProof ?? null);
  revHeap = await page.evaluate(() => window.__heapMutationProof ?? null);
  const revMeta = await page.evaluate(() => window.__compareMeta ?? null);

  want('reverse-sorted run measured', revMeta && revMeta.order.kind === 'reverse-sorted');
  if (revBst) {
    const c = revBst.find((m) => m.op === 'churn');
    if (c) {
      // The anti-regression assert. A right-spine-only probe read slope ≈ 0 here.
      want(
        `reverse-sorted BST churn reads O(n) (slope ${c.slope.toFixed(2)} > 0.6)`,
        c.slope > 0.6,
      );
      want(
        `reverse-sorted BST churn rises with n (ratio ${(c.lastNanos / c.firstNanos).toFixed(1)} > 3)`,
        c.lastNanos / c.firstNanos > 3,
      );
    }
  }
  if (revAvl) {
    const c = revAvl.find((m) => m.op === 'churn');
    // The contrast on the *same* input: rotations keep both spines O(log n).
    if (c) {
      want(
        `reverse-sorted AVL churn stays sub-linear (slope ${c.slope.toFixed(2)} < 0.6)`,
        c.slope < 0.6,
      );
    }
  }

  // The heap on the same reverse-sorted input. Unlike the naive BST, a heap **cannot**
  // degenerate — it is a complete tree by construction, so its height is ⌊log₂ n⌋ whatever
  // order the keys arrive in. Churn must therefore stay sub-linear here exactly as it was
  // on the uniform pass. (Descending input *is* the heap's worst case for the cumulative
  // build — every insert climbs to the root — but that moves the finite-difference insert
  // series, not churn, which always rides the full height. Pinned clock-free in Rust by
  // `structures::methodology::heap_build_is_order_sensitive_but_churn_is_not`.)
  if (revHeap) {
    const c = revHeap.find((m) => m.op === 'churn');
    if (c) {
      want(
        `reverse-sorted heap churn stays sub-linear (slope ${c.slope.toFixed(2)} < 0.6)`,
        c.slope < 0.6,
      );
    }
  }

  ok = checks.length > 0 && checks.every((c) => c.pass);
} catch (err) {
  logs.push(`[harness] ${err.message}`);
}

await browser.close();

console.log('--- page text ---');
console.log(text.trim());
if (proof) {
  console.log('--- search proof ---');
  console.log(JSON.stringify(proof, null, 2));
}
if (mutation) {
  console.log('--- mutation proof ---');
  console.log(JSON.stringify(mutation, null, 2));
}
if (bst) {
  console.log('--- bst mutation proof ---');
  console.log(JSON.stringify(bst, null, 2));
}
if (avl) {
  console.log('--- avl mutation proof ---');
  console.log(JSON.stringify(avl, null, 2));
}
if (heap) {
  console.log('--- heap mutation proof ---');
  console.log(JSON.stringify(heap, null, 2));
}
if (revHeap) {
  console.log('--- heap mutation proof (reverse-sorted) ---');
  console.log(JSON.stringify(revHeap, null, 2));
}
if (revBst) {
  console.log('--- bst mutation proof (reverse-sorted) ---');
  console.log(JSON.stringify(revBst, null, 2));
}
if (revAvl) {
  console.log('--- avl mutation proof (reverse-sorted) ---');
  console.log(JSON.stringify(revAvl, null, 2));
}
if (meta) {
  console.log('--- compare meta ---');
  console.log(JSON.stringify(meta));
}
if (checks.length) {
  console.log('--- checks ---');
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
}
if (logs.length) {
  console.log('--- console / errors ---');
  console.log(logs.join('\n'));
}
console.log(ok ? 'BROWSER SWEEP: PASS' : 'BROWSER SWEEP: FAIL');
process.exit(ok ? 0 : 1);
