import { describe, it, expect } from 'vitest';
import { DEFAULT_PROBE_MIX } from '../bench/probeMix';
import { DEFAULT_PICKER, buildDataset, type PickerState } from '../ui/DatasetPicker';
import { DEFAULT_GRAPH_PICKER, type GraphPickerState } from '../ui/graphPicker';
import { isExploreKind } from '../viz/VizPanel';
import {
  DEFAULT_VIEW,
  GRAPH_TEXT_KEY,
  PASTE_TEXT_KEY,
  SESSION_KEY,
  SESSION_VERSION,
  createSession,
  parseSettings,
  textHash,
} from './session';
import { memoryKv, memoryText, unavailableKv, type TextStore } from './storage';

/** A store where every operation rejects — the backstop for "storage is broken". */
const throwingText = (): TextStore => ({
  get: () => Promise.reject(new Error('boom')),
  put: () => Promise.reject(new Error('boom')),
  delete: () => Promise.reject(new Error('boom')),
});

/** Simulate a reload: a fresh session over the same two stores. */
const reload = (kv = memoryKv(), text = memoryText()) => ({ kv, text, session: createSession(kv, text) });

// A paste chosen to break every naive round-trip at once (CLAUDE.md "keys are identity"):
// leading-zero codes, duplicates (twice over, non-adjacent), ids past 2^53 that a Number would
// collapse onto each other, an astral-plane emoji, a combining accent vs its precomposed twin,
// CJK, and CRLF line endings.
const NASTY_CSV =
  'code,name\r\n' +
  '02134,boston\r\n' +
  '007,bond\r\n' +
  '02134,boston again\r\n' +
  '9007199254740993,big\r\n' +
  '9007199254740992,big neighbour\r\n' +
  '😀,emoji\r\n' +
  'é,combining\r\n' +
  'é,precomposed\r\n' +
  '東京,tokyo\r\n' +
  '007,bond twice\r\n';

const pastePicker = (text: string, keyField = 'code'): PickerState => ({
  ...DEFAULT_PICKER,
  source: 'paste',
  text,
  keyField,
});

describe('empty storage ⇒ today’s defaults, byte for byte', () => {
  it('reads as the defaults, builds the default dataset, and touches nothing', async () => {
    const kv = memoryKv();
    const text = memoryText();
    const session = createSession(kv, text);
    const initial = session.initial();

    expect(initial.picker).toBe(DEFAULT_PICKER); // same object: the picker never remounts
    expect(initial.presentFraction).toBe(DEFAULT_PROBE_MIX.presentFraction);
    // CompareSection's pre-persistence literals, and the input-n axis it always started on.
    expect(initial.view).toEqual({ signal: 'nanos', showTheory: true, showSpread: true, nAxis: 'input' });
    expect(initial.savedRun).toBeNull();

    const first = await session.firstRun(initial);
    // What the mount effect ran before persistence existed: buildDataset(DEFAULT_PICKER) at
    // { presentFraction: DEFAULT_PROBE_MIX.presentFraction } — the browser gate's first pass.
    expect(first.dataset).toEqual(buildDataset(DEFAULT_PICKER));
    expect(first.presentFraction).toBe(DEFAULT_PROBE_MIX.presentFraction);
    expect(first.picker).toBe(DEFAULT_PICKER);
    expect(first.restoredFrom).toBeNull();

    // What the page does on mount besides: the view effect fires with the defaults, and the
    // Explore panel asks for its tab.
    session.saveView(DEFAULT_VIEW);
    expect(session.exploreTab(isExploreKind) ?? 'array').toBe('array');
    await session.idle();

    expect(kv.writes).toBe(0); // no write on load
    expect(text.calls).toBe(0); // IndexedDB is never even opened
  });

  it('is the same when storage is blocked or broken', async () => {
    for (const session of [createSession(unavailableKv(), memoryText()), createSession(unavailableKv(), throwingText())]) {
      const initial = session.initial();
      expect(initial.storageAvailable).toBe(false);
      expect(initial.picker).toBe(DEFAULT_PICKER);
      const first = await session.firstRun(initial);
      expect(first.dataset).toEqual(buildDataset(DEFAULT_PICKER));
      expect(first.presentFraction).toBe(DEFAULT_PROBE_MIX.presentFraction);
      // Writes go nowhere and never throw.
      session.saveRun(pastePicker(NASTY_CSV), 0.25);
      session.saveView({ ...DEFAULT_VIEW, signal: 'opcount' });
      session.saveExploreTab('trie');
      await session.clear();
      await session.idle();
    }
  });

  it('survives a KvStore whose every method throws', async () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    const session = createSession({ available: boom, get: boom, set: boom, remove: boom }, throwingText());
    const initial = session.initial();
    expect(initial.storageAvailable).toBe(false);
    expect((await session.firstRun(initial)).dataset).toEqual(buildDataset(DEFAULT_PICKER));
    session.saveRun(pastePicker(NASTY_CSV), 0.5);
    session.saveView({ ...DEFAULT_VIEW, showSpread: false });
    session.saveExploreTab('graph');
    expect(session.exploreTab(isExploreKind)).toBeUndefined();
    await session.clear();
  });
});

