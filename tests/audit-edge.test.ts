import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/crdt/audit';

describe('审计边界', () => {
  it('单条新增 × 2 终端', () => {
    const sc = {
      terminals: ['A', 'B'],
      messages: [
        { id: 'A#1', kind: 'add' as const, dot: 'D1', tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 }, ctx: { A: 1 } },
      ],
      inbox: { A: ['A#1'], B: ['A#1'] },
    };
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalDeliveries).toBe(2);
    expect(r.divergenceSteps).toBe(1); // 首次投递造成分歧，第二次收敛
    expect(r.steps.map((s) => [s.terminal, s.messageId, s.divergenceChange])).toEqual([
      ['A', 'A#1', 'created'],
      ['B', 'A#1', 'resolved'], // 同分首投取标识更小的终端 A；第二步由 B 投递后一致
    ]);
  });

  it('4 终端脚本审计 3 台子集：消息 ctx 引用未参与终端 D', () => {
    const sc = {
      terminals: ['A', 'B', 'C', 'D'],
      messages: [
        { id: 'D#1', kind: 'add' as const, dot: 'DD', tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 }, ctx: { D: 1 } },
        { id: 'A#1', kind: 'add' as const, dot: 'DA', tag: { zone: 'Z1', lat: 2, lng: 2, radiusKm: 1 }, ctx: { A: 1, D: 1 } },
        { id: 'B#1', kind: 'remove' as const, zone: 'Z1', ctx: { B: 1, A: 1, D: 1 } },
      ],
      inbox: { A: ['D#1', 'A#1', 'B#1'], B: ['B#1', 'A#1', 'D#1'], C: ['A#1', 'D#1', 'B#1'], D: ['D#1', 'A#1', 'B#1'] },
    };
    // 审计 A、B、C（不含 D）；A#1/B#1 的就绪仍取决于 D#1 是否投递，D 作为“消息来源终端”照常参与结算
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B', 'C'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.terminals).toEqual(['A', 'B', 'C']);
    expect(r.totalDeliveries).toBe(9);
    for (const t of ['A', 'B', 'C']) {
      expect(r.terminalPlans[t].slice().sort()).toEqual(['A#1', 'B#1', 'D#1'].sort());
    }
    expect(r.converged).toBe(true);
    // 每步快照版本向量含全部 4 个终端键（引擎以场景全终端初始化）
    for (const s of r.steps) {
      expect(Object.keys(s.stateAfter.A.vector).sort()).toEqual(['A', 'B', 'C', 'D']);
    }
  });
});
