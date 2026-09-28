import type { MessageSummary, Step, StepAction, Vector } from '../crdt/types';

const ACTION_LABEL: Record<StepAction, string> = {
  applied: '应用',
  buffered: '暂存',
  released: '释放',
  duplicate: '重复',
};

function fmtCtx(ctx: Vector): string {
  const parts = Object.entries(ctx)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`);
  return parts.length > 0 ? `{${parts.join(' ')}}` : '{}';
}

interface Props {
  steps: Step[];
  current: number; // 已应用的步数（0..steps.length）
  messages: Record<string, MessageSummary>;
  onJump: (step: number) => void;
}

export default function StepLog({ steps, current, messages, onJump }: Props) {
  return (
    <div className="steplog">
      <h4>步骤日志（点击跳转）</h4>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>终端</th>
            <th>消息</th>
            <th>动作</th>
            <th>因果依据 / 状态影响</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const summary = messages[s.messageId];
            const cls = [
              'step-row',
              s.index < current ? 'done' : '',
              s.index === current - 1 ? 'current' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <tr key={s.index} className={cls} onClick={() => onJump(s.index + 1)}>
                <td>{s.index + 1}</td>
                <td>{s.terminal}</td>
                <td>
                  <code>{s.messageId}</code> {summary?.label}
                  <span className="ctx"> ctx {summary ? fmtCtx(summary.ctx) : ''}</span>
                </td>
                <td>
                  <span className={`badge action-${s.action}`}>{ACTION_LABEL[s.action]}</span>
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
  );
}