describe('pasted data round-trips exactly', () => {
  it('restores the very keys the original text built — strings stay strings, duplicates and order kept', async () => {
    const original = buildDataset(pastePicker(NASTY_CSV));
    expect(original.keyType).toBe('string');

    const first = reload();
    first.session.saveRun(pastePicker(NASTY_CSV), 0.75, new Date('2026-10-17T12:00:00Z'));
    await first.session.idle();

    const { session } = reload(first.kv, first.text);
    const initial = session.initial();
    expect(initial.picker.text).toBe(''); // the text is not in localStorage…
    expect(first.kv.get(SESSION_KEY)).not.toContain('02134');
    const restored = await session.firstRun(initial);

    expect(restored.picker.text).toBe(NASTY_CSV); // …it comes back from the text store, verbatim
    expect(restored.dataset).toEqual(original);
    expect(restored.dataset.keys).toEqual([
      '02134', '007', '02134', '9007199254740993', '9007199254740992',
      '😀', 'é', 'é', '東京', '007',
    ]);
    expect(restored.presentFraction).toBe(0.75);
    expect(restored.restoredFrom).toBe('2026-10-17T12:00:00.000Z');
    expect(restored.picker).not.toBe(initial.picker); // ⇒ the picker remounts with the text
  });

  it('keeps a numeric paste numeric, with its duplicates, and a JSON paste as JSON', async () => {
    for (const p of [
      pastePicker('n\n5\n3\n5\n-0.5\n3\n', ''),
      pastePicker('[{"id": "02134"}, {"id": "02134"}, {"id": "x"}]', 'id'),
    ]) {
      const a = reload();
      a.session.saveRun(p, 0.5);
      await a.session.idle();
      const b = reload(a.kv, a.text);
      const restored = await b.session.firstRun(b.session.initial());
      expect(restored.dataset).toEqual(buildDataset(p));
      expect(restored.picker).toEqual(p);
    }
    const a = reload();
    // A single-column paste: the first line is its header (the CSV importer's rule, not ours).
    a.session.saveRun(pastePicker('n\n5\n3\n5\n-0.5\n3\n', ''), 0.5);
    await a.session.idle();
    const b = reload(a.kv, a.text);
    const numeric = (await b.session.firstRun(b.session.initial())).dataset;
    expect(numeric.keyType).toBe('number');
    expect(numeric.keys).toEqual([5, 3, 5, -0.5, 3]);
  });

  it('never runs on text other than the text that was saved', async () => {
    const a = reload();
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    a.session.saveView({ ...DEFAULT_VIEW, signal: 'opcount' });
    await a.session.idle();
    // Same length, one key changed — a stale or torn write the length alone would miss.
    a.text.data.set(PASTE_TEXT_KEY, NASTY_CSV.replace('02134', '02135'));
    expect(a.text.data.get(PASTE_TEXT_KEY)?.length).toBe(NASTY_CSV.length);

    const b = reload(a.kv, a.text);
    const initial = b.session.initial();
    const first = await b.session.firstRun(initial);
    expect(first.dataset).toEqual(buildDataset(DEFAULT_PICKER));
    expect(first.restoredFrom).toBeNull();
    expect(first.picker).toBe(DEFAULT_PICKER); // the panel remounts on the defaults
    await b.session.idle();
    // The unusable run is dropped; the unrelated view setting survives.
    const left = parseSettings(a.kv.get(SESSION_KEY));
    expect(left?.run).toBeUndefined();
    expect(left?.view?.signal).toBe('opcount');
    expect(a.text.data.has(PASTE_TEXT_KEY)).toBe(false);
  });

  it('falls back to the defaults when the text is missing', async () => {
    const a = reload();
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    await a.session.idle();
    a.text.data.clear();
    const b = reload(a.kv, a.text);
    expect((await b.session.firstRun(b.session.initial())).dataset).toEqual(buildDataset(DEFAULT_PICKER));
  });

  it('a generator run whose leftover paste draft was lost still restores, minus the draft', async () => {
    const state: PickerState = { ...DEFAULT_PICKER, kind: 'sorted', n: 2000, text: 'a leftover draft' };
    const a = reload();
    a.session.saveRun(state, 0.5);
    await a.session.idle();
    a.text.data.clear();
    const b = reload(a.kv, a.text);
    const first = await b.session.firstRun(b.session.initial());
    expect(first.dataset).toEqual(buildDataset(state));
    expect(first.picker).toEqual({ ...state, text: '' });
  });

  it('a slow database runs the defaults this time without destroying the save', async () => {
    const a = reload();
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    await a.session.idle();
    const hanging: TextStore = { ...a.text, get: () => new Promise<string | undefined>(() => {}) };
    const slow = createSession(a.kv, hanging, { timeoutMs: 10 });
    const first = await slow.firstRun(slow.initial());
    expect(first.dataset).toEqual(buildDataset(DEFAULT_PICKER));
    expect(parseSettings(a.kv.get(SESSION_KEY))?.run).toBeDefined();
    expect(a.text.data.get(PASTE_TEXT_KEY)).toBe(NASTY_CSV);
  });

  it('a saved run that no longer builds is dropped instead of failing every reload', async () => {
    const a = reload();
    a.session.saveRun(pastePicker('a,b\n1,2\n', ''), 0.5); // multi-column with no key field: throws
    await a.session.idle();
    const b = reload(a.kv, a.text);
    const first = await b.session.firstRun(b.session.initial());
    expect(first.dataset).toEqual(buildDataset(DEFAULT_PICKER));
    expect(parseSettings(a.kv.get(SESSION_KEY))?.run).toBeUndefined();
  });
});

