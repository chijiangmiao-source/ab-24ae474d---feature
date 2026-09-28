interface Props {
  step: number;
  total: number;
  playing: boolean;
  onStep: (s: number) => void;
  onTogglePlay: () => void;
}

export default function Controls({ step, total, playing, onStep, onTogglePlay }: Props) {
  return (
    <div className="controls">
      <button onClick={() => onStep(0)} disabled={step === 0} title="回到初始">
        ⏮
      </button>
      <button onClick={() => onStep(Math.max(0, step - 1))} disabled={step === 0} title="上一步">
        ◀
      </button>
      <button onClick={onTogglePlay} disabled={!playing && step >= total} title="播放/暂停">
        {playing ? '⏸' : '▶'}
      </button>
      <button
        onClick={() => onStep(Math.min(total, step + 1))}
        disabled={step >= total}
        title="下一步"
      >
        ▶︎
      </button>
      <button onClick={() => onStep(total)} disabled={step >= total} title="跳到末态">
        ⏭
      </button>
      <input
        type="range"
        min={0}
        max={total}
        value={step}
        onChange={(e) => onStep(Number(e.target.value))}
      />
      <span className="step-indicator">
        步 {step} / {total}
      </span>
    </div>
  );
}
