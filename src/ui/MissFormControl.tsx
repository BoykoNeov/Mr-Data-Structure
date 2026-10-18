import { DEFAULT_MISS_FORM, MISS_FORM_CHOICES, type MissForm, type ProbeMixSummary } from '../bench/probeMix';

/**
 * The **miss-form** control (docs/PLAN.md §13 probe-mix item (a); docs/METHODOLOGY.md §4
 * hurdles 9 and 15): where the numeric search probes that ask for a *missing* key sit —
 * just past the largest stored key (the calibrated default) or between two stored keys.
 *
 * It sits right after the probe-mix radios, so after the dataset panel, and it is radios for
 * the same reason they are: the browser gate drives `page.locator('select').first()`. Its own
 * file, not more radios inside `ProbeMixControl`, so that control's markup and its tests stay
 * as they were. Like the mix, it applies to the *next* run; what a run on screen measured is
 * read from its result (`ProbeMixSummary.missForm`).
 *
 * The text helpers are pure so the wording is tested without a DOM.
 */

/** The radio label for one form. */
export function missFormLabel(form: MissForm): string {
  return form === 'midRange' ? 'between stored keys' : 'just past the largest key (default)';
}

/**
 * Caption lines for the PNG sheet when a run used mid-range misses — empty otherwise, since
 * the default is what every other note on the page already describes. The provenance line
 * (`describeMix`) names the form; this says what it changes, so the claim travels with the
 * picture (CLAUDE.md: prose in the DOM does not).
 */
export function missFormNotes(s: ProbeMixSummary | null): string[] {
  if (!s || s.missForm !== 'midRange' || s.absent === 0) return [];
  return [
    'The missing keys in this run fall between stored keys, not past the largest one: every structure that ' +
      'compares keys has to walk down to the gap where the key would be. So the skip list pays for its misses and ' +
      'the plain BST’s misses walk its real path, on any data. This is not the workload the built-in checks were ' +
      'calibrated on (METHODOLOGY §4.9, §4.15).',
  ];
}

const box: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 6,
  padding: '8px 14px',
  margin: '8px 0',
  background: '#fafafa',
  fontSize: 13,
};

export function MissFormControl({
  value,
  onChange,
  disabled,
  textRun,
}: {
  readonly value: MissForm;
  readonly onChange: (form: MissForm) => void;
  readonly disabled: boolean;
  /** Whether the run on screen used text keys — this setting never applies to those. */
  readonly textRun: boolean;
}) {
  return (
    <div style={box} data-miss-form>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>Search workload — where the misses sit</div>
      <div role="radiogroup" aria-label="where the missing search keys sit (number keys only)">
        {MISS_FORM_CHOICES.map((f) => (
          <label key={f} style={{ marginRight: 12 }}>
            <input
              type="radio"
              name="miss-form"
              checked={value === f}
              disabled={disabled}
              onChange={() => onChange(f)}
            />{' '}
            {missFormLabel(f)}
          </label>
        ))}
      </div>
      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
        <strong>Number keys only.</strong> By default every missing key is just past your largest one. That is
        the cheapest question for a skip list, and for a plain BST it checks only the tree’s right-hand edge.{' '}
        <em>Between stored keys</em> puts each missing key in a gap between two of your keys (halfway, so
        whole-number keys get a .5 key), spread evenly across the whole range: every structure that compares
        keys must walk down to that gap to rule the key out. Each structure still gets the same questions. It
        applies to the next run, and the built-in checks were tuned on the default only.{' '}
        {textRun ? (
          <>The run on screen used text keys, so this setting did not apply to it: text misses are always</>
        ) : (
          <>Text keys ignore this setting: their misses are always</>
        )}{' '}
        one of your keys with its last letter changed (docs/METHODOLOGY.md §2.5).
      </div>
    </div>
  );
}

/** The form a run should send, given the control's value — the default leaves the field out. */
export function missFormField(form: MissForm): { missForm?: MissForm } {
  return form === DEFAULT_MISS_FORM ? {} : { missForm: form };
}
