/**
 * The one visible trace of session persistence (docs/PLAN.md §13 — local only): a line
 * saying what this browser remembers, whether this load was restored from it, and the
 * **forget saved session** control.
 *
 * Two rules it keeps:
 * - a restored load says the charts are **measured fresh** — nothing measured is saved
 *   (§2.3, §6.2), so the note must never let a restored configuration read as restored
 *   results;
 * - the button is **never disabled while a run is busy**: if a saved run is the problem (a
 *   huge paste, a very large n), every reload would repeat it, and forgetting it mid-run is
 *   the way out. Its label must not contain "run the sweeps" — the browser gate clicks the
 *   run button by that phrase.
 *
 * The wording is a pure function so it is tested without a DOM.
 */

export interface SessionNoteProps {
  readonly storageAvailable: boolean;
  /** ISO timestamp of the restored run, or `null` when this load ran the defaults. */
  readonly restoredFrom: string | null;
  readonly cleared: boolean;
  readonly onClear: () => void;
}

export const FORGET_LABEL = 'forget saved session';

/** The note's sentence, and whether the forget button shows. */
export function sessionNoteText(
  p: Omit<SessionNoteProps, 'onClear'>,
  formatDate: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): { readonly text: string; readonly showForget: boolean } {
  if (!p.storageAvailable) {
    return {
      text:
        'This browser is not letting the page save anything (private browsing or blocked site data), so a ' +
        'reload starts from the defaults. Everything else works the same.',
      showForget: false,
    };
  }
  if (p.cleared) {
    return {
      text: 'Saved session forgotten — a reload now starts from the defaults. Running again, or changing a chart or tab ' +
        'setting, starts saving again.',
      showForget: true,
    };
  }
  if (p.restoredFrom) {
    return {
      text:
        `Restored from this browser: the dataset and settings you last ran, saved ${formatDate(p.restoredFrom)}. ` +
        'The charts below are measured fresh on this load — timings are machine- and moment-specific, so ' +
        'nothing measured is ever saved.',
      showForget: true,
    };
  }
  return {
    text:
      'This page remembers the dataset you last ran (pasted data included) and your chart and tab choices — ' +
      'in this browser only; nothing is uploaded or shared.',
    showForget: true,
  };
}

export function SessionNote(props: SessionNoteProps) {
  const { text, showForget } = sessionNoteText(props);
  return (
    <div data-session-note style={{ fontSize: 12, color: '#666', margin: '4px 0 8px' }}>
      {text}
      {showForget && (
        <>
          {' '}
          <button onClick={props.onClear} style={{ fontSize: 12 }}>
            {FORGET_LABEL}
          </button>
        </>
      )}
    </div>
  );
}
