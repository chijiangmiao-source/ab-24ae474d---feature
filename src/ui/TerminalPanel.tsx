import type { TerminalView } from '../crdt/types';

interface Props {
  id: string;
  view: TerminalView;
}

export default function TerminalPanel({ id, view }: Props) {
  const pct = view.inboxTotal === 0 ? 100 : Math.round((view.inboxDone / view.inboxTotal) * 100);
  return (
    <section className="panel">
      <h3>
        终端 {id}
        <span className="inbox-progress">
          收件 {view.inboxDone}/{view.inboxTotal}
        </span>
      </h3>
      <div className="progress">
        <div className="bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="row">
        <span className="label">版本向量</span>
        <span className="chips">
          {Object.entries(view.vector).map(([k, v]) => (
            <span key={k} className="chip">
              {k}={v}
            </span>
          ))}
        </span>
      </div>
      <div className="row col">
        <span className="label">有效标签</span>
        {view.zones.length === 0 ? (
          <span className="dim">（空）</span>
        ) : (
          <ul className="zones">
            {view.zones.map((z) => (
              <li key={z.zone}>
                <b>{z.zone}</b>
                <span className="dots">
                  {z.dots.map((d) => (
                    <span key={d.dot} className="chip ok" title={`支撑事件：${d.events.join('、')}`}>
                      {d.dot}
                      {d.events.length > 1 ? `×${d.events.length}` : ''}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="row col">
        <span className="label">待处理消息（因果暂存）</span>
        {view.pending.length === 0 ? (
          <span className="dim">无</span>
        ) : (
          <span className="chips">
            {view.pending.map((p) => (
              <span key={p} className="chip warn">
                {p}
              </span>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}
