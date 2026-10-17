import { DEFAULT_PROBE_MIX, PROBE_MIX_CHOICES } from '../bench/probeMix';
import type { Dataset } from '../data';
import { DEFAULT_PICKER, GENERATORS, buildDataset, type GeneratorKind, type PickerState } from '../ui/DatasetPicker';
import type { Signal } from '../ui/SweepChart';
import { browserKv, indexedDbTextStore, type KvStore, type TextStore } from './storage';

/**
 * Local session persistence (docs/PLAN.md §13, resolved **local only** — this browser,
 * nothing shareable, nothing uploaded). A reload brings the user back to:
 *
 * - **the last run** — the dataset panel exactly as it was when they pressed run (or a
 *   preset), including pasted CSV / JSON, and the probe mix that run used (§6.3). The
 *   page's mount-time auto-run then re-measures *that* configuration, fresh;
 * - **the chart view** — signal, theoretical overlay, rep spread;
 * - **the Explore tab** (§5).
 *
 * What is deliberately **not** saved: measured results. The auto-run re-measures the
 * restored configuration on every load, so saved timings would be on screen only for the
 * seconds before being replaced — and would be the one place the page showed numbers it had
 * not measured now, on this machine, in this moment (§2.3, §6.2 "results are relative").
 * Also not saved: form edits that were never run. Restoring them would make the reload's
 * auto-run measure a configuration the user never ran.
 *
 * Small settings live in `localStorage` under one versioned key; the paste text lives in
 * IndexedDB, checked on the way back by length + hash so a reload never runs on text other
 * than the text that run saved (CLAUDE.md "keys are identity": the raw text is stored and
 * re-parsed by the same deterministic importer, so every key — `02134`, duplicates, order,
 * ids past 2^53, any unicode — comes back exactly). Every read is schema-checked; anything
 * corrupt, unknown or from another schema version is dropped, never trusted, never a crash.
 */

/** The `localStorage` key. The version is in the key *and* the record, so a v2 can ignore or migrate v1. */
export const SESSION_KEY = 'mrds:session:v1';
export const SESSION_VERSION = 1;
/** The IndexedDB key the pasted text is stored under. */
export const PASTE_TEXT_KEY = 'paste-text';
/** How long the first load waits for IndexedDB before giving up and running the defaults. */
export const RESTORE_TIMEOUT_MS = 2000;

/** The Compare chart view settings. */
export interface SavedView {
  readonly signal: Signal;
  readonly showTheory: boolean;
  readonly showSpread: boolean;
}

/** Today's chart defaults — what `CompareSection` shows with nothing stored. */
export const DEFAULT_VIEW: SavedView = { signal: 'nanos', showTheory: true, showSpread: true };

/** The last run, minus the paste text (that is in IndexedDB, identified by length + hash). */
export interface SavedRun {
  readonly picker: Omit<PickerState, 'text'>;
  readonly textLength: number;
  readonly textHash: string;
  readonly presentFraction: number;
  /** ISO timestamp of the run that was saved. */
  readonly savedAt: string;
}

export interface SavedSettings {
  readonly v: typeof SESSION_VERSION;
  readonly run?: SavedRun;
  readonly view?: SavedView;
  /** Validated by the caller against the real tab list (`isExploreKind`). */
  readonly exploreTab?: string;
}

/** What the first render can know synchronously. */
export interface InitialSession {
  /** The restored dataset panel; its `text` is `''` until {@link Session.firstRun} resolves. */
  readonly picker: PickerState;
  readonly presentFraction: number;
  readonly view: SavedView;
  readonly savedRun: SavedRun | null;
  /** Whether `localStorage` could be reached at all. */
  readonly storageAvailable: boolean;
}

/** The mount-time auto-run's configuration. */
export interface FirstRun {
  readonly dataset: Dataset;
  readonly picker: PickerState;
  readonly presentFraction: number;
  /** When the restored run was saved, or `null` when this is the default run. */
  readonly restoredFrom: string | null;
}

