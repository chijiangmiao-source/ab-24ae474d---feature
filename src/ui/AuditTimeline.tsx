import { useEffect, useState } from 'react';
import type { AuditResult } from '../crdt/types';
import TerminalPanel from './TerminalPanel';

const CHANGE_LABEL: Record<string, string> = {
  created: '造成分歧',
  resolved: '消除分歧',
  persisted: '分歧持续',
  none: '区域一致',
};

function emptyView(terminals: string[], total: number) {
  return {
    vector: Object.fromEntries(terminals.map((t) => [t, 0])),
    zones: [],
    pending: [],
    inboxDone: 0,
    inboxTotal: total,
  };
}

export default function AuditTimeline({ result }: { result: Extract<AuditResult, { ok: true }> }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = result.steps.length;

  // 新审计结果到达时复位
  useEffect(() => {
    setStep(0);
    setPlaying(false);
  }, [result]);

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep((s) => Math.min(s + 1, total)), 650);
    return () => clearTimeout(timer);
  }, [playing, step, total]);

  const cur = step > 0 && step <= total ? result.steps[step - 1] : null;
  const viewAt = (t: string) => {
    if (step === 0 || !cur) return emptyView(result.terminals, result.messageCount);
    return cur.stateAfter[t];
  };

  return (
    <section className="audit-result">
      <div className={`banner ${result.divergenceSteps > 0 ? 'bad' : 'ok'}`}>{result.detail}</div>

      <div className="panel plans-box">
        <h4>稳定裁决出的完整投递方案（每条源消息恰好投递一次）</h4>
        {result.plans.map((p) => (
          <div key={p.terminal} className="plan-line">
            <span className="plan-terminal">终端 {p.terminal}</span>
            <span className="chips">
              {p.order.map((id, i) => (
                <span
                  key={`${id}-${i}`}
                  className={`chip plan-chip ${
                    cur?.terminal === p.terminal && cur.planIndex === i + 1 ? 'now' : ''
                  }`}
                >
                  {id}
                </span>
              ))}
            </span>
          </div>
        ))}
        <div className="audit-meta dim">
          目标区域 <b>{result.zone}</b> · 源消息 {result.messageCount} 条 · 参与终端{' '}
          {result.terminals.join('、')} · 单终端轨迹状态 {result.stats.rawTraceStates}→商类{' '}
          {result.stats.quotientClasses}（等价合并 {result.stats.mergedStates}） · 乘积穷举{' '}
          {result.stats.productStates} 状态 / {result.stats.productTransitions} 转移
        </div>
      </div>

      <div className="controls">
        <button onClick={() => setStep(0)} disabled={step === 0} title="回到初始">
          ⏮
        </button>
        <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} title="上一步">
          ◀
        </button>
        <button
          onClick={() => setPlaying((p) => !p && step < total)}
          disabled={!playing && step >= total}
          title="播放/暂停"
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => setStep(Math.min(total, step + 1))} disabled={step >= total} title="下一步">
          ▶︎
        </button>
        <button onClick={() => setStep(total)} disabled={step >= total} title="跳到末态">
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={total}
          value={step}
          onChange={(e) => {
            setStep(Number(e.target.value));
            setPlaying(false);
          }}
        />
        <span className="step-indicator">
          事件步 {step} / {total} · 分歧步 {result.divergenceSteps}
        </span>
      </div>

      {cur ? (
        <div className={`current audit-current change-${cur.change} action-${cur.action}`}>
          <span className="cur-head">
            事件 {cur.index} · 终端 {cur.terminal} · <code>{cur.messageId}</code>{' '}
            {result.messages[cur.messageId]?.label}
            <span className={`div-tag change-${cur.change}`}>{CHANGE_LABEL[cur.change]}</span>
          </span>
          <span className="cur-reason">{cur.reason}</span>
          {cur.effect && <span className="cur-effect">{cur.effect}</span>}
          <span className="zone-eff">
            {result.terminals.map((t) => (
              <span key={t} className={`eff-chip ${cur.zoneEffective[t] ? 'yes' : 'no'}`}>
                {t}:{result.zone}={cur.zoneEffective[t] ? '有效' : '无效'}
              </span>
            ))}
          </span>
        </div>
      ) : (
        <div className="current idle">初始状态：尚未投递任何消息，使用上方控制条查看穷举出的压力投递方案</div>
      )}

      <div className="panels">
        {result.terminals.map((t) => (
          <TerminalPanel key={t} id={t} view={viewAt(t)} />
        ))}
      </div>

      <div className="steplog">
        <h4>审计事件日志（点击跳转；红/绿边表示该步造成或消除分歧）</h4>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>终端</th>
              <th>消息</th>
              <th>动作</th>
              <th>区域分歧</th>
              <th>因果依据 / 状态影响</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((s) => (
              <tr
                key={s.index}
                className={[
                  'step-row',
                  s.index < step ? 'done' : '',
                  s.index === step ? 'current' : '',
                  `change-${s.change}`,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  setStep(s.index);
                  setPlaying(false);
                }}
              >
                <td>{s.index}</td>
                <td>{s.terminal}</td>
                <td>
                  <code>{s.messageId}</code> {result.messages[s.messageId]?.label}
                </td>
                <td>
                  <span className={`badge action-${s.action}`}>
                    {s.action === 'applied' ? '应用' : s.action === 'released' ? '释放' : '暂存'}
                  </span>
                </td>
                <td>
                  <span className={`div-tag change-${s.change}`}>{CHANGE_LABEL[s.change]}</span>
                </td>
                <td>
                  <div className="reason">{s.reason}</div>
                  {s.effect && <div className="effect">{s.effect}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