describe('generator runs, view, and tab', () => {
  it('restores a generator run synchronously, never touching the text store', async () => {
    const state: PickerState = { ...DEFAULT_PICKER, kind: 'string-corpus', n: 5000, seed: 11, minLen: 30, maxLen: 40 };
    const a = reload();
    a.session.saveRun(state, 0.25);
    await a.session.idle();
    expect(a.text.calls).toBe(0);

    const b = reload(a.kv, a.text);
    const initial = b.session.initial();
    expect(initial.picker).toEqual(state); // known before anything async
    expect(initial.presentFraction).toBe(0.25);
    const first = await b.session.firstRun(initial);
    expect(first.picker).toBe(initial.picker); // no remount
    expect(first.dataset).toEqual(buildDataset(state));
    expect(first.presentFraction).toBe(0.25);
    expect(a.text.calls).toBe(0);
  });

  it('saves the view only when it changes, and keeps it across a later run save', () => {
    const a = reload();
    a.session.saveView(DEFAULT_VIEW);
    expect(a.kv.writes).toBe(0);
    a.session.saveView({ signal: 'opcount', showTheory: false, showSpread: true, nAxis: 'input' });
    expect(a.kv.writes).toBe(1);
    a.session.saveView({ signal: 'opcount', showTheory: false, showSpread: true, nAxis: 'input' });
    expect(a.kv.writes).toBe(1);
    a.session.saveView({ signal: 'opcount', showTheory: false, showSpread: true, nAxis: 'stored' });
    expect(a.kv.writes).toBe(2); // the axis alone is a change
    a.session.saveRun({ ...DEFAULT_PICKER, kind: 'zipfian' }, 0.5);
    a.session.saveExploreTab('skiplist');
    const b = reload(a.kv, a.text);
    const initial = b.session.initial();
    expect(initial.view).toEqual({ signal: 'opcount', showTheory: false, showSpread: true, nAxis: 'stored' });
    expect(initial.picker.kind).toBe('zipfian');
    expect(b.session.exploreTab(isExploreKind)).toBe('skiplist');
  });

  it('checks the saved tab against the real tab list', () => {
    expect(isExploreKind('graph')).toBe(true);
    expect(isExploreKind('trie')).toBe(true);
    expect(isExploreKind('Array')).toBe(false);
    const kv = memoryKv({ [SESSION_KEY]: JSON.stringify({ v: SESSION_VERSION, exploreTab: 'red-black' }) });
    expect(createSession(kv, memoryText()).exploreTab(isExploreKind)).toBeUndefined();
  });
});

