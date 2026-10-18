import {
  CHAINING_MAX_LOAD,
  DEFAULT_OA_MAX_LOAD,
  OA_MAX_LOAD_CHOICES,
  isDefaultOaLoad,
  type OaLoadReach,
} from '../bench/oaLoad';
import { Callout } from './Explain';

/**
 * The open-addressing hash set's **load-factor control** and its honesty copy (docs/PLAN.md
 * §13; `../bench/oaLoad`). Kept in its own file, as `./BstNotes` is, so the slice adds a few
 * lines to `CompareSection.tsx` rather than rewriting its shared callouts.
 *
 * The one thing these must say, because the chart cannot: **at any threshold but 0.75 the two
 * hash sets are no longer like for like.** The chaining set never leaves 0.75, so the pair of
 * blue lines stops isolating the collision strategy — the tables differ in size at many n and
 * the gap mixes strategy with load factor. The note appears exactly when the run measured a
 * non-default threshold (keyed on the result, never on the radio's next-run value), beside both
 * charts the set is on, and as a PNG caption line, since an exported image travels without
 * the page.
 *
 * Radio buttons after the dataset panel, as the probe mix's are: the browser gate drives the
 * dataset picker with `page.locator('select').first()`.
 */

/** The radio label for one threshold choice. */
export function oaLoadChoiceLabel(maxLoad: number): string {
  if (isDefaultOaLoad(maxLoad)) return `${maxLoad} (default — the chaining set’s)`;
  if (maxLoad < DEFAULT_OA_MAX_LOAD) return `${maxLoad} — roomier, linear probing’s usual ceiling`;
  return `${maxLoad} — fuller`;
}

/** One line for the run's status list and exports: both hash sets' thresholds. */
export function describeOaLoad(maxLoad: number): string {
  return `open-addressing hash set max load ${maxLoad} (chaining hash set: ${CHAINING_MAX_LOAD})`;
}

/** What the search points' load factors were, in words — the part a threshold's name hides. */
function reachSentence(maxLoad: number, reach: OaLoadReach | null): string {
  if (!reach) return '';
  const span =
    `On this run its search points sat at load factors from ${reach.min.toFixed(2)} to ` +
    `${reach.max.toFixed(2)} (the fullest at n = ${reach.atN.toLocaleString('en-US')})`;
  // A doubling table only fills to its ceiling just before it doubles, and the sweep sizes are
  // fixed, so a run can miss the top of every sawtooth (0.9 reaches 0.78 on the default sizes).
  return reach.max < maxLoad - 0.05
    ? `${span} — none of them near the ${maxLoad} ceiling, because the sweep sizes catch the table at ` +
        'fixed points of its fill-and-double cycle, so this run shows less of the setting’s cost than its name suggests. '
    : `${span}. `;
}

/** The direction-specific sentence: what a roomier or a fuller table does to the probes. */
function directionSentence(maxLoad: number): string {
  return maxLoad < DEFAULT_OA_MAX_LOAD
    ? 'A lower ceiling keeps the table emptier — shorter runs of occupied slots, cheaper misses — and pays in ' +
        'memory: at some sizes it has twice the slots. '
    : 'A higher ceiling packs the table fuller, and linear probing’s misses get dear fast: about ½(1 + 1/(1−α)²) ' +
        'steps, roughly 50 at 90% full against 8.5 at 75% (METHODOLOGY §2.8). ';
}

/**
 * The PNG caption line, or `null` at the default — the like-for-like run every other note on
 * the page describes. `reach` is the search series' {@link OaLoadReach}, when there is one.
 */
export function oaLoadSheetNote(maxLoad: number, reach: OaLoadReach | null): string | null {
  if (isDefaultOaLoad(maxLoad)) return null;
  return (
    `The open-addressing hash set (light blue) ran at max load ${maxLoad}, not the chaining set’s ` +
    `${CHAINING_MAX_LOAD}, so the two hash sets are not like for like here: their tables differ in size at many n ` +
    'and the gap between their lines is load factor as well as collision strategy. ' +
    reachSentence(maxLoad, reach) +
    directionSentence(maxLoad) +
    'Its fitted label is not a claim either: the line saws as the table fills and doubles.'
  );
}

/** Beside the search and the churn chart: the caveat box, only for a non-default run. */
export function OaLoadNote({
  maxLoad,
  reach,
  chart,
}: {
  /** The threshold the on-screen run measured (`CompareResult.oaMaxLoad`). */
  readonly maxLoad: number;
  /** The search series' load-factor reach (search chart only; `null` elsewhere). */
  readonly reach: OaLoadReach | null;
  readonly chart: 'search' | 'churn';
}) {
  if (isDefaultOaLoad(maxLoad)) return null;
  return (
    <Callout title={`Not like for like: the light-blue hash set ran at max load ${maxLoad}`} tone="caveat">
      This run built the open-addressing hash set to rehash at {maxLoad} full instead of {CHAINING_MAX_LOAD}. The
      chaining hash set (blue) always rehashes at {CHAINING_MAX_LOAD}, so the two tables no longer have the same
      size at every n, and the gap between the two blue lines is the load factor as well as the collision
      strategy. {directionSentence(maxLoad)}
      {chart === 'search' ? (
        <>
          {reachSentence(maxLoad, reach)}Its fitted label is not a claim: the line saws up and down as the table
          fills and doubles, and more loudly the higher the ceiling.
        </>
      ) : (
        <>
          Removed keys leave markers that count toward the ceiling too, so the add/remove keys’ own markers can
          tip a nearly full table into doubling before anything is timed — at some sizes the add/remove line is
          measured on a roomier table than the search line at the same n.
        </>
      )}{' '}
      Choose {DEFAULT_OA_MAX_LOAD} above and run again for the like-for-like comparison.
    </Callout>
  );
}

const box: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 6,
  padding: '8px 14px',
  margin: '8px 0',
  background: '#fafafa',
  fontSize: 13,
};

/** The control: which threshold the *next* run builds the open-addressing set at. */
export function OaLoadControl({
  value,
  onChange,
  disabled,
}: {
  readonly value: number;
  readonly onChange: (maxLoad: number) => void;
  readonly disabled: boolean;
}) {
  return (
    <div style={box} data-oa-load>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>
        Open-addressing hash set — how full before it grows
      </div>
      <div role="radiogroup" aria-label="maximum load factor of the open-addressing hash set">
        {OA_MAX_LOAD_CHOICES.map((l) => (
          <label key={l} style={{ marginRight: 12 }}>
            <input type="radio" name="oa-max-load" checked={value === l} disabled={disabled} onChange={() => onChange(l)} />{' '}
            {oaLoadChoiceLabel(l)}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        The light-blue hash set doubles its table once it is this full (removed-key markers count too). It applies
        to the next run and to that line only: the chaining hash set (blue) always grows at {CHAINING_MAX_LOAD}.
        At {DEFAULT_OA_MAX_LOAD} the two tables are the same size at every n, so the gap between them is the
        collision strategy alone; at any other setting it is not, and the notes beside the charts say so.
      </div>
    </div>
  );
}
