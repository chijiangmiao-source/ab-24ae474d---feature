import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReplayWorker from '../worker/replay.worker?worker';
import type { AuditResult, ReplayResult, TerminalView, ValidationError } from '../crdt/types';
import { SAMPLES } from '../samples';
import ScenarioEditor from './ScenarioEditor';
import Controls from './Controls';
import TerminalPanel from './TerminalPanel';
import StepLog from './StepLog';
import AuditBar from './AuditBar';
import AuditTimeline from './AuditTimeline';

function emptyView(terminals: string[], inboxTotal: number): TerminalView {
  const vector: Record<string, number> = {};
  for (const t of terminals) vector[t] = 0;
  return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal };
}

type WorkerResponse = ReplayResult | AuditResult;

export default function App() {
  const [text, setText] = useState(() => JSON.stringify(SAMPLES[0].data, null, 2));
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [replayBusy, setReplayBusy] = useState(false);
  const [auditZone, setAuditZone] = useState('');
  const [auditSelected, setAuditSelected] = useState<string[]>([]);

  const workerRef = useRef<Worker | null>(null);
  // 在途请求类型：编辑/重导入/更换审计选区后旧的异步结果一律作废
  const pendingRef = useRef<'replay' | 'audit' | null>(null);

  useEffect(() => {
    const w = new ReplayWorker();
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const data = e.data;
      if ((data as AuditResult).requestType === 'audit') {
        if (pendingRef.current !== 'audit') return; // 已被编辑/改选作废的过期结果
        pendingRef.current = null;
        setAuditBusy(false);
        setAudit(data as AuditResult);
        return;
      }
      if (pendingRef.current !== 'replay') return;
      pendingRef.current = null;
      setReplayBusy(false);
      setResult(data as ReplayResult);
      setStep(0);
      setPlaying(false);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const parseText = useCallback((jsonText: string): { ok: true; value: unknown } | { ok: false; errors: ValidationError[] } => {
    try {
      return { ok: true, value: JSON.parse(jsonText) };
    } catch (e) {
      return {
        ok: false,
        errors: [{ path: '$', message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }],
      };
    }
  }, []);

  /** 启动新回放：先清除旧回放，再在 Worker 中校验并计算 */
  const run = useCallback(
    (jsonText: string) => {
      const parsed = parseText(jsonText);
      if (!parsed.ok) {
        setReplayBusy(false);
        setResult({ ok: false, errors: parsed.errors });
        return;
      }
      setResult(null);
      setStep(0);
      setPlaying(false);
      setReplayBusy(true);
      pendingRef.current = 'replay';
      workerRef.current?.postMessage(parsed.value);
    },
    [parseText],
  );

  /** 发起延迟传播压力审计（不改动回放结果） */
  const runAudit = useCallback(() => {
    const parsed = parseText(text);
    if (!parsed.ok) {
      setAudit({ ok: false, requestType: 'audit', errors: parsed.errors });
      return;
    }
    setAudit(null);
    setAuditBusy(true);
    pendingRef.current = 'audit';
    workerRef.current?.postMessage({
      kind: 'audit',
      scenario: parsed.value,
      zone: auditZone,
      terminals: auditSelected,
    });
  }, [parseText, text, auditZone, auditSelected]);

  /** 编辑脚本/重新导入：立即作废旧回放与旧审计结果 */
  const editText = useCallback(
    (t: string) => {
      pendingRef.current = null;
      setText(t);
      setResult(null);
      setAudit(null);
      setAuditBusy(false);
      setReplayBusy(false);
      setStep(0);
      setPlaying(false);
    },
    [],
  );

  const loadSample = useCallback(
    (index: number) => {
      const json = JSON.stringify(SAMPLES[index].data, null, 2);
      editText(json);
      run(json);
    },
    [editText, run],
  );

  // 首次挂载自动回放默认样例
  useEffect(() => {
    run(JSON.stringify(SAMPLES[0].data, null, 2));
  }, [run]);

  // 从成功回放派生可选区域与终端集合
  const replayOk = result && result.ok ? result : null;
  const zones = useMemo(() => {
    if (!replayOk) return [] as string[];
    return [...new Set(Object.values(replayOk.messages).map((m) => m.zone))].sort();
  }, [replayOk]);
  const allTerminals = replayOk?.terminals ?? [];

  // 区域默认值与终端子集随场景修正（脚本变化本身已作废旧审计）
  useEffect(() => {
    if (!replayOk) return;
    setAuditZone((z) => (z && zones.includes(z) ? z : zones[0] ?? ''));
    setAuditSelected((sel) => {
      const valid = sel.filter((t) => replayOk.terminals.includes(t));
      if (valid.length >= 2) return valid;
      return replayOk.terminals.slice(0, 3);
    });
  }, [replayOk, zones]);

  /** 更换审计选区（区域/终端集合）：旧审计结果立即失效 */
  const invalidateAudit = useCallback(() => {
    pendingRef.current = null;
    setAudit(null);
    setAuditBusy(false);
  }, []);

  const changeZone = useCallback(
    (z: string) => {
      invalidateAudit();
      setAuditZone(z);
    },
    [invalidateAudit],
  );

  const toggleAuditTerminal = useCallback(
    (t: string) => {
      invalidateAudit();
      setAuditSelected((sel) => {
        if (sel.includes(t)) return sel.filter((x) => x !== t);
        if (sel.length >= 3) return sel; // 硬上限 3 台
        return [...sel, t].sort();
      });
    },
    [invalidateAudit],
  );

  const steps = replayOk ? replayOk.steps : [];
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
    if (!replayOk) return emptyView([], 0);
    if (step === 0) return emptyView(replayOk.terminals, replayOk.inboxSizes[t] ?? 0);
    return steps[step - 1].stateAfter[t];
  };

  const current = step > 0 && step <= total ? steps[step - 1] : null;

  return (
    <div className="app">
      <header>
        <h1>禁飞标签 OR-Set 因果回放台</h1>
        <p className="sub">
          断网期间多地面终端维护禁飞标签 · 点集 + 因果上下文 observed-remove 归并 · 乱序暂存 · 重复幂等 ·
          延迟传播压力审计
        </p>
      </header>
      <div className="layout">
        <ScenarioEditor
          text={text}
          onText={editText}
          onRun={() => run(text)}
          onLoadSample={loadSample}
          errors={result && !result.ok ? result.errors : null}
          running={replayBusy}
        />
        <main>
          {result && !result.ok && (
            <div className="banner bad">
              场景校验失败，已清除旧回放：共 {result.errors.length} 处问题（见左侧面板）
            </div>
          )}

          {replayOk && (
            <AuditBar
              zones={zones}
              allTerminals={allTerminals}
              zone={auditZone}
              selected={auditSelected}
              onZone={changeZone}
              onToggleTerminal={toggleAuditTerminal}
              onRun={runAudit}
              busy={auditBusy}
              errors={audit && !audit.ok ? audit.errors : null}
            />
          )}

          {audit && audit.ok && <AuditTimeline result={audit} />}

          {replayOk && (
            <>
              <div className={`banner ${replayOk.converged ? 'ok' : 'bad'}`}>
                {replayOk.convergenceDetail}
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
                    {replayOk.messages[current.messageId]?.label}
                  </span>
                  <span className="cur-reason">{current.reason}</span>
                  {current.effect && <span className="cur-effect">{current.effect}</span>}
                </div>
              ) : (
                <div className="current idle">初始状态：尚未投递任何消息，使用上方控制条逐步回放</div>
              )}
              <div className="panels">
                {replayOk.terminals.map((t) => (
                  <TerminalPanel key={t} id={t} view={viewAt(t)} />
                ))}
              </div>
              <StepLog steps={steps} current={step} messages={replayOk.messages} onJump={setStep} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
