import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The WASM bench engine is built with wasm-pack's `web` target and imported
// only inside the Web Worker (see src/bench/engine.worker.ts). The `web`
// target loads the .wasm via `new URL('…_bg.wasm', import.meta.url)`, which
// Vite handles natively for worker chunks — so no extra wasm plugin is needed,
// and crucially the worker has no top-level await (see that file for why).
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  // `verify:browser` hard-codes http://localhost:4173 (scripts/verify-browser.mjs,
  // .github/workflows/ci.yml). Without strictPort, a preview server whose port is
  // already taken falls forward to 4174, 4175, … and prints it — while the gate
  // still measures whatever is on 4173. That silently benchmarks *someone else's*
  // stale server instead of the build under test; a run of orphaned previews on a
  // dev box turned the gate flaky exactly this way. Fail loudly on a busy port.
  preview: {
    port: 4173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
