import { useRef } from 'react';
import type { ValidationError } from '../crdt/types';
import { SAMPLES } from '../samples';

interface Props {
  text: string;
  onText: (t: string) => void;
  onRun: () => void;
  onLoadSample: (index: number) => void;
  errors: ValidationError[] | null;
  running: boolean;
}

export default function ScenarioEditor({ text, onText, onRun, onLoadSample, errors, running }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  const importFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onText(reader.result);
    };
    reader.readAsText(f);
  };

  return (
    <aside className="editor">
      <div className="editor-actions">
        <button className="primary" onClick={onRun} disabled={running}>
          {running ? '回放计算中…' : '校验并回放'}
        </button>
        <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importFile(f);
            e.target.value = '';
          }}
        />
      </div>
      <div className="samples">
        {SAMPLES.map((s, i) => (
          <button key={s.name} className="sample" onClick={() => onLoadSample(i)}>
            {s.name}
          </button>
        ))}
      </div>
      <textarea
        value={text}
        onChange={(e) => onText(e.target.value)}
        spellCheck={false}
        placeholder="粘贴场景 JSON…"
      />
      {errors && errors.length > 0 && (
        <div className="errors">
          <h4>校验未通过（{errors.length}）</h4>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                <code>{e.path}</code> {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="help">
        <summary>场景格式说明</summary>
        <pre>{`{
  "terminals": ["A", "B"],          // 2-4 台，标识唯一
  "messages": [
    { "id": "A#1", "kind": "add",   // 事件 id = 终端#序号(从1连续)
      "dot": "D-01",                // 全局唯一点标识
      "tag": { "zone": "Z-1", "lat": 39.9,
               "lng": 116.4, "radiusKm": 3 },
      "ctx": { "A": 1 } },          // 产生时已见上下文(含自身)
    { "id": "A#2", "kind": "remove",
      "zone": "Z-1",                // 撤销：仅清除 ctx 已观察到的点
      "ctx": { "A": 2 } }
  ],
  "inbox": {                        // 各终端收件顺序（允许重复）
    "A": ["A#1", "A#2", "B#1"],
    "B": ["B#1", "A#2", "A#1"]
  }
}`}</pre>
      </details>
    </aside>
  );
}
