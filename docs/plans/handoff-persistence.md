# Handoff — local session persistence

Slice owner: parallel agent (worktree `agent-addc9a6e061d9a9e8`).
Scope: docs/PLAN.md §13 "Session persistence: local-only (IndexedDB) vs shareable URLs/exported
files?" — **decided by the user: local, in this browser; not shareable URLs.** Phase 6's
"persistence of sessions" line in §10.
This file holds the doc text the lead should merge; the living docs (README, PLAN, CLAUDE.md,
METHODOLOGY) were deliberately not edited.

---

## 1. What was built

New modules, all in `src/persist/`:

| file | what |
|---|---|
| `storage.ts` | two tiny adapters — `KvStore` (sync, `localStorage`-shaped) and `TextStore` (async, IndexedDB-shaped); real impls `browserKv()` / `indexedDbTextStore()` that **never throw and never reject**; memory impls (`memoryKv`, `memoryText` — the latter round-trips values through `structuredClone`, IndexedDB's own copy algorithm, and counts calls) and `unavailableKv()` for tests. No new dependency. |
| `session.ts` | the schema, its checks, and `createSession(kv, texts)`: `initial()` (sync), `firstRun()` (the mount-time auto-run's dataset + mix), `saveRun`, `saveView`, `exploreTab` / `saveExploreTab`, `clear`, `idle`. `browserSession()` is the page's singleton. |
| `useComparePersistence.ts` | Compare's hook, so `CompareSection` gains a handful of lines instead of a rewritten mount effect. |
| `SessionNote.tsx` | the one visible trace: what is remembered, whether this load was restored, and the **forget saved session** button. |
| `*.test.ts` | 46 tests (session 32, storage 9, note 5). |

Wiring (additive, small):
- `src/ui/CompareSection.tsx` — the four `useState` initializers (signal, overlay, spread, probe
  mix) read the saved values; `run()` takes an optional explicit mix; the mount effect runs
  `persisted.firstRun()` (started before the engine boots) instead of
  `buildDataset(DEFAULT_PICKER)`; one effect saves the view; `<SessionNote>` above the picker;
  `<DatasetPicker key initial onRun>` saves the run on every user-initiated run (form or preset).
  Three imports that became unused were removed (`DEFAULT_PICKER`, `buildDataset`,
  `DEFAULT_PROBE_MIX`).
- `src/viz/VizPanel.tsx` — `isExploreKind` exported (checks against `TABS` itself); the tab
  state initialises from the saved tab and saves on click.
- `scripts/verify-browser.mjs` — one additive first-pass assertion (UNRUN, §5).

### Scope — what is saved, where, and when

| what | where | saved when |
|---|---|---|
| the dataset panel **as last run** (source, generator kind, n, seed, key field, key length) + the probe mix that run used | `localStorage`, key `mrds:session:v1` | on every user-initiated run (form button or preset) |
| the pasted CSV / JSON text of that run | IndexedDB `mr-data-structure` / store `session` / key `paste-text` | same moment; verified on read by length + FNV-1a hash stored beside the settings |
| chart view: signal, theoretical overlay, rep spread | `localStorage` (same record) | on change, only if different from what is stored (or the defaults) |
| the selected Explore tab | `localStorage` (same record) | on tab click |
| **measured results** | **nothing** | never |

On reload, the mount-time auto-run **re-measures the restored last run** (fresh numbers, this
machine, this moment). With nothing stored it is exactly today's `buildDataset(DEFAULT_PICKER)`
at the default mix.

---

## 2. docs/PLAN.md

### §10 — new "Done" entry (append under Phase 6)

  - **Done (sessions are remembered — on this browser only, and never as results):** the §13
    question is settled *local only*: a reload brings back the dataset panel exactly as it was
    when the user last pressed run (or a preset) — **pasted CSV / JSON included** — with that
    run's probe mix, the chart view (signal, overlay, spread) and the selected Explore tab
    (`src/persist/`). Small settings sit under one versioned `localStorage` key; the paste text
    sits in IndexedDB, because a real paste can outgrow `localStorage`'s quota. The text is
    stored **raw** and re-parsed by the same deterministic importer, so keys come back exactly
    (CLAUDE.md "keys are identity") — pinned by a round-trip test over leading-zero codes,
    duplicates, ids past 2^53 that a `Number` would merge, an astral emoji, combining vs
    precomposed accents, CJK and CRLF; and it is checked on the way back by length + hash, so
    a reload never measures text other than the text that run saved. **Results are never
    saved:** the mount-time auto-run re-measures the restored configuration, so a saved
    timing would be on screen only for the seconds before being replaced — and would be the
    one number on the page not measured now, on this machine (§2.3, §6.2). The page says so
    when it restores ("measured fresh on this load"). With **empty storage the auto-run is
    byte-for-byte the default run** and IndexedDB is never opened — pinned in
    `session.test.ts` with counting fakes (zero writes, zero IndexedDB calls), and in the
    browser gate's first pass. Storage that is missing, blocked (including a SecurityError on
    the property access itself), full, slow (a 2 s cap on the one read the first run waits
    for) or corrupt degrades silently to today's behaviour; each section of the record is
    schema-checked on its own and a bad one is dropped, never trusted. A visible **forget
    saved session** button clears both stores, ordered after any save still in flight, and
    is never disabled mid-run — the way out if a saved run is the problem. **No new deps.**

### §13 — replace the "Session persistence" bullet with

- ~~Session persistence: local-only (IndexedDB) vs shareable URLs/exported files?~~
  **Decided: local only** (Phase 6, `src/persist/`). Settings in `localStorage`, the user's
  pasted data in IndexedDB, nothing uploaded, nothing in the URL. Measured results are
  deliberately not persisted — a reload re-measures. Shareable URLs remain out of scope; the
  existing CSV / JSON / PNG exports are the way to hand a result to someone else.

### §1 / top status table — Phase 6 row

Change "…its measured half … and its animation are still open, as are session persistence and
performance polish" so that session persistence is listed as done (leave the graph wording to
whoever lands the graph slices).

