import type { NAxis } from './storedAxis';

/**
 * The **x-axis** control for the Compare charts (docs/PLAN.md §13; `./storedAxis`): plot every
 * line against the input keys it was built from (the default, and what the runtime gate's
 * fits use) or against the keys the structure actually held. It changes only how the
 * results already on screen are drawn and fitted — nothing is re-measured.
 *
 * Radio buttons, not a `<select>`: the browser gate drives the dataset picker with
 * `page.locator('select').first()` (see ProbeMixControl), and these sit after it anyway.
 * The graph section is not affected — its x-axis is the reached component's `V′ + 2E′`.
 */
export const N_AXIS_CHOICES: readonly { readonly value: NAxis; readonly label: string }[] = [
  { value: 'input', label: 'input keys n (default)' },
  { value: 'stored', label: 'stored keys (each structure’s own len())' },
];

export function NAxisControl({
  value,
  onChange,
}: {
  readonly value: NAxis;
  readonly onChange: (axis: NAxis) => void;
}) {
  return (
    <span
      role="radiogroup"
      aria-label="x-axis of the cost charts"
      title="Plot and fit every line against the keys each structure held instead of the keys it was given. Only the de-duplicating structures (the hash sets, the trie) move; nothing is re-measured. The graph section keeps its own axis."
      data-n-axis
      style={{ marginLeft: 12 }}
    >
      <strong>x-axis</strong>:{' '}
      {N_AXIS_CHOICES.map((c) => (
        <label key={c.value} style={{ marginRight: 8 }}>
          <input
            type="radio"
            name="n-axis"
            value={c.value}
            checked={value === c.value}
            onChange={() => onChange(c.value)}
          />{' '}
          {c.label}
        </label>
      ))}
    </span>
  );
}
