import { useState } from 'react';
import type { PickerState } from '../ui/DatasetPicker';
import type { GraphPickerState } from '../ui/graphPicker';
import { browserSession, type FirstRun, type SavedView, type Session } from './session';
import type { SessionNoteProps } from './SessionNote';

/**
 * The graph section's slice of the session, handed to `GraphCompareSection` as one prop so the
 * section stays storage-free in its render tests. Nothing here runs the graph: a restore only
 * refills the form, and the save happens on *measure the graph*.
 */
export interface GraphPersistence {
  /** The saved picker, its text `''` — for the first render. */
  readonly initial: GraphPickerState;
  /** The saved picker with its edge-list text, once IndexedDB has answered. */
  readonly restore: () => Promise<GraphPickerState>;
  readonly save: (state: GraphPickerState) => void;
}

function graphPersistence(session: Session): GraphPersistence {
  return {
    initial: session.graphInitial(),
    restore: () => session.graphPicker(),
    save: (state) => session.saveGraph(state),
  };
}

/**
 * Compare's side of session persistence (docs/PLAN.md §13 — local only), as one hook so
 * `CompareSection` gains a handful of lines rather than a rewritten mount effect.
 *
 * - `initial` is read **synchronously** from `localStorage` for the first render, so the
 *   `useState` initializers (probe mix, signal, overlays) and the dataset panel start from
 *   the saved values with no flash of defaults.
 * - `firstRun()` resolves the mount-time auto-run's dataset + mix, reading the paste text
 *   from IndexedDB only when one was saved. If the text arrives (or the saved run had to be
 *   dropped) the dataset panel is remounted on the resolved state via `pickerKey`.
 */
export function useComparePersistence(session: Session = browserSession()) {
  const [initial] = useState(() => session.initial());
  const [graph] = useState(() => graphPersistence(session));
  const [picker, setPicker] = useState({ key: 0, initial: initial.picker });
  const [restoredFrom, setRestoredFrom] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  const firstRun = async (): Promise<FirstRun> => {
    const f = await session.firstRun(initial);
    if (f.picker !== initial.picker) setPicker((p) => ({ key: p.key + 1, initial: f.picker }));
    setRestoredFrom(f.restoredFrom);
    return f;
  };

  const note: SessionNoteProps = {
    storageAvailable: initial.storageAvailable,
    restoredFrom,
    cleared,
    onClear: () => {
      void session.clear();
      setCleared(true);
      setRestoredFrom(null);
    },
  };

  return {
    initial,
    pickerKey: picker.key,
    pickerInitial: picker.initial,
    firstRun,
    saveRun: (state: PickerState, presentFraction: number) => {
      session.saveRun(state, presentFraction);
      setCleared(false);
    },
    saveView: (view: SavedView) => session.saveView(view),
    graph,
    note,
  };
}
