import { runAudit, type AuditRequest } from '../crdt/audit';
import { runReplay } from '../crdt/replay';

/**
 * 回放/审计计算 Worker：
 * - { kind: 'replay', scenario, requestId }        → 逐步因果回放
 * - { kind: 'audit', scenario, zone, terminals, requestId } → 延迟传播压力审计
 * - 直接发送场景对象（无 kind 包装）     → 兼容旧协议，按回放处理
 * requestId 原样回传，供主线程丢弃过期（编辑/重发后）的在途结果。
 * 计算全部在此线程完成，UI 只负责渲染。
 */
type WorkerRequest =
  | ({ kind: 'replay'; scenario: unknown; requestId?: number } & Record<string, unknown>)
  | ({ kind: 'audit'; scenario: unknown; requestId?: number } & AuditRequest);

const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage: (msg: unknown) => void;
};

scope.onmessage = (ev: MessageEvent<unknown>) => {
  const data = ev.data as WorkerRequest | Record<string, unknown> | null | undefined;
  const requestId =
    data && typeof data === 'object' && 'requestId' in data
      ? (data as { requestId?: number }).requestId
      : undefined;
  try {
    if (data && typeof data === 'object' && 'kind' in data) {
      if (data.kind === 'replay') {
        scope.postMessage({ kind: 'replay', requestId, result: runReplay(data.scenario) });
        return;
      }
      if (data.kind === 'audit') {
        const req = data as Extract<WorkerRequest, { kind: 'audit' }>;
        scope.postMessage({
          kind: 'audit',
          requestId,
          result: runAudit(req.scenario, { zone: req.zone, terminals: req.terminals }),
        });
        return;
      }
    }
    // 兼容：直接投递场景对象（无 kind 包装）即回放
    scope.postMessage({ kind: 'replay', requestId, result: runReplay(data) });
  } catch (e) {
    const kind =
      data && typeof data === 'object' && (data as { kind?: unknown }).kind === 'audit'
        ? 'audit'
        : 'replay';
    scope.postMessage({
      kind,
      requestId,
      result: {
        ok: false,
        errors: [
          { path: '$', message: `计算内部错误：${e instanceof Error ? e.message : String(e)}` },
        ],
      },
    });
  }
};
