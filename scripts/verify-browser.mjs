// Phase 0 runtime proof: drive the built app in headless Chromium and confirm
// the main-thread -> Web Worker -> WASM -> Comlink round-trip actually resolves
// (build-green does not prove this — see docs/PLAN.md risk R5). Run against a
// `vite preview` server:  node scripts/verify-browser.mjs http://localhost:4317
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:4317';
const browser = await chromium.launch();
const page = await browser.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

let ok = false;
let text = '(no text captured)';
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Wait until the app reaches a terminal state: success ✓, ready, or error.
  await page.waitForFunction(
    () => {
      const t = document.body.innerText;
      return /ping\(41\)\s*→\s*42\s*✓/.test(t) || /status:\s*(ready|error)/.test(t);
    },
    { timeout: 15000 },
  );
  text = await page.evaluate(() => document.body.innerText);
  ok = /ping\(41\)\s*→\s*42\s*✓/.test(text);
} catch (err) {
  logs.push(`[harness] ${err.message}`);
}

await browser.close();

console.log('--- page text ---');
console.log(text.trim());
if (logs.length) {
  console.log('--- console / errors ---');
  console.log(logs.join('\n'));
}
console.log(ok ? 'BROWSER ROUND-TRIP: PASS' : 'BROWSER ROUND-TRIP: FAIL');
process.exit(ok ? 0 : 1);
