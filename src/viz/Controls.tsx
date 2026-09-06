import { useState } from 'react';
import * as P from './player';
import type { PlayerControls } from './usePlayer';

/**
 * Step controls (docs/PLAN.md §5): run an op on a typed-in key and the transport
 * for the resulting animation — reset, step back, play / pause, step, jump to end,
 * plus a speed slider and a step counter. The active-step caption explains what the
 * highlighted frame is doing.
 *
 * The op buttons are configurable (the `ops` prop) so each structure can declare
 * its own op set (docs/PLAN.md §4.1): the default is the canonical insert / search
 * / delete trio, while e.g. the heap declares insert / peek / extract-min / search.
 * An op with `needsValue: false` (extract-min, peek) runs without a typed-in key.
 *
 * The **key type** is a prop too, because the trie's keys are strings and every
 * other animated structure's are numbers (docs/PLAN.md §8). `keyKind: 'string'`
 * swaps the number box for a text box and hands `onOp` a string; omitting it keeps
 * the numeric default, so the seven numeric panels are untouched. The two paths are
 * separate parse/dispatch helpers rather than one `string | number` — the numeric
 * one rejects text that would arrive as `NaN`, and the string one has no such
 * failure mode.
 */

const btn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 13, cursor: 'pointer',
  border: '1px solid #ccc', borderRadius: 5, background: '#fff',
};
const opBtn: React.CSSProperties = { ...btn, fontWeight: 600 };

/** One op button: its op token, its label, and whether it consumes the key input. */
export interface OpSpec<O extends string> {
  readonly op: O;
  readonly label: string;
  /** Default true; set false for ops that take no key (extract-min, peek). */
  readonly needsValue?: boolean;
}

type DefaultOp = 'search' | 'insert' | 'delete';

const DEFAULT_OPS: readonly OpSpec<DefaultOp>[] = [
  { op: 'insert', label: 'insert' },
  { op: 'search', label: 'search' },
  { op: 'delete', label: 'delete' },
];

/** Does this op consume the typed-in key? Default yes; `needsValue: false`
 * (extract-min, peek) runs without one. */
export function opNeedsValue<O extends string>(spec: OpSpec<O>): boolean {
  return spec.needsValue !== false;
}

/** Parse the key input: a key is `valid` only when the box is non-blank and reads
 * as a finite number (so an empty box or stray text never dispatches as `NaN`). */
export function parseKey(text: string): { readonly valid: boolean; readonly value: number } {
  const value = Number(text);
  return { valid: text.trim() !== '' && Number.isFinite(value), value };
}

/** Parse the key input in **string** mode: any non-empty text is a key, so this
 * has no `NaN` trap of its own. Whitespace is *not* trimmed — a key may legitimately
 * start or end with a space. The one key the box cannot express is the empty string
 * (a valid trie key, and terminal at the root); an empty box means "nothing typed",
 * and that reading has to win. */
export function parseStringKey(text: string): { readonly valid: boolean; readonly value: string } {
  return { valid: text.length > 0, value: text };
}

/**
 * Decide what a click / Enter on `spec` dispatches given the current input, or
 * `null` to suppress it. A key-taking op with no valid key is suppressed; a
 * `needsValue: false` op (extract-min, peek) always dispatches and passes `0`
 * (never `NaN`) when the box is blank — the structure ignores the value. This is
 * the heap tab's headline path, which the SSR render-smoke test can't exercise.
 */
export function dispatchFor<O extends string>(
  spec: OpSpec<O>,
  text: string,
): { readonly op: O; readonly value: number } | null {
  const { valid, value } = parseKey(text);
  if (opNeedsValue(spec) && !valid) return null;
  return { op: spec.op, value: valid ? value : 0 };
}

/** {@link dispatchFor} for **string** keys: the blank fallback for a
 * `needsValue: false` op is `''` rather than `0`. No string structure declares such
 * an op today (the trie's are the canonical trio), but the helper stays total so a
 * later one cannot dispatch `undefined`. */
