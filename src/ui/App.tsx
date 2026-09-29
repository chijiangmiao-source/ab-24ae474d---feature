import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReplayWorker from '../worker/replay.worker?worker';
import type { AuditResult, ReplayResult, TerminalView } from '../crdt/types';
import { SAMPLES } from '../samples';
import ScenarioEditor from './ScenarioEditor';
import Controls from './Controls';
import TerminalPanel from './TerminalPanel';
import StepLog from './StepLog';
import AuditPanel from './AuditPanel';

function emptyView(terminals: string[], inboxTotal: number): TerminalView {
  const vector: Record<string, number> = {};
  for (const t of terminals) vector[t] = 0;
  return { vector, zones: [], pending: [], inboxDone: 0, inboxTotal };
}

/** 从脚本文本提取可审计的航线区域（至少有一次新增），供审计选择；失败返回空 */
function extractZones(text: string): string[] {
  try {
    const obj = JSON.parse(text) as { messages?: Array<Record<string, unknown>> };
    const zones = new Set<string>();
    for (const m of obj.messages ?? []) {
      const tag = m.tag as { zone?: unknown } | undefined;
      if (tag && typeof tag.zone === 'string') zones.add(tag.zone);
    }
    return [...zones].sort();
  } catch {
    return [];
  }
}

function extractMessageCount(text: string): number {
  try {
    const obj = JSON.parse(text) as { messages?: unknown[] };
    return Array.isArray(obj.messages) ? obj.messages.length : 0;
  } catch {
    return 0;
  }
}

export default function App() {
  const [text, setText] = useState(() => JSON.stringify(SAMPLES[0].data, null, 2));
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [auditStep, setAuditStep] = useState(0);
  const [auditPlaying, setAuditPlaying] = useState(false);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditReq, setAuditReq] = useState<{ zone: string; terminals: string[] }>({
    zone: '',
    terminals: [],
  });

  const workerRef = useRef<Worker | null>(null);
  /** 最近一次提交（点击回放/导入样例）的脚本文本 */
  const sentTextRef = useRef('');
  /** 最近一次“校验通过并完成回放”的脚本文本；审计只能从它派生 */
  const [committedText, setCommittedText] = useState('');
  /** 请求序号：用于丢弃编辑/重发后才返回的过期在途结果 */
  const replaySeqRef = useRef(0);
  const auditSeqRef = useRef(0);

  useEffect(() => {
    const w = new ReplayWorker();
    w.onmessage = (
      e: MessageEvent<
        | { kind: 'replay'; requestId?: number; result: ReplayResult }
        | { kind: 'audit'; requestId?: number; result: AuditResult }
      >,
    ) => {
      const msg = e.data;
      if (msg.kind === 'audit') {
        if (msg.requestId !== undefined && msg.requestId !== auditSeqRef.current) return; // 过期结果
        setAuditRunning(false);
        setAudit(msg.result);
        setAuditStep(0);
        setAuditPlaying(false);
        return;
      }
      if (msg.requestId !== undefined && msg.requestId !== replaySeqRef.current) return; // 过期结果
      setResult(msg.result);
      setStep(0);
      setPlaying(false);
      // 新回放意味着脚本已重新提交：旧审计立即失效；仅在校验通过时固化提交版本
      setAudit(null);
      setAuditStep(0);
      setAuditPlaying(false);
      setAuditRunning(false);
      if (msg.result.ok) setCommittedText(sentTextRef.current);
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  /** 启动新回放：先清除旧回放，再在 Worker 中校验并计算 */
  const run = useCallback((jsonText: string) => {
    setResult(null);
    setStep(0);
    setPlaying(false);
    auditSeqRef.current += 1; // 新回放使在途/旧审计全部作废
    setAudit(null);
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
    sentTextRef.current = jsonText;
    replaySeqRef.current += 1;
    workerRef.current?.postMessage({
      kind: 'replay',
      scenario: parsed,
      requestId: replaySeqRef.current,
    });
  }, []);

  /** 发起延迟传播压力审计（从最近一次校验通过的回放脚本派生全部消息） */
  const launchAudit = useCallback(
    (zone: string, terminals: string[]) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(committedText);
      } catch (e) {
        setAudit({
          ok: false,
          errors: [
            { path: '$', message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` },
          ],
        });
        return;
      }
      setAudit(null);
      setAuditStep(0);
      setAuditPlaying(false);
      setAuditRunning(true);
      auditSeqRef.current += 1;
      workerRef.current?.postMessage({
        kind: 'audit',
        scenario: parsed,
        zone,
        terminals,
        requestId: auditSeqRef.current,
      });
    },
    [committedText],
  );

  const loadSample = useCallback(
    (index: number) => {
      const json = JSON.stringify(SAMPLES[index].data, null, 2);
      setText(json);
      run(json); // 重新导入样例：旧结果随之失效
    },
    [run],
  );

  /** 编辑脚本（含重新导入）：回放保留展示，但旧审计立即失效（在途结果一并作废） */
  const handleText = useCallback((t: string) => {
    setText(t);
    auditSeqRef.current += 1;
    setAudit(null);
    setAuditStep(0);
    setAuditPlaying(false);
    setAuditRunning(false);
  }, []);

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
  const zones = useMemo(() => extractZones(committedText), [committedText]);

  // 回放脚本固化后，把审计请求协调为合法默认值：首个航线区域 + 至多前三台终端；
  // 重新导入后旧选择若在新脚本中已不存在则一并重置（旧审计结果已在提交时失效）。
  useEffect(() => {
    if (!committedText) return;
    const zs = extractZones(committedText);
    let allTerms: string[] = [];
    try {
      const obj = JSON.parse(committedText) as { terminals?: string[] };
      allTerms = Array.isArray(obj.terminals) ? obj.terminals : [];
    } catch {
      allTerms = [];
    }
    setAuditReq((prev) => {
      const zone = zs.includes(prev.zone) ? prev.zone : zs[0] ?? '';
      const kept = prev.terminals.filter((t) => allTerms.includes(t));
      const terminals =
        kept.length >= 2 ? kept : allTerms.slice(0, Math.min(3, allTerms.length));
      if (zone === prev.zone && terminals.join() === prev.terminals.join()) return prev;
      return { zone, terminals };
    });
  }, [committedText]);

  const auditTotal = audit && audit.ok ? audit.steps.length : 0;
  useEffect(() => {
    if (!auditPlaying) return;
    if (auditStep >= auditTotal) {
      setAuditPlaying(false);
      return;
    }
    const timer = setTimeout(() => setAuditStep((s) => Math.min(s + 1, auditTotal)), 650);
    return () => clearTimeout(timer);
  }, [auditPlaying, auditStep, auditTotal]);

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
          onText={handleText}
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

              <AuditPanel
                replayTerminals={result.terminals}
                zones={zones}
                messageCount={extractMessageCount(committedText)}
                request={auditReq}
                onRequest={(req) => {
                  setAuditReq(req);
                  auditSeqRef.current += 1; // 目标变更：在途审计结果作废
                  setAudit(null); // 改变目标区域或终端集合：旧审计立即失效
                  setAuditStep(0);
                }}
                onLaunch={launchAudit}
                running={auditRunning}
                result={audit}
                step={auditStep}
                playing={auditPlaying}
                onStep={(s) => {
                  setAuditStep(s);
                  setAuditPlaying(false);
                }}
                onTogglePlay={() =>
                  setAuditPlaying((p) => !p && auditStep < (audit?.ok ? audit.steps.length : 0))
                }
              />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
