import { describe, expect, it } from 'vitest';
import { Replica } from '../src/crdt/engine';
import { runAudit } from '../src/crdt/audit';
import type { Message } from '../src/crdt/types';

/** 最小分歧场景：A#1 新增 Z1；B#1 在已见 A#1 后撤销 Z1 */
function addRemoveScenario() {
  return {
    terminals: ['A', 'B'],
    messages: [
      {
        id: 'A#1',
        kind: 'add' as const,
        dot: 'DA',
        tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
        ctx: { A: 1, B: 0 },
      },
      { id: 'B#1', kind: 'remove' as const, zone: 'Z1', ctx: { A: 1, B: 1 } },
    ],
    inbox: {
      A: ['A#1', 'B#1'],
      B: ['A#1', 'B#1'],
    },
  };
}

/** 三终端两新增（同区域、不同点）场景 */
function twoAddsScenario() {
  return {
    terminals: ['A', 'B', 'C'],
    messages: [
      {
        id: 'A#1',
        kind: 'add' as const,
        dot: 'DA',
        tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
        ctx: { A: 1, B: 0, C: 0 },
      },
      {
        id: 'B#1',
        kind: 'add' as const,
        dot: 'DB',
        tag: { zone: 'Z1', lat: 2, lng: 2, radiusKm: 1 },
        ctx: { A: 0, B: 1, C: 0 },
      },
    ],
    inbox: {
      A: ['A#1', 'B#1'],
      B: ['B#1', 'A#1'],
      C: ['A#1', 'B#1'],
    },
  };
}

/** 把测试用原始消息补齐为引擎消息（from/seq 正常由 parseScenario 填充） */
function normalize(sc: ReturnType<typeof addRemoveScenario>): Message[] {
  return sc.messages.map((m) => {
    const h = m.id.indexOf('#');
    return { ...m, from: m.id.slice(0, h), seq: Number(m.id.slice(h + 1)) } as Message;
  });
}

/** 用真实副本独立执行审计方案，复算末态有效性 */
function independentlyReplay(
  sc: ReturnType<typeof addRemoveScenario>,
  terminals: string[],
  plan: Record<string, string[]>,
  zone: string,
) {
  const byId = new Map<string, Message>(normalize(sc).map((m) => [m.id, m]));
  const reps = new Map(terminals.map((t) => [t, new Replica(t, sc.terminals)]));
  for (const t of terminals) {
    for (const id of plan[t]) reps.get(t)!.deliver(byId.get(id)!);
    expect(reps.get(t)!.pendingList).toHaveLength(0);
  }
  const validity = Object.fromEntries(
    terminals.map((t) => [
      t,
      reps.get(t)!.view(0, 0).zones.some((z) => z.zone === zone),
    ]),
  );
  return { validity };
}

