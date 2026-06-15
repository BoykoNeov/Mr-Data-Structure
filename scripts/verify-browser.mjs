// Phase 2 runtime proof (docs/PLAN.md §10, risk R2): drive the built app in
// headless Chromium and confirm the *real wall-clock* search sweep produces the
// headline result — array search rises (O(n)) while hash-set search stays flat
// (O(1)). build-green does not prove this; only the browser clock does (R2),
// which is why this lives here rather than in Vitest. Run against a `vite
// preview` server:  node scripts/verify-browser.mjs http://localhost:4317
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:4317';
const browser = await chromium.launch();
const page = await browser.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let ok = false;
let proof = null;
let mutation = null;
let bst = null;
let avl = null;
let text = '(no text captured)';
const checks = [];

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The sweeps run in a worker; wait until the AVL mutation proof publishes (it is
  // set last, after search + the array/hashset and BST mutation sweeps), or the app
  // reports an error. Generous timeout — the sweeps do real timed work.
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

  const want = (name, cond) => checks.push({ name, pass: !!cond });

  if (proof) {
    const array = proof.find((p) => p.structure === 'array');
    const hashset = proof.find((p) => p.structure === 'hashset');

    want('two search series measured', proof.length === 2 && array && hashset);
    if (array) {
      const ratio = array.lastNanos / array.firstNanos;
      want('array search labelled O(n)', array.best === 'O(n)');
      want('array search slope ~1 (0.7..1.4)', array.slope >= 0.7 && array.slope <= 1.4);
      want(`array search rises with n (ratio ${ratio.toFixed(1)} > 20)`, ratio > 20);
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
