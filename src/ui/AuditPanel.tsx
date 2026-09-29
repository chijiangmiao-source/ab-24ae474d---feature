import type { AuditResult, TerminalView } from '../crdt/types';
import Controls from './Controls';
import TerminalPanel from './TerminalPanel';

interface AuditRequestState {
  zone: string;
  terminals: string[];
}

interface Props {
  replayTerminals: string[];
  zones: string[];
  messageCount: number;
  request: AuditRequestState;
  onRequest: (r: AuditRequestState) => void;
  onLaunch: (zone: string, terminals: string[]) => void;
  running: boolean;
  result: AuditResult | null;
  step: number;
  playing: boolean;
  onStep: (s: number) => void;
  onTogglePlay: () => void;
}

const ACTION_LABEL: Record<string, string> = {
  applied: '应用',
  buffered: '暂存',
  released: '释放',
  duplicate: '重复',
};

const CHANGE_LABEL: Record<string, string> = {
  created: '造成分歧',
  resolved: '消除分歧',
  none: '分歧维持',
};

export default function AuditPanel({
  replayTerminals,
  zones,
  messageCount,
  request,
  onRequest,
  onLaunch,
  running,
  result,
  step,
  playing,
  onStep,
  onTogglePlay,
}: Props) {
  const overMessages = messageCount > 10;
  const selectionValid =
    request.zone.length > 0 && request.terminals.length >= 2 && request.terminals.length <= 3;
  const canLaunch = selectionValid && !overMessages && !running;

  const toggleTerminal = (t: string) => {
    const has = request.terminals.includes(t);
    let next: string[];
    if (has) next = request.terminals.filter((x) => x !== t);
    else {
      if (request.terminals.length >= 3) return; // 最多三台
      next = [...request.terminals, t];
    }
    onRequest({ ...request, terminals: next });
  };

  const ok = result && result.ok ? result : null;
  const err = result && !result.ok ? result : null;
  const total = ok ? ok.steps.length : 0;
  const cur = ok && step > 0 ? ok.steps[step - 1] : null;

  const viewFor = (t: string): TerminalView => {
    if (!ok) {
      const v: Record<string, number> = {};
      for (const x of replayTerminals) v[x] = 0;
      return { vector: v, zones: [], pending: [], inboxDone: 0, inboxTotal: messageCount };
    }
    const snap = step === 0 ? null : ok.steps[step - 1].stateAfter[t];
    if (!snap) {
      const v: Record<string, number> = {};
      for (const x of ok.terminals) v[x] = 0;
      return { vector: v, zones: [], pending: [], inboxDone: 0, inboxTotal: ok.messages.length };
    }
    return {
      vector: snap.vector,
      zones: snap.zones,
      pending: snap.pending,
      inboxDone: snap.delivered,
      inboxTotal: ok.messages.length,
    };
  };

  return (
    <section className="audit">
      <h2>延迟传播压力审计</h2>
      <p className="audit-intro">
        从当前回放脚本派生每台终端可接收的全部消息（每条恰好投递一次，不改写原 inbox、不用随机乱序），
        穷举完整投递交错方案，寻找所选航线区域<strong>有效性分歧持续最久</strong>的方案；
        缺少因果前序的到达仍按暂存 / 依赖补齐后释放计步。最多 3 台终端、10 条源消息。
      </p>

      <div className="audit-controls">
        <label className="audit-field">
          航线区域
          <select
            value={request.zone}
            onChange={(e) => onRequest({ ...request, zone: e.target.value })}
          >
            {zones.length === 0 && <option value="">（无可用区域）</option>}
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <div className="audit-field">
          <span className="audit-field-label">审计终端（2-3 台）</span>
          <span className="chips">
            {replayTerminals.map((t) => {
              const checked = request.terminals.includes(t);
              const disabled = !checked && request.terminals.length >= 3;
              return (
                <button
                  type="button"
                  key={t}
                  className={`chip toggle ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
                  disabled={disabled}
                  onClick={() => toggleTerminal(t)}
                  title={disabled ? '审计最多支持 3 台终端' : `选择终端 ${t}`}
                >
                  {checked ? '☑ ' : '☐ '}
                  {t}
                </button>
              );
            })}
          </span>
        </div>
        <button
          className="primary"
          onClick={() => onLaunch(request.zone, request.terminals)}
          disabled={!canLaunch}
        >
          {running ? '审计穷举中…' : '发起压力审计'}
        </button>
      </div>

      {overMessages && (
        <div className="banner bad">
          当前脚本含 {messageCount} 条源消息，超过审计上限 10 条，审计已明确拒绝；请精简脚本后重新回放。
        </div>
      )}
      {!overMessages && request.terminals.length === 1 && (
        <div className="banner bad">单台终端不存在有效性分歧，请至少选择 2 台终端。</div>
      )}
      {err && (
        <div className="banner bad">
          审计请求被拒绝：{err.errors[0]?.message}
          {err.errors.length > 1 ? `（等 ${err.errors.length} 条，见控制台/首条）` : ''}
          <ul className="audit-errors">
            {err.errors.map((e, i) => (
              <li key={i}>
                <code>{e.path}</code> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {ok && (
        <>
          <div className={`banner ${ok.converged ? 'ok' : 'warn'}`}>
            最优方案：区域 <b>{ok.zone}</b> 的有效性分歧持续 <b>{ok.divergenceSteps}</b> /{' '}
            {ok.totalDeliveries} 步 · 参与终端 {ok.terminals.join('、')} ·{' '}
            {ok.converged ? '投递完成后重新收敛' : '投递完成后仍未收敛'} · 等价状态剪枝：求值{' '}
            {ok.stats.statesEvaluated}、命中 {ok.stats.memoHits}
          </div>

          <Controls
            step={step}
            total={total}
            playing={playing}
            onStep={onStep}
            onTogglePlay={onTogglePlay}
          />

          {cur ? (
            <div className={`current ${cur.divergent ? 'diverge' : 'align'}`}>
              <span className="cur-head">
                第 {cur.index + 1} 步 · 终端 {cur.terminal} · {cur.messageId}{' '}
                {ok.messages.find((m) => m.id === cur.messageId)?.label}
              </span>
              <span className={`badge change-${cur.divergenceChange}`}>
                {CHANGE_LABEL[cur.divergenceChange]}
              </span>
              <span className="cur-reason">{cur.reason}</span>
              {cur.effect && <span className="cur-effect">{cur.effect}</span>}
              {cur.releases.map((r) => (
                <span key={r.messageId} className="cur-effect release">
                  ↳ 级联释放 {r.messageId}：{r.effect}
                </span>
              ))}
            </div>
          ) : (
            <div className="current idle">
              审计初始状态：尚无投递。区域 {ok.zone} 在各终端均无效，使用上方控制条查看最优方案。
            </div>
          )}

          <div className="panels audit-panels">
            {ok.terminals.map((t) => {
              const snap = step === 0 ? null : ok.steps[step - 1].stateAfter[t];
              const divergent = snap ? ok.steps[step - 1].divergent : false;
              return (
                <div key={t} className={`audit-replica ${divergent && snap?.zoneValid ? 'is-valid' : ''} ${divergent ? 'is-divergent' : ''}`}>
                  <div className="audit-replica-head">
                    <span>终端 {t}</span>
                    <span
                      className={`badge ${snap?.zoneValid ? 'zone-valid' : 'zone-invalid'}`}
                      title={`目标区域 ${ok.zone} 有效性`}
                    >
                      {ok.zone}：{snap ? (snap.zoneValid ? '有效' : '无效') : '无效'}
                    </span>
                  </div>
                  <TerminalPanel id={`${t}`} view={viewFor(t)} />
                </div>
              );
            })}
          </div>

          <details className="audit-plans" open>
            <summary>系统从脚本派生的各终端投递序列（原 inbox 不被改写）</summary>
            <ul>
              {ok.terminals.map((t) => (
                <li key={t}>
                  <b>{t}</b>：{ok.terminalPlans[t].join(' → ')}
                </li>
              ))}
            </ul>
            <p className="dim tie">{ok.tieBreakRule}</p>
          </details>

          <div className="steplog audit-log">
            <h4>最优方案逐步轨迹（点击跳转）</h4>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>终端</th>
                  <th>消息</th>
                  <th>动作</th>
                  <th>区域有效性</th>
                  <th>分歧</th>
                  <th>因果依据 / 状态影响</th>
                </tr>
              </thead>
              <tbody>
                {ok.steps.map((s) => {
                  const validity = ok.terminals
                    .map((t) => `${t}${s.stateAfter[t].zoneValid ? '✓' : '✗'}`)
                    .join(' ');
                  const cls = [
                    'step-row',
                    s.index < step ? 'done' : '',
                    s.index === step - 1 ? 'current' : '',
                    s.divergenceChange,
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <tr key={s.index} className={cls} onClick={() => onStep(s.index + 1)}>
                      <td>{s.index + 1}</td>
                      <td>{s.terminal}</td>
                      <td>
                        <code>{s.messageId}</code>
                      </td>
                      <td>
                        <span className={`badge action-${s.action}`}>{ACTION_LABEL[s.action]}</span>
                        {s.releases.length > 0 &&
                          s.releases.map((r) => (
                            <div key={r.messageId}>
                              <span className="badge action-released">↳{r.messageId}</span>
                            </div>
                          ))}
                      </td>
                      <td className="val-cell">{validity}</td>
                      <td>
                        <span className={`badge change-${s.divergenceChange}`}>
                          {s.divergent ? '分歧' : '一致'}·{CHANGE_LABEL[s.divergenceChange]}
                        </span>
                      </td>
                      <td>
                        <div className="reason">{s.reason}</div>
                        {s.effect && <div className="effect">{s.effect}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