export interface Session {
  initial(): InitialSession;
  /** Never rejects: any failure on the way resolves to today's default run. */
  firstRun(initial: InitialSession): Promise<FirstRun>;
  saveRun(state: PickerState, presentFraction: number, now?: Date): void;
  /** Writes only when the view differs from what is stored (or from the defaults). */
  saveView(view: SavedView): void;
  exploreTab<T extends string>(isValid: (tab: string) => tab is T): T | undefined;
  saveExploreTab(tab: string): void;
  /** Forget everything saved; ordered after any in-flight save. */
  clear(): Promise<void>;
  /** Resolves once every queued IndexedDB write has settled (for tests). */
  idle(): Promise<void>;
}

// ---------------------------------------------------------------------------------------
// Schema checks — pure, so every corrupt shape is a unit test
// ---------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isKind = (x: unknown): x is GeneratorKind => GENERATORS.some((g) => g.kind === x);
const isSignal = (x: unknown): x is Signal => x === 'nanos' || x === 'opcount';

function parsePicker(x: unknown): Omit<PickerState, 'text'> | null {
  if (!isObj(x)) return null;
  const { source, kind, n, seed, keyField, minLen, maxLen } = x;
  if (source !== 'generate' && source !== 'paste') return null;
  if (!isKind(kind) || !isNum(n) || !isNum(seed) || !isNum(minLen) || !isNum(maxLen)) return null;
  if (typeof keyField !== 'string') return null;
  // Spread over the defaults so a field added to PickerState later restores as its default.
  const { text: _text, ...defaults } = DEFAULT_PICKER;
  return { ...defaults, source, kind, n, seed, keyField, minLen, maxLen };
}

function parseRun(x: unknown): SavedRun | null {
  if (!isObj(x)) return null;
  const picker = parsePicker(x.picker);
  const { textLength, textHash: hash, presentFraction, savedAt } = x;
  if (!picker) return null;
  if (!isNum(textLength) || textLength < 0 || !Number.isInteger(textLength)) return null;
  if (typeof hash !== 'string' || !/^[0-9a-f]{8}$/.test(hash)) return null;
  if (!isNum(presentFraction) || !PROBE_MIX_CHOICES.includes(presentFraction)) return null;
  if (typeof savedAt !== 'string' || Number.isNaN(Date.parse(savedAt))) return null;
  return { picker, textLength, textHash: hash, presentFraction, savedAt };
}

function parseView(x: unknown): SavedView | null {
  if (!isObj(x)) return null;
  const { signal, showTheory, showSpread } = x;
  if (!isSignal(signal) || typeof showTheory !== 'boolean' || typeof showSpread !== 'boolean') return null;
  return { signal, showTheory, showSpread };
}

/**
 * Parse a stored record. Invalid JSON or a different `v` drops everything; within a valid
 * record each section is checked on its own, so one bad section does not cost the others.
 */
export function parseSettings(raw: string | null): SavedSettings | null {
  if (raw === null) return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(x) || x.v !== SESSION_VERSION) return null;
  const run = parseRun(x.run);
  const view = parseView(x.view);
  const tab = typeof x.exploreTab === 'string' ? x.exploreTab : undefined;
  return {
    v: SESSION_VERSION,
    ...(run ? { run } : {}),
    ...(view ? { view } : {}),
    ...(tab !== undefined ? { exploreTab: tab } : {}),
  };
}