describe('corrupt or foreign records are dropped, never trusted, never a crash', () => {
  const goodRun = {
    picker: { source: 'generate', kind: 'sorted', n: 1000, seed: 7, keyField: '', minLen: 3, maxLen: 8 },
    textLength: 0,
    textHash: textHash(''),
    presentFraction: 0.5,
    savedAt: '2026-10-17T12:00:00.000Z',
  };
  const goodView = { signal: 'opcount', showTheory: false, showSpread: false };

  it('accepts a good record (the control for every case below)', () => {
    const s = parseSettings(JSON.stringify({ v: 1, run: goodRun, view: goodView, exploreTab: 'avl' }));
    expect(s?.run?.picker.kind).toBe('sorted');
    expect(s?.view?.signal).toBe('opcount');
    expect(s?.exploreTab).toBe('avl');
  });

  it.each([
    ['not JSON', '{"v":1,'],
    ['JSON null', 'null'],
    ['an array', '[1]'],
    ['no version', JSON.stringify({ run: goodRun })],
    ['a newer version', JSON.stringify({ v: 2, run: goodRun })],
    ['a version as a string', JSON.stringify({ v: '1', run: goodRun })],
  ])('drops everything for %s', async (_name, raw) => {
    expect(parseSettings(raw)?.run).toBeUndefined();
    const session = createSession(memoryKv({ [SESSION_KEY]: raw }), memoryText());
    const initial = session.initial();
    expect(initial.picker).toBe(DEFAULT_PICKER);
    expect((await session.firstRun(initial)).dataset).toEqual(buildDataset(DEFAULT_PICKER));
  });

  it.each([
    ['n stored as null (how NaN survives JSON)', { picker: { ...goodRun.picker, n: null } }],
    ['an unknown generator kind', { picker: { ...goodRun.picker, kind: 'pareto' } }],
    ['an unknown source', { picker: { ...goodRun.picker, source: 'upload' } }],
    ['a missing key field', { picker: { ...goodRun.picker, keyField: undefined } }],
    ['a probe mix the UI does not offer', { presentFraction: 0.3 }],
    ['a malformed text hash', { textHash: 'xyz' }],
    ['a negative text length', { textLength: -1 }],
    ['an unparseable date', { savedAt: 'yesterday' }],
  ])('drops only the run section for %s', async (_name, patch) => {
    const raw = JSON.stringify({ v: 1, run: { ...goodRun, ...patch }, view: goodView });
    const s = parseSettings(raw);
    expect(s?.run).toBeUndefined();
    expect(s?.view).toEqual({ ...goodView, nAxis: 'input' }); // the other section is kept
    const session = createSession(memoryKv({ [SESSION_KEY]: raw }), memoryText());
    const initial = session.initial();
    expect(initial.view).toEqual({ ...goodView, nAxis: 'input' });
    expect((await session.firstRun(initial)).dataset).toEqual(buildDataset(DEFAULT_PICKER));
  });

  it('drops only the view section for a bad view', () => {
    const s = parseSettings(JSON.stringify({ v: 1, run: goodRun, view: { ...goodView, signal: 'cycles' } }));
    expect(s?.view).toBeUndefined();
    expect(s?.run?.picker.kind).toBe('sorted');
    expect(parseSettings(JSON.stringify({ v: 1, view: { ...goodView, nAxis: 'output' } }))?.view).toBeUndefined();
  });

  it('reads a view saved before the axis was remembered as the input axis, not as invalid', () => {
    // goodView has no nAxis: the shape every v1 record written before this field has.
    expect(parseSettings(JSON.stringify({ v: 1, view: goodView }))?.view).toEqual({ ...goodView, nAxis: 'input' });
    expect(parseSettings(JSON.stringify({ v: 1, view: { ...goodView, nAxis: 'stored' } }))?.view?.nAxis).toBe('stored');
  });

  const goodGraph = {
    picker: { family: 'random', degree: 8, seed: 3, delimiter: 'tab', header: true, comments: false },
    textLength: 0,
    textHash: textHash(''),
    savedAt: '2026-10-18T12:00:00.000Z',
  };

  it.each([
    ['an unknown family', { picker: { ...goodGraph.picker, family: 'tree' } }],
    ['a degree above the picker cap', { picker: { ...goodGraph.picker, degree: 65 } }],
    ['a negative degree', { picker: { ...goodGraph.picker, degree: -1 } }],
    ['a seed stored as null', { picker: { ...goodGraph.picker, seed: null } }],
    ['an unknown separator', { picker: { ...goodGraph.picker, delimiter: 'semicolon' } }],
    ['a header flag as a string', { picker: { ...goodGraph.picker, header: 'yes' } }],
    ['a malformed text hash', { textHash: 'nothex!!' }],
  ])('drops only the graph section for %s', (_name, patch) => {
    expect(parseSettings(JSON.stringify({ v: 1, graph: goodGraph, view: goodView }))?.graph?.picker.degree).toBe(8);
    const s = parseSettings(JSON.stringify({ v: 1, graph: { ...goodGraph, ...patch }, view: goodView }));
    expect(s?.graph).toBeUndefined();
    expect(s?.view?.signal).toBe('opcount');
  });
});

