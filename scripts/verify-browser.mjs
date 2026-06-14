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
let text = '(no text captured)';
const checks = [];

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // The sweep runs in a worker; wait until it publishes its result, or the app
  // reports an error. Generous timeout — the sweep does real timed work.
  await page.waitForFunction(
    () => window.__sweepProof !== undefined || /status:\s*error/.test(document.body.innerText),
    { timeout: 60000 },
  );
  text = await page.evaluate(() => document.body.innerText);
  proof = await page.evaluate(() => window.__sweepProof ?? null);

  if (proof) {
    const array = proof.find((p) => p.structure === 'array');
    const hashset = proof.find((p) => p.structure === 'hashset');

    const want = (name, cond) => checks.push({ name, pass: !!cond });

    want('two series measured', proof.length === 2 && array && hashset);
    if (array) {
      const ratio = array.lastNanos / array.firstNanos;
      want('array labelled O(n)', array.best === 'O(n)');
      want('array slope ~1 (0.7..1.4)', array.slope >= 0.7 && array.slope <= 1.4);
      want(`array cost rises with n (ratio ${ratio.toFixed(1)} > 20)`, ratio > 20);
    }
    if (hashset) {
      const ratio = hashset.lastNanos / hashset.firstNanos;
      want('hashset labelled O(1)', hashset.best === 'O(1)');
      want('hashset slope ~0 (< 0.4)', hashset.slope < 0.4);
      want(`hashset cost stays flat (ratio ${ratio.toFixed(1)} < 10)`, ratio < 10);
    }
    ok = checks.length > 0 && checks.every((c) => c.pass);
  }
} catch (err) {
  logs.push(`[harness] ${err.message}`);
}

await browser.close();

console.log('--- page text ---');
console.log(text.trim());
if (proof) {
  console.log('--- sweep proof ---');
  console.log(JSON.stringify(proof, null, 2));
  console.log('--- checks ---');
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
}
if (logs.length) {
  console.log('--- console / errors ---');
  console.log(logs.join('\n'));
}
console.log(ok ? 'BROWSER SWEEP: PASS' : 'BROWSER SWEEP: FAIL');
process.exit(ok ? 0 : 1);