---

## 3. docs/METHODOLOGY.md — proof-map rows (suggested)

| claim | pinned by |
|---|---|
| empty storage ⇒ the default auto-run is unchanged (same dataset, same mix, no write, IndexedDB not opened) | `src/persist/session.test.ts` "empty storage ⇒ today's defaults"; gate first pass "session: a fresh context restored nothing" (UNRUN) |
| a restored paste measures the exact keys the original text built | `session.test.ts` "pasted data round-trips exactly" (+ hash-mismatch, missing-text, unbuildable-run cases) |
| nothing measured is persisted; a restored load says it re-measured | `session.ts` has no results field (by construction); `SessionNote.test.ts` wording |

No measurement claim or band changed, so no METHODOLOGY prose change is needed beyond the map.

---

## 4. CLAUDE.md — gotchas to add

- **A saved session changes what the mount-time auto-run measures — the gate only stays valid
  because its browser context starts empty.** With something in `localStorage` /
  IndexedDB, Compare's first run re-measures the *restored* last run, not
  `buildDataset(DEFAULT_PICKER)`. `scripts/verify-browser.mjs` navigates **once** in a fresh
  Playwright context, so its three passes write storage that is never read back. Anything that
  adds a `page.reload()` / second `goto` to the gate, or reuses a persistent profile
  (`launchPersistentContext`, a `--user-data-dir`), will auto-run whatever pass 2 or 3 saved
  (a reverse-sorted or string run) and silently measure the wrong thing. If a reload test is
  wanted, clear storage first or assert the restored configuration on purpose (§6 below).
  Same on a dev box: an odd first run after a reload is probably your own saved session —
  press *forget saved session*.
- **Persistence never saves results, and must not start to without a label.** The auto-run
  re-measures on load; a restored timing would be the one unmeasured number on the page.
- **Keep the paste stored raw.** Re-parsing the exact text is what makes the round-trip exact;
  storing parsed keys would need its own type-preserving encoding and would bypass the
  importer's conservative numeric detection on the way back.

## 5. README status suggestion

In the Phase 6 status line: "… session persistence (local only: your last run's dataset —
pasted data included — and settings come back on reload in this browser; results are always
re-measured) …".

---

## 6. UNRUN — said plainly

- **`npm run verify:browser` was not run** (task rule: shared machine, port 4173, timing gate).
  The new first-pass assertion `session: a fresh context restored nothing (the default
  auto-run ran)` checks the page text contains *"in this browser only"* and not *"Restored
  from this browser"*. It would also fail if the Playwright context had storage blocked (the
  note then says the browser is not saving) — not expected for a default `newPage()`.
