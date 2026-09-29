import type { ValidationError } from '../crdt/types';

interface Props {
  zones: string[];
  allTerminals: string[];
  zone: string;
  selected: string[];
  onZone: (z: string) => void;
  onToggleTerminal: (t: string) => void;
  onRun: () => void;
  busy: boolean;
  errors: ValidationError[] | null;
}

export default function AuditBar({
  zones,
  allTerminals,
  zone,
  selected,
  onZone,
  onToggleTerminal,
  onRun,
  busy,
  errors,
}: Props) {
  const overLimit = allTerminals.length > 3;
  return (
    <section className="audit-bar panel">
      <h3>延迟传播压力审计</h3>
      <p className="dim audit-desc">
        从同一操作脚本为每台终端派生全部源消息（不套用原收件顺序），
        穷举每条消息恰好投递一次的完整方案，寻找所选区域有效性分歧持续最久的投递序列。
        仅支持 <b>2–3 台终端</b> 与 <b>≤10 条源消息</b>。
      </p>
      <div className="audit-controls">
        <label className="audit-field">
          <span className="label">航线区域</span>
          <select value={zone} onChange={(e) => onZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <div className="audit-field">
          <span className="label">
            参与终端（{selected.length}/3，至少 2 台）
            {overLimit && <em className="audit-hint">脚本有 {allTerminals.length} 台，审计至多 3 台</em>}
          </span>
          <span className="chips">
            {allTerminals.map((t) => {
              const on = selected.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={`chip-check ${on ? 'on' : ''}`}
                  onClick={() => onToggleTerminal(t)}
                  title={on ? '移除出审计' : '加入审计'}
                >
                  {t}
                </button>
              );
            })}
          </span>
        </div>
        <button
          className="primary audit-run"
          onClick={onRun}
          disabled={busy || zones.length === 0 || selected.length < 2 || selected.length > 3}
        >
          {busy ? '审计穷举中…' : '发起压力审计'}
        </button>
      </div>
      {errors && errors.length > 0 && (
        <div className="errors">
          <h4>审计被拒绝（{errors.length}）</h4>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                <code>{e.path}</code> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