describe('延迟传播压力审计：最优方案', () => {
  it('最小 add/remove 场景：3/4 步分歧，含暂存与级联释放', () => {
    const sc = addRemoveScenario();
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.terminals).toEqual(['A', 'B']); // 按标识稳定排序
    expect(r.totalDeliveries).toBe(4);
    expect(r.divergenceSteps).toBe(3);

    const s = r.steps;
    expect(s.map((x) => [x.terminal, x.messageId])).toEqual([
      ['A', 'A#1'],
      ['B', 'B#1'],
      ['B', 'A#1'],
      ['A', 'B#1'],
    ]);
    // 每台终端的派生收件序列：每条消息恰好一次（这是延迟投递，不是原 inbox）
    expect(r.terminalPlans.A.slice().sort()).toEqual(['A#1', 'B#1']);
    expect(r.terminalPlans.B.slice().sort()).toEqual(['A#1', 'B#1']);
    expect(r.terminalPlans.B).toEqual(['B#1', 'A#1']);

    // 第 2 步 B#1 缺 A#1 前序 → 暂存，B 仍无效；分歧维持
    expect(s[1].action).toBe('buffered');
    expect(s[1].stateAfter.B.pending).toEqual(['B#1']);
    expect(s[1].stateAfter.B.vector).toEqual({ A: 0, B: 0 });
    expect(s[1].divergent).toBe(true);
    expect(s[0].divergenceChange).toBe('created');

    // 第 3 步 A#1 到达 B 后应用并级联释放 B#1（撤销生效），分歧仍维持
    expect(s[2].action).toBe('applied');
    expect(s[2].releases.map((x) => x.messageId)).toEqual(['B#1']);
    expect(s[2].stateAfter.B.vector).toEqual({ A: 1, B: 1 });
    expect(s[2].stateAfter.B.pending).toEqual([]);
    expect(s[2].stateAfter.B.zoneValid).toBe(false);
    expect(s[2].stateAfter.A.zoneValid).toBe(true);

    // 第 4 步 A 收到 B#1，撤销生效，分歧消除；末态收敛（均无效）
    expect(s[3].divergenceChange).toBe('resolved');
    expect(r.converged).toBe(true);
    expect(r.finalValid).toEqual({ A: false, B: false });

    // 分歧标记序列
    expect(s.map((x) => x.divergent)).toEqual([true, true, true, false]);

    // 独立复算末态
    const ind = independentlyReplay(sc, ['A', 'B'], r.terminalPlans, 'Z1');
    expect(ind.validity).toEqual({ A: false, B: false });
  });

  it('同区域双新增：最优 2 步分歧，同分按终端/消息标识裁决，末态均有效', () => {
    const sc = twoAddsScenario();
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.divergenceSteps).toBe(2);
    // 字典序最前：首投必须是终端 A 的 A#1（而不是 B 的 B#1）
    expect([r.steps[0].terminal, r.steps[0].messageId]).toEqual(['A', 'A#1']);
    expect(r.finalValid).toEqual({ A: true, B: true });
    expect(r.converged).toBe(true);
  });

  it('确定性：同请求两次运行，方案与逐步轨迹完全一致', () => {
    const sc = twoAddsScenario();
    const a = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B', 'C'] });
    const b = runAudit(sc, { zone: 'Z1', terminals: ['C', 'A', 'B'] }); // 乱序传入
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.steps.map((s) => [s.terminal, s.messageId])).toEqual(
      b.steps.map((s) => [s.terminal, s.messageId]),
    );
    expect(a.divergenceSteps).toBe(b.divergenceSteps);
    expect(a.terminals).toEqual(['A', 'B', 'C']);
    expect(b.terminals).toEqual(['A', 'B', 'C']);
  });

  it('方案从脚本派生而非套用原 inbox：改写 inbox 不影响审计方案', () => {
    const sc1 = addRemoveScenario();
    const sc2 = structuredClone(sc1);
    sc2.inbox = {
      A: ['B#1', 'A#1'],
      B: ['B#1', 'A#1', 'A#1'], // 含重复（回放允许），审计不应继承
    };
    const r1 = runAudit(sc1, { zone: 'Z1', terminals: ['A', 'B'] });
    const r2 = runAudit(sc2, { zone: 'Z1', terminals: ['A', 'B'] });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.divergenceSteps).toBe(r1.divergenceSteps);
    expect(r2.terminalPlans).toEqual(r1.terminalPlans);
    // 审计方案内绝无重复投递
    for (const t of ['A', 'B']) {
      expect(new Set(r2.terminalPlans[t]).size).toBe(r2.terminalPlans[t].length);
    }
  });

  it('支持终端子集：三终端场景只审计 A、C', () => {
    const sc = twoAddsScenario();
    const r = runAudit(sc, { zone: 'Z1', terminals: ['C', 'A'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.terminals).toEqual(['A', 'C']);
    expect(r.totalDeliveries).toBe(4);
    for (const s of r.steps) expect(['A', 'C']).toContain(s.terminal);
    expect(r.terminalPlans.A).toHaveLength(2);
    expect(r.terminalPlans.C).toHaveLength(2);
  });
});

