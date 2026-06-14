# Mr Data Structure — project guide for Claude

Project-specific working notes. Setup, full command list, and repo layout live
in [`README.md`](README.md); the design and phased roadmap live in
[`docs/PLAN.md`](docs/PLAN.md). This file holds only what's specific to working
in this repo — things that aren't obvious from the README or that have tripped
up past sessions.

## Gates — run before committing or claiming "done"

```sh
npm run typecheck        # tsc --noEmit (strict; no unused locals/params)
npm test                 # Vitest unit tests
npm run verify           # everything CI runs (wasm + rust + typecheck + build + vitest)
npm run verify:browser   # headless-Chromium runtime check (needs preview server up)
```

`npm run build` only proves the bundle compiles. To prove the worker→WASM→Comlink
path resolves at *runtime*, start `npm run preview` and run `verify:browser`
**in the same shell invocation** — a background preview server started in one
tool call does not survive into the next (each call is a fresh process).

## Repo etiquette

- Commit **and push** each completed, gate-green work batch (standing user
  instruction). Commits land directly on `main`, matching this repo's
  phase-on-main history.
- Run typecheck + tests before every commit. CI also runs `npm run verify` on
  push as the backstop.
- Commit subjects follow the existing style: `Phase N: <slice>` for phase work,
  Conventional-Commits prefixes (`chore(ci):`, `fix:`) otherwise.
- Keep the living docs current: when a phase lands, update the **Status** block
  in `README.md` and `docs/PLAN.md` (§ top + §10) in the same batch.

## Conventions

- Strict TS throughout; prefer fixing types over `any` or casts.
- Tests are co-located as `*.test.ts` next to the module.
- JSDoc on public surfaces cites the relevant `docs/PLAN.md §` section.
- Import sibling modules without the `.ts` extension (e.g. `from './dataset'`).
- Add dependencies sparingly — the data layer and engine are intentionally
  dependency-free. Justify any new dep.

## Gotchas (learned the hard way)

- **Keys are identity.** Keep numeric detection conservative — a cell is numeric
  only when `String(Number(s)) === s.trim()`, so leading-zero codes (`02134`)
  and ids past 2^53 stay strings. **Preserve every key, including duplicates —
  never dedupe** (it would corrupt benchmark inputs).
- **Shell is PowerShell** on this Windows box; a Bash tool is also available for
  POSIX scripts. They take different syntax.
- `dist/` and `bench-engine/pkg/` are gitignored build artifacts (CI rebuilds
  them) — leave them untracked.

## Architecture map

- `bench-engine/` — Rust crate → WASM, the "production" benchmark impls.
- `src/bench/` — `BenchEngine` interface, Comlink Web Worker, WASM-backed engine.
- `src/data/` — Phase 1 data layer: import (CSV/JSON), conservative type
  detection, KV key-field picker, seeded generators, typed-array marshalling.
- `src/App.tsx` — phase demo / smoke screen.