describe('the graph section’s picker', () => {
  const EDGES = Array.from({ length: 30 }, (_, i) => `02134-${i},n${i + 1}`).join('\r\n') + '\r\n😀,東京\r\n';
  const edgePicker: GraphPickerState = { ...DEFAULT_GRAPH_PICKER, family: 'edge-list', text: EDGES, delimiter: 'comma' };

  it('is the default with nothing stored, and asking never opens the database', async () => {
    const a = reload();
    expect(a.session.graphInitial()).toBe(DEFAULT_GRAPH_PICKER);
    expect(await a.session.graphPicker()).toBe(DEFAULT_GRAPH_PICKER);
    expect(a.text.calls).toBe(0);
    expect(a.kv.writes).toBe(0);
  });

  it('restores a synthetic picker synchronously, never touching the text store', async () => {
    const a = reload();
    const state: GraphPickerState = { ...DEFAULT_GRAPH_PICKER, family: 'random', degree: 16, seed: 9 };
    a.session.saveGraph(state);
    await a.session.idle();
    const b = reload(a.kv, a.text);
    expect(b.session.graphInitial()).toEqual(state);
    expect(await b.session.graphPicker()).toEqual(state);
    expect(a.text.calls).toBe(0);
  });

  it('round-trips a pasted edge list exactly, under its own key', async () => {
    const a = reload();
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    a.session.saveGraph(edgePicker);
    await a.session.idle();
    expect(a.text.data.get(GRAPH_TEXT_KEY)).toBe(EDGES);
    expect(a.text.data.get(PASTE_TEXT_KEY)).toBe(NASTY_CSV); // neither paste overwrote the other
    const b = reload(a.kv, a.text);
    expect(b.session.graphInitial()).toEqual({ ...edgePicker, text: '' });
    expect(await b.session.graphPicker()).toEqual(edgePicker);
  });

  it('never refills the form with an edge list other than the one saved', async () => {
    const a = reload();
    a.session.saveGraph(edgePicker);
    await a.session.idle();
    a.text.data.set(GRAPH_TEXT_KEY, EDGES.replace('n1', 'n7'));
    const b = reload(a.kv, a.text);
    expect(await b.session.graphPicker()).toBe(DEFAULT_GRAPH_PICKER);
    await b.session.idle();
    expect(parseSettings(a.kv.get(SESSION_KEY))?.graph).toBeUndefined();
    expect(a.text.data.has(GRAPH_TEXT_KEY)).toBe(false);
  });

  it('a slow database refills the form without its text, and keeps the save', async () => {
    const a = reload();
    a.session.saveGraph(edgePicker);
    await a.session.idle();
    const slow: TextStore = { ...a.text, get: () => new Promise(() => {}) };
    const b = createSession(a.kv, slow, { timeoutMs: 5 });
    expect(await b.graphPicker()).toEqual({ ...edgePicker, text: '' });
    expect(parseSettings(a.kv.get(SESSION_KEY))?.graph?.picker.family).toBe('edge-list');
  });

  it('survives every other save — each one rewrites the record from its parse', async () => {
    const a = reload();
    a.session.saveGraph(edgePicker);
    a.session.saveRun({ ...DEFAULT_PICKER, kind: 'zipfian' }, 0.5);
    a.session.saveView({ ...DEFAULT_VIEW, signal: 'opcount' });
    a.session.saveExploreTab('graph');
    await a.session.idle();
    const b = reload(a.kv, a.text);
    expect(await b.session.graphPicker()).toEqual(edgePicker);
    // And the key run's dropped section (a paste whose text is gone) leaves it alone too.
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    await a.session.idle();
    a.text.data.delete(PASTE_TEXT_KEY);
    const c = reload(a.kv, a.text);
    await c.session.firstRun(c.session.initial());
    expect(parseSettings(a.kv.get(SESSION_KEY))?.run).toBeUndefined();
    expect(await c.session.graphPicker()).toEqual(edgePicker);
  });

  it('switching from an edge list to a generated graph deletes the stored edge list', async () => {
    const a = reload();
    a.session.saveGraph(edgePicker);
    a.session.saveGraph({ ...DEFAULT_GRAPH_PICKER, family: 'grid' });
    await a.session.idle();
    expect(a.text.data.has(GRAPH_TEXT_KEY)).toBe(false);
  });

  it('is forgotten with the rest of the session', async () => {
    const a = reload();
    a.session.saveGraph(edgePicker);
    await a.session.clear();
    expect(a.text.data.has(GRAPH_TEXT_KEY)).toBe(false);
    const b = reload(a.kv, a.text);
    expect(b.session.graphInitial()).toBe(DEFAULT_GRAPH_PICKER);
  });
});