export function dispatchStringFor<O extends string>(
  spec: OpSpec<O>,
  text: string,
): { readonly op: O; readonly value: string } | null {
  const { valid, value } = parseStringKey(text);
  if (opNeedsValue(spec) && !valid) return null;
  return { op: spec.op, value: valid ? value : '' };
}

/** Which op the Enter key triggers: `search` if the structure has it, else the
 * first key-taking op (so Enter never fires a no-key op like extract-min). */
export function enterSpecFor<O extends string>(ops: readonly OpSpec<O>[]): OpSpec<O> | undefined {
  return ops.find((o) => o.op === 'search') ?? ops.find(opNeedsValue);
}

interface ControlsBase<E, O extends string> {
  readonly player: PlayerControls<E>;
  readonly caption: string;
  /** Op buttons to show; defaults to the canonical insert / search / delete. */
  readonly ops?: readonly OpSpec<O>[];
}

/** Numeric keys (the default, seven structures) or string keys (the trie). The
 * discriminant is what types `onOp`'s value — there is no `string | number` to
 * unpack at the call site. */
export type ControlsProps<E, O extends string = DefaultOp> =
  | (ControlsBase<E, O> & {
      readonly keyKind?: 'number';
      readonly onOp: (op: O, value: number) => void;
    })
  | (ControlsBase<E, O> & {
      readonly keyKind: 'string';
      readonly onOp: (op: O, value: string) => void;
    });

export function Controls<E, O extends string = DefaultOp>(props: ControlsProps<E, O>) {
  const { player, caption, ops } = props;
  const stringKeys = props.keyKind === 'string';
  const opList = ops ?? (DEFAULT_OPS as readonly OpSpec<O>[]);
  const [text, setText] = useState('');
  const { valid } = stringKeys ? parseStringKey(text) : parseKey(text);
  // `props` is read whole (not destructured) so the discriminant still narrows
  // `onOp` to the matching value type inside each branch.
  const run = (spec: OpSpec<O>) => {
    if (props.keyKind === 'string') {
      const d = dispatchStringFor(spec, text);
      if (d) props.onOp(d.op, d.value);
    } else {
      const d = dispatchFor(spec, text);
      if (d) props.onOp(d.op, d.value);
    }
  };
  const enterSpec = enterSpecFor(opList);

  const { state } = player;
  const len = P.length(state);
  const disabledBack = P.atStart(state);
  const disabledFwd = P.atEnd(state);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type={stringKeys ? 'text' : 'number'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && enterSpec) run(enterSpec); }}
          placeholder="key"
          style={{ width: stringKeys ? 140 : 90, padding: '4px 6px', fontSize: 13 }}
        />
        {opList.map((spec) => (
          <button
            key={spec.op}
            style={opBtn}
            disabled={opNeedsValue(spec) && !valid}
            onClick={() => run(spec)}
          >
            {spec.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={btn} disabled={disabledBack} onClick={player.reset} title="to start">⏮</button>
        <button style={btn} disabled={disabledBack} onClick={player.prev} title="step back">◀ step</button>
        <button style={{ ...btn, minWidth: 90 }} disabled={len === 0} onClick={player.toggle}>
          {player.playing ? '⏸ pause' : '▶ play'}
        </button>
        <button style={btn} disabled={disabledFwd} onClick={player.next} title="step">step ▶</button>
        <button style={btn} disabled={disabledFwd} onClick={player.toEnd} title="to end">⏭</button>

        <label style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>
          speed{' '}
          <input
            type="range" min={1} max={12} step={1} value={player.speed}
            onChange={(e) => player.setSpeed(Number(e.target.value))}
          />
        </label>
        <span style={{ fontSize: 12, color: '#888', fontFamily: 'monospace' }}>
          step {state.frame} / {len}
        </span>
      </div>

      <div style={{ fontSize: 13, color: '#444', minHeight: 19 }}>{caption || ' '}</div>
    </div>
  );
}
