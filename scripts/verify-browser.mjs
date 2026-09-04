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
let revBst = null;
let revAvl = null;
let meta = null;
let text = '(no text captured)';
const checks = [];

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The sweeps run in a worker; wait until the AVL mutation proof publishes (it is set
  // last, after the search sweep — which now includes the sorted array — and the
  // array/hashset and BST mutation sweeps), or the app reports an error. Generous timeout
  // — the sweeps do real timed work.
  await page.waitForFunction(
    () =>
      window.__avlMutationProof !== undefined ||
      /status:\s*error/.test(document.body.innerText),
    { timeout: 60000 },
  );
  text = await page.evaluate(() => document.body.innerText);
  proof = await page.evaluate(() => window.__sweepProof ?? null);
  mutation = await page.evaluate(() => window.__mutationProof ?? null);
  bst = await page.evaluate(() => window.__bstMutationProof ?? null);
  avl = await page.evaluate(() => window.__avlMutationProof ?? null);
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

    want(
      'four search series measured',
      proof.length === 4 && array && ll && sarrSearch && hashset,
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

    want('six mutation series measured', mutation.length === 6);
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
  });
  await page.locator('select').first().selectOption('reverse-sorted');
  await page.getByRole('button', { name: /run|sweep/i }).first().click();
  await page.waitForFunction(
    () =>
      window.__avlMutationProof !== undefined ||
      /status:\s*error/.test(document.body.innerText),
    { timeout: 120000 },
  );
  revBst = await page.evaluate(() => window.__bstMutationProof ?? null);
  revAvl = await page.evaluate(() => window.__avlMutationProof ?? null);
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