describe('forget saved session', () => {
  it('forgets everything, and a reload then runs the defaults', async () => {
    const a = reload();
    a.session.saveRun(pastePicker(NASTY_CSV), 0.25);
    a.session.saveView({ ...DEFAULT_VIEW, signal: 'opcount' });
    a.session.saveExploreTab('heap');
    await a.session.clear();
    expect(a.kv.get(SESSION_KEY)).toBeNull();
    expect(a.text.data.size).toBe(0);
    const b = reload(a.kv, a.text);
    const initial = b.session.initial();
    expect(initial.picker).toBe(DEFAULT_PICKER);
    expect(initial.view).toEqual(DEFAULT_VIEW);
    expect(b.session.exploreTab(isExploreKind)).toBeUndefined();
  });

  it('lands after a save that was still in flight, so the text cannot come back', async () => {
    const a = reload();
    const release = a.text.hold(); // the next put waits until released
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    const cleared = a.session.clear();
    release();
    await cleared;
    await a.session.idle();
    expect(a.text.data.has(PASTE_TEXT_KEY)).toBe(false);
    expect(a.kv.get(SESSION_KEY)).toBeNull();
  });

  it('switching from a paste to a generator run deletes the stored text', async () => {
    const a = reload();
    a.session.saveRun(pastePicker(NASTY_CSV), 0.5);
    a.session.saveRun({ ...DEFAULT_PICKER, kind: 'gaussian' }, 0.5);
    await a.session.idle();
    expect(a.text.data.has(PASTE_TEXT_KEY)).toBe(false);
  });
});
