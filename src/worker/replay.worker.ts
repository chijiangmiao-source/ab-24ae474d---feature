import { runReplay } from '../crdt/replay';
import { runAudit, type AuditRequest } from '../crdt/audit';

/**
 * 回放/审计计算 Worker：
 * - 普通场景 JSON：执行因果回放，回传 ReplayResult；
 * - { kind: 'audit', ... }：执行延迟传播压力审计，回传 AuditResult。
 * 计算全部在此线程完成，UI 只负责渲染。
 */
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage: (msg: unknown) => void;
};

function isAuditRequest(data: unknown): data is AuditRequest {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { kind?: unknown }).kind === 'audit'
  );
}

scope.onmessage = (ev: MessageEvent<unknown>) => {
  try {
    const data = ev.data;
    if (isAuditRequest(data)) {
      scope.postMessage(runAudit(data.scenario, data.zone, data.terminals));
      return;
    }
    scope.postMessage(runReplay(data));
  } catch (e) {
    const isAudit = isAuditRequest(ev.data);
    scope.postMessage({
      ok: false,
      ...(isAudit ? { requestType: 'audit' as const } : {}),
      errors: [{ path: '$', message: `计算内部错误：${e instanceof Error ? e.message : String(e)}` }],
    });
  }
};
