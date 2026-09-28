import { runReplay } from '../crdt/replay';

/**
 * 回放计算 Worker：接收场景 JSON，回传完整回放结果。
 * 计算全部在此线程完成，UI 只负责渲染。
 */
const scope = self as unknown as {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage: (msg: unknown) => void;
};

scope.onmessage = (ev: MessageEvent<unknown>) => {
  try {
    scope.postMessage(runReplay(ev.data));
  } catch (e) {
    scope.postMessage({
      ok: false,
      errors: [{ path: '$', message: `回放内部错误：${e instanceof Error ? e.message : String(e)}` }],
    });
  }
};
