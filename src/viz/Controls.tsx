import { useState } from 'react';
import * as P from './player';
import type { PlayerControls } from './usePlayer';

/**
 * Step controls (docs/PLAN.md §5): run an op (insert / search / delete on a
 * typed-in key) and the transport for the resulting animation — reset, step
 * back, play / pause, step, jump to end, plus a speed slider and a step counter.
 * The active-step caption explains what the highlighted frame is doing.
 */

const btn: React.CSSProperties = {
  padding: '4px 10px', fontSize: 13, cursor: 'pointer',
  border: '1px solid #ccc', borderRadius: 5, background: '#fff',
};
const opBtn: React.CSSProperties = { ...btn, fontWeight: 600 };

interface ControlsProps<E> {
  readonly player: PlayerControls<E>;
  readonly onOp: (op: 'search' | 'insert' | 'delete', value: number) => void;
  readonly caption: string;
}

export function Controls<E>({ player, onOp, caption }: ControlsProps<E>) {
  const [text, setText] = useState('');
  const value = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(value);
  const run = (op: 'search' | 'insert' | 'delete') => {
    if (valid) onOp(op, value);
  };

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
          onKeyDown={(e) => { if (e.key === 'Enter') run('search'); }}
          placeholder="key"
          style={{ width: 90, padding: '4px 6px', fontSize: 13 }}
        />
        <button style={opBtn} disabled={!valid} onClick={() => run('insert')}>insert</button>
        <button style={opBtn} disabled={!valid} onClick={() => run('search')}>search</button>
        <button style={opBtn} disabled={!valid} onClick={() => run('delete')}>delete</button>
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