describe('延迟传播压力审计：超限与非法请求明确拒绝', () => {
  it('超过 3 台终端：明确拒绝并提示上限', () => {
    // 用合法 4 终端场景（解析允许 2-4 台）但审计选 4 台
    const sc = {
      terminals: ['A', 'B', 'C', 'D'],
      messages: [
        {
          id: 'A#1',
          kind: 'add' as const,
          dot: 'D1',
          tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
          ctx: { A: 1 },
        },
      ],
      inbox: { A: ['A#1'], B: ['A#1'], C: ['A#1'], D: ['A#1'] },
    };
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B', 'C', 'D'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('最多支持 3 台'))).toBe(true);
  });

  it('仅 1 台终端：拒绝（无分歧可言）', () => {
    const r = runAudit(twoAddsScenario(), { zone: 'Z1', terminals: ['A'] });
    expect(r.ok).toBe(false);
  });

  it('超过 10 条源消息：明确拒绝并提示上限', () => {
    const terms = ['A', 'B'];
    const messages = [];
    for (const t of terms) {
      for (let seq = 1; seq <= 6; seq += 1) {
        messages.push({
          id: `${t}#${seq}`,
          kind: 'add' as const,
          dot: `D-${t}-${seq}`,
          tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
          ctx: { [t]: seq },
        });
      }
    } // 12 条
    const inbox: Record<string, string[]> = {
      A: messages.map((m) => m.id),
      B: messages.map((m) => m.id),
    };
    const r = runAudit({ terminals: terms, messages, inbox }, {
      zone: 'Z1',
      terminals: ['A', 'B'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('不超过 10 条'))).toBe(true);
  });

  it('未知区域 / 未知终端 / 重复终端 / 缺 zone：拒绝', () => {
    const sc = addRemoveScenario();
    expect(runAudit(sc, { zone: 'NOPE', terminals: ['A', 'B'] }).ok).toBe(false);
    expect(runAudit(sc, { zone: 'Z1', terminals: ['A', 'X'] }).ok).toBe(false);
    expect(runAudit(sc, { zone: 'Z1', terminals: ['A', 'A'] }).ok).toBe(false);
    expect(
      runAudit(sc, { zone: '', terminals: ['A', 'B'] as unknown as string[] }).ok,
    ).toBe(false);
  });

  it('非法场景本身仍被解析层拒绝（审计复用同一校验）', () => {
    const sc = structuredClone(addRemoveScenario());
    // B#1 声称已见 A#9，但全场景 A 只产生 1 条 → 非法上下文
    sc.messages[1].ctx = { A: 9, B: 1 };
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('非法上下文'))).toBe(true);
  });
});

describe('延迟传播压力审计：剪枝与统计', () => {
  it('记忆化生效：求值状态数远小于朴素交错排列数', () => {
    const sc = twoAddsScenario(); // 3 终端 × 2 消息
    const r = runAudit(sc, { zone: 'Z1', terminals: ['A', 'B', 'C'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 朴素交错序列数 = 6!/(2!^3) = 90；等价状态（掩码元组）至多 2^6=64
    expect(r.stats.statesEvaluated).toBeLessThanOrEqual(64);
    expect(r.stats.statesEvaluated).toBeGreaterThan(0);
    // 完整方案步数恰好 = 终端数 × 消息数
    expect(r.steps).toHaveLength(6);
  });

  it('3 终端 × 4 消息规模毫秒级返回且方案完整', () => {
    const terms = ['A', 'B', 'C'];
    const messages = [
      {
        id: 'A#1',
        kind: 'add' as const,
        dot: 'D1',
        tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
        ctx: { A: 1, B: 0, C: 0 },
      },
      {
        id: 'B#1',
        kind: 'add' as const,
        dot: 'D2',
        tag: { zone: 'Z1', lat: 2, lng: 2, radiusKm: 1 },
        ctx: { A: 0, B: 1, C: 0 },
      },
      { id: 'C#1', kind: 'remove' as const, zone: 'Z1', ctx: { A: 1, B: 1, C: 1 } },
      {
        id: 'A#2',
        kind: 'add' as const,
        dot: 'D3',
        tag: { zone: 'Z1', lat: 3, lng: 3, radiusKm: 1 },
        ctx: { A: 2, B: 1, C: 1 },
      },
    ];
    const inbox: Record<string, string[]> = {
      A: messages.map((m) => m.id),
      B: messages.map((m) => m.id),
      C: messages.map((m) => m.id),
    };
    const t0 = Date.now();
    const r = runAudit({ terminals: terms, messages, inbox }, {
      zone: 'Z1',
      terminals: terms,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps).toHaveLength(12);
    for (const t of terms) {
      expect(r.terminalPlans[t].slice().sort()).toEqual(messages.map((m) => m.id).sort());
    }
    // 分歧步数在合法界内且末态收敛（OR-Set：全员收到全量脚本）
    expect(r.divergenceSteps).toBeGreaterThanOrEqual(0);
    expect(r.divergenceSteps).toBeLessThanOrEqual(12);
    expect(r.converged).toBe(true);
    // 逐步快照内部自洽：divergent 与各终端 zoneValid 一致
    for (const s of r.steps) {
      const vals = terms.map((t) => s.stateAfter[t].zoneValid);
      const expected = vals.slice(1).some((v) => v !== vals[0]);
      expect(s.divergent).toBe(expected);
    }
  });
});
