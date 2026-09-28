import { useCallback, useEffect, useRef, useState } from 'react';
import ReplayWorker from '../worker/replay.worker?worker';
import type { ReplayResult, TerminalView } from '../crdt/types';
import { SAMPLES } from '../samples';
import ScenarioEditor from './ScenarioEditor';
import Controls from './Controls';
import TerminalPanel from './TerminalPanel';
import StepLog from './StepLog';

function emptyView(terminals: string[], inboxTotal: number): TerminalView {
  const vector: Record<string, number> = {};
  for (const t of terminals) vector[t] = 0;
  return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal };
}

export default function App() {
  const [text, setText] = useState(() => JSON.stringify(SAMPLES[0].data, null, 2));
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const w = new ReplayWorker();
    w.onmessage = (e: MessageEvent<ReplayResult>) => {
      setResult(e.data);
      setStep(0);
      setPlaying(false);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  /** 启动新回放：先清除旧回放，再在 Worker 中校验并计算 */
  const run = useCallback((jsonText: string) => {
    setResult(null);
    setStep(0);
    setPlaying(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      setResult({
        ok: false,
        errors: [{ path: '$', message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }],
      });
      return;
    }
    workerRef.current?.postMessage(parsed);
  }, []);

  const loadSample = useCallback(
    (index: number) => {
      const json = JSON.stringify(SAMPLES[index].data, null, 2);
      setText(json);
      run(json);
    },
    [run],
  );

  // 首次挂载自动回放默认样例
  useEffect(() => {
    run(JSON.stringify(SAMPLES[0].data, null, 2));
  }, [run]);

  const steps = result && result.ok ? result.steps : [];
  const total = steps.length;

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep((s) => Math.min(s + 1, total)), 650);
    return () => clearTimeout(timer);
  }, [playing, step, total]);

  const viewAt = (t: string): TerminalView => {
    if (!result || !result.ok) return emptyView([], 0);
    if (step === 0) return emptyView(result.terminals, result.inboxSizes[t] ?? 0);
    return steps[step - 1].stateAfter[t];
  };

  const current = step > 0 && step <= total ? steps[step - 1] : null;

  return (
    <div className="app">
      <header>
        <h1>禁飞标签 OR-Set 因果回放台</h1>
        <p className="sub">
          断网期间多地面终端维护禁飞标签 · 点集 + 因果上下文 observed-remove 归并 · 乱序暂存 · 重复幂等
        </p>
      </header>
      <div className="layout">
        <ScenarioEditor
          text={text}
          onText={setText}
          onRun={() => run(text)}
          onLoadSample={loadSample}
          errors={result && !result.ok ? result.errors : null}
          running={result === null}
        />
        <main>
          {result && !result.ok && (
            <div className="banner bad">
              场景校验失败，已清除旧回放：共 {result.errors.length} 处问题（见左侧面板）
            </div>
          )}
          {result && result.ok && (
            <>
              <div className={`banner ${result.converged ? 'ok' : 'bad'}`}>
                {result.convergenceDetail}
              </div>
              <Controls
                step={step}
                total={total}
                playing={playing}
                onStep={(s) => {
                  setStep(s);
                  setPlaying(false);
                }}
                onTogglePlay={() => setPlaying((p) => !p && step < total)}
              />
              {current ? (
                <div className={`current action-${current.action}`}>
                  <span className="cur-head">
                    第 {current.index + 1} 步 · 终端 {current.terminal} · {current.messageId}{' '}
                    {result.messages[current.messageId]?.label}
                  </span>
                  <span className="cur-reason">{current.reason}</span>
                  {current.effect && <span className="cur-effect">{current.effect}</span>}
                </div>
              ) : (
                <div className="current idle">初始状态：尚未投递任何消息，使用上方控制条逐步回放</div>
              )}
              <div className="panels">
                {result.terminals.map((t) => (
                  <TerminalPanel key={t} id={t} view={viewAt(t)} />
                ))}
              </div>
              <StepLog steps={steps} current={step} messages={result.messages} onJump={setStep} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