/** FNV-1a (32-bit) over UTF-16 code units — a consistency check on the stored text, not security. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** `p`, or `fallback` if it has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

const sameView = (a: SavedView, b: SavedView) =>
  a.signal === b.signal && a.showTheory === b.showTheory && a.showSpread === b.showSpread;

// ---------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------

export function createSession(
  kv: KvStore,
  texts: TextStore,
  options: { readonly timeoutMs?: number } = {},
): Session {
  const timeoutMs = options.timeoutMs ?? RESTORE_TIMEOUT_MS;
  const read = (): SavedSettings | null => {
    try {
      return parseSettings(kv.get(SESSION_KEY));
    } catch {
      return null;
    }
  };
  const write = (s: SavedSettings) => {
    try {
      kv.set(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* degrade silently */
    }
  };
  const base = (): SavedSettings => read() ?? { v: SESSION_VERSION };
  /** Drop the saved run (it could not be reproduced) but keep the view and the tab. */
  const dropRun = () => {
    const current = read();
    if (!current?.run) return;
    const { run: _run, ...rest } = current;
    write(rest);
  };

  // Every IndexedDB write goes through one queue, so a "forget" lands after a save that was
  // already in flight instead of being overtaken by it. Real stores never reject; the catch
  // is a backstop so one failure cannot wedge the queue.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): Promise<void> => {
    queue = queue.then(op).catch(() => {});
    return queue;
  };
  // Whether IndexedDB may hold text. Starts from what the record says, so a session that never
  // pasted anything never opens the database — on load *or* on a run.
  let textMayExist = (read()?.run?.textLength ?? 0) > 0;

  const defaultRun = (): FirstRun => ({
    dataset: buildDataset(DEFAULT_PICKER),
    picker: DEFAULT_PICKER,
    presentFraction: DEFAULT_PROBE_MIX.presentFraction,
    restoredFrom: null,
  });

  return {
    initial() {
      const saved = read();
      const run = saved?.run ?? null;
      let storageAvailable = false;
      try {
        storageAvailable = kv.available();
      } catch {
        storageAvailable = false;
      }
      return {
        picker: run ? { ...run.picker, text: '' } : DEFAULT_PICKER,
        presentFraction: run ? run.presentFraction : DEFAULT_PROBE_MIX.presentFraction,
        view: saved?.view ?? DEFAULT_VIEW,
        savedRun: run,
        storageAvailable,
      };
    },

    async firstRun(initial) {
      try {
        const run = initial.savedRun;
        if (!run) return defaultRun();
        let picker = initial.picker;
        if (run.textLength > 0) {
          const timedOut = Symbol('timeout');
          const text = await withTimeout<string | undefined | typeof timedOut>(
            texts.get(PASTE_TEXT_KEY),
            timeoutMs,
            timedOut,
          );
          // A slow database is not a corrupt one: run the defaults this time, keep the save.
          if (text === timedOut) return defaultRun();
          if (text !== undefined && text.length === run.textLength && textHash(text) === run.textHash) {
            picker = { ...initial.picker, text };
          } else if (picker.source === 'paste') {
            // The text this run was measured on is gone or is not the same text: never run
            // the paste on different keys than the ones that were saved.
            dropRun();
            void enqueue(() => texts.delete(PASTE_TEXT_KEY));
            return defaultRun();
          }
          // A generator run whose leftover paste draft was lost still restores — minus the draft.
        }
        try {
          return { dataset: buildDataset(picker), picker, presentFraction: run.presentFraction, restoredFrom: run.savedAt };
        } catch {
          dropRun(); // it would fail the same way on every reload
          return defaultRun();
        }
      } catch {
        return defaultRun();
      }
    },

    saveRun(state, presentFraction, now = new Date()) {
      const { text, ...picker } = state;
      const run: SavedRun = {
        picker,
        textLength: text.length,
        textHash: textHash(text),
        presentFraction,
        savedAt: now.toISOString(),
      };
      write({ ...base(), run });
      if (text.length > 0) {
        textMayExist = true;
        void enqueue(() => texts.put(PASTE_TEXT_KEY, text));
      } else if (textMayExist) {
        textMayExist = false;
        void enqueue(() => texts.delete(PASTE_TEXT_KEY));
      }
    },

    saveView(view) {
      const current = read();
      if (sameView(view, current?.view ?? DEFAULT_VIEW)) return;
      write({ ...(current ?? { v: SESSION_VERSION }), view });
    },

    exploreTab(isValid) {
      const tab = read()?.exploreTab;
      return tab !== undefined && isValid(tab) ? tab : undefined;
    },

    saveExploreTab(tab) {
      const current = read();
      if (current?.exploreTab === tab) return;
      write({ ...(current ?? { v: SESSION_VERSION }), exploreTab: tab });
    },

    clear() {
      try {
        kv.remove(SESSION_KEY);
      } catch {
        /* blocked */
      }
      textMayExist = false;
      return enqueue(() => texts.delete(PASTE_TEXT_KEY));
    },

    idle() {
      return queue;
    },
  };
}

let shared: Session | null = null;

/** The page's one session, on the real `localStorage` + IndexedDB. Created on first use. */
export function browserSession(): Session {
  shared ??= createSession(browserKv(), indexedDbTextStore());
  return shared;
}