- **The real `localStorage` / IndexedDB paths have never executed in a browser.** Vitest runs
  in node, so the real adapters are tested only on their failure modes (missing API,
  throwing property access, throwing methods, `open()` throwing / erroring / blocked). The
  happy path of `indexedDbTextStore` (open → upgrade → put/get/delete) is unexercised. A
  manual check: paste a CSV, run, reload — the textarea should hold the paste, the note
  should say *Restored*, and the charts should re-measure. A gate pass for it is sketched
  below but deliberately not wired (it re-navigates — see the gotcha above):

  ```js
  // AFTER every existing pass and all its reads — it re-navigates.
  await page.locator('input[type=radio]').nth(1).check(); // "paste CSV / JSON"
  await page.locator('textarea').fill('code\n02134\n007\n02134\n9007199254740993\n');
  await page.getByRole('button', { name: /run the sweeps/i }).first().click();
  await page.waitForFunction(() => window.__stringMutationProof !== undefined || /status:\s*error/.test(document.body.innerText));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Restored from this browser/.test(document.body.innerText));
  want('session: a reload restores the pasted text verbatim',
    (await page.locator('textarea').inputValue()) === 'code\n02134\n007\n02134\n9007199254740993\n');
  ```
  (A 4-key string dataset may be too small for the string sweep; use ~200 keys.)
- **The React wiring has no DOM test** (the repo has no DOM test environment). What is pinned
  is the pure core the wiring calls; the wiring itself is ~25 lines, reviewed by reading.

---

## 7. Judgement calls a reviewer might disagree with

1. **No results restored.** Optional per the brief. Declined because the auto-run replaces
   them within seconds anyway, and they would be the page's only unmeasured numbers. If wanted
   later, they belong behind an explicit "show my saved run" action with the label the brief
   specified, never on load.
2. **The auto-run fires on a restored configuration, including a restored paste.** The
   alternative (no auto-run when something custom is restored) leaves an empty page on
   reload, which is the opposite of "back where you were". The cost: a saved huge paste or
   very large n re-runs on every load — hence the forget button is never disabled.
3. **Save on run, not on every edit.** The saved state is "what you last ran", so the reload's
   auto-run never measures a configuration the user never ran. Consequence: form edits (and a
   probe-mix click) made *after* the last run are lost on reload, including a paste that was
   typed but never run. The probe mix is saved **with the run** for the same reason.
4. **The paste is stored as raw text, not parsed keys** — exact by construction, smaller, and
   the key-field choice re-applies. The row payloads (`values`) are rebuilt the same way.
5. **Corrupt record handling is per section.** A wrong `v` or invalid JSON drops everything; a
   bad `run` keeps `view` and `exploreTab`, and vice versa. A paste whose text is missing or
   fails the hash, or a run that no longer builds, is **removed** (it would fail every reload);
   a **slow** IndexedDB (2 s cap) only skips the restore for that load and keeps the save.
6. **The probe mix is validated against `PROBE_MIX_CHOICES`.** If the choices change, an old
   saved mix not in the new list drops the whole run section (defaults run) rather than
   restoring an un-offerable radio state.
7. **Forget clears storage, not the page.** The current form and charts stay; the note says
   the next run will be saved again. There is no "stop saving" switch.
8. **The picker remounts once when a saved paste arrives** (or when a saved run is dropped).
   The restore races the engine boot, so it normally lands before the user could type — but a
   keystroke into the form in that first instant would be overwritten. Not guarded.
9. **The preset highlight is not restored** — the form values are, the green "this preset"
   pill and blurb are not (they are UI state of the button that was clicked, not the dataset).
10. **The 32-bit FNV-1a hash** is a consistency check against torn/stale writes, not an
    integrity guarantee; it is paired with the exact length.
11. **`isExploreKind` lives in `VizPanel.tsx`** so the saved tab is validated against the real
    `TABS` list, not a copy that could drift.

## 8. Follow-ups

- Wire the reload pass (§6) into the gate once the graph Compare pass has landed, so the order
  of passes is settled first.
- **The graph Compare section's controls are not persisted.** It landed on `main` while this
  slice was in flight (`src/ui/GraphCompareSection.tsx`, merged at 36e43d5) with its own
  `GraphPickerState`; it does not auto-run on load, so nothing is measured differently either
  way. Persisting it is a small additive `run`-style section in `session.ts` plus two lines in
  that component — left to whoever owns it. It already inherits the saved signal / overlay /
  spread, which it receives as props from `CompareSection`.
- File upload (the picker only has a paste box today) would reuse the same text store as is.
- If `PickerState` grows fields (graph generator parameters), `parsePicker` spreads the saved
  values over `DEFAULT_PICKER`, so new fields restore as their defaults; validate them there
  if they should persist.
