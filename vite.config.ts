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
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
