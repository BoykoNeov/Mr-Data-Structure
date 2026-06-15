import { useState } from 'react';
import * as P from './player';
import type { PlayerControls } from './usePlayer';

/**
 * Step controls (docs/PLAN.md §5): run an op on a typed-in key and the transport
 * for the resulting animation — reset, step back, play / pause, step, jump to end,
 * plus a speed slider and a step counter. The active-step caption explains what the
 * highlighted frame is doing.
 *
 * The op buttons are configurable ({@link ControlsProps.ops}) so each structure can
 * declare its own op set (docs/PLAN.md §4.1): the default is the canonical
 * insert / search / delete trio, while e.g. the heap declares insert / peek /
 * extract-min / search. An op with `needsValue: false` (extract-min, peek) runs
 * without a typed-in key.
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

interface ControlsProps<E, O extends string = DefaultOp> {
  readonly player: PlayerControls<E>;
  readonly onOp: (op: O, value: number) => void;
  readonly caption: string;
  /** Op buttons to show; defaults to the canonical insert / search / delete. */
  readonly ops?: readonly OpSpec<O>[];
}

export function Controls<E, O extends string = DefaultOp>({ player, onOp, caption, ops }: ControlsProps<E, O>) {
  const opList = ops ?? (DEFAULT_OPS as readonly OpSpec<O>[]);
  const [text, setText] = useState('');
  const value = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(value);
  const needsValue = (spec: OpSpec<O>) => spec.needsValue !== false;
  const run = (spec: OpSpec<O>) => {
    if (needsValue(spec) && !valid) return;
    onOp(spec.op, valid ? value : 0);
  };
  // Enter runs `search` if the structure has it, else the first key-taking op.
  const enterSpec = opList.find((o) => o.op === 'search') ?? opList.find(needsValue);

  const { state } = player;
  const len = P.length(state);
  const disabledBack = P.atStart(state);
  const disabledFwd = P.atEnd(state);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="number"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && enterSpec) run(enterSpec); }}
          placeholder="key"
          style={{ width: 90, padding: '4px 6px', fontSize: 13 }}
        />
        {opList.map((spec) => (
          <button
            key={spec.op}
            style={opBtn}
            disabled={needsValue(spec) && !valid}
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
