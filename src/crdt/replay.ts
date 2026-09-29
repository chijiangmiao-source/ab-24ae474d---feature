import { Replica } from './engine';
import { parseScenario } from './parse';
import type { MessageSummary, ReplayResult, Step, TerminalView } from './types';

/**
 * 回放：按“轮次 × 终端”顺序消费各终端收件顺序，
 * 逐步记录动作、因果依据与全终端快照，最后复核收敛性。
 *
 * 纯函数、无 IO：既可在 Web Worker 中运行，也可在 Node 下被测试直接调用。
 */
export function runReplay(raw: unknown): ReplayResult {
  const parsed = parseScenario(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const sc = parsed.scenario;

  const replicas = new Map(sc.terminals.map((t) => [t, new Replica(t, sc.terminals)]));
  const done = new Map(sc.terminals.map((t) => [t, 0]));
  const steps: Step[] = [];
  const maxLen = Math.max(...sc.terminals.map((t) => sc.inbox[t].length));

  const capture = (): Record<string, TerminalView> => {
    const out: Record<string, TerminalView> = {};
    for (const t of sc.terminals) {
      out[t] = replicas.get(t)!.view(done.get(t)!, sc.inbox[t].length);
    }
    return out;
  };

  let index = 0;
  for (let round = 0; round < maxLen; round += 1) {
    for (const t of sc.terminals) {
      const inbox = sc.inbox[t];
      if (round >= inbox.length) continue;
      const mid = inbox[round];
      const msg = sc.messagesById[mid];
      done.set(t, done.get(t)! + 1);
      const res = replicas.get(t)!.deliver(msg);
      steps.push({
        index: index++,
        round,
        terminal: t,
        messageId: mid,
        kind: msg.kind,
        action: res.action,
        reason: res.reason,
        effect: res.effect,
        stateAfter: capture(),
      });
      for (const rel of res.releases) {
        steps.push({
          index: index++,
          round,
          terminal: t,
          messageId: rel.msg.id,
          kind: rel.msg.kind,
          action: 'released',
          reason: rel.reason,
          effect: rel.effect,
          stateAfter: capture(),
        });
      }
    }
  }

  // ---- 收敛复核：所有终端有效标签一致且暂存清空 ----
  const views = sc.terminals.map((t) => replicas.get(t)!.view(done.get(t)!, sc.inbox[t].length));
  const zoneKey = views.map((v) => v.zones.map((z) => z.zone).join(''));
  const pendingLeft = views.reduce((acc, v) => acc + v.pending.length, 0);
  const converged = zoneKey.every((k) => k === zoneKey[0]) && pendingLeft === 0;
  const finalZones = views.length > 0 ? views[0].zones.map((z) => z.zone) : [];
  const convergenceDetail = converged
    ? `全部 ${sc.terminals.length} 台终端收敛：有效标签 [${finalZones.join(', ') || '（空）'}]，暂存队列均已清空`
    : `未收敛：${sc.terminals
        .map(
          (t, i) =>
            `${t}=[${views[i].zones.map((z) => z.zone).join('|')}]${
              views[i].pending.length > 0 ? ` 暂存${views[i].pending.length}条` : ''
            }`,
        )
        .join('；')}`;

  const messages: Record<string, MessageSummary> = {};
  for (const m of sc.messages) {
    messages[m.id] = {
      id: m.id,
      kind: m.kind,
      from: m.from,
      seq: m.seq,
      ctx: m.ctx,
      zone: m.kind === 'add' ? m.tag.zone : m.zone,
      label:
        m.kind === 'add'
          ? `新增 ${m.tag.zone}（点 ${m.dot}）`
          : `撤销 ${m.zone}`,
    };
  }

  return {
    ok: true,
    terminals: sc.terminals,
    steps,
    messages,
    inboxSizes: Object.fromEntries(sc.terminals.map((t) => [t, sc.inbox[t].length])),
    converged,
    finalZones,
    convergenceDetail,
  };
}
