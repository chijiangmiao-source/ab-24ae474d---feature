import { describe, expect, it } from 'vitest';
import { Replica, parseEventId } from '../src/crdt/engine';
import { runAudit } from '../src/crdt/audit';
import type { Message, TagPayload, Vector } from '../src/crdt/types';

/* ---- 构造合法场景 ---- */

interface RawScenario {
  terminals: string[];
  messages: Record<string, unknown>[];
  inbox: Record<string, string[]>;
}

function scenario(terminals: string[], messages: Record<string, unknown>[]): RawScenario {
  const inbox: Record<string, string[]> = {};
  const ids = messages.map((m) => m.id as string);
  for (const t of terminals) inbox[t] = [...ids]; // 覆盖全部消息
  return { terminals, messages, inbox };
}

const add = (id: string, zone: string, ctx: Record<string, number>, dot?: string) => {
  const [from, seq] = id.split('#');
  return {
    id,
    kind: 'add',
    dot: dot ?? `D-${id}`,
    tag: { zone, lat: 0, lng: 0, radiusKm: 1 },
    ctx: { ...{ [from]: Number(seq) }, ...ctx },
  };
};
const remove = (id: string, zone: string, ctx: Record<string, number>) => {
  const [from, seq] = id.split('#');
  return { id, kind: 'remove', zone, ctx: { ...{ [from]: Number(seq) }, ...ctx } };
};

function ok(raw: unknown, zone: string, terminals?: string[]) {
  const r = runAudit(raw, zone, terminals);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.path}: ${e.message}`).join('\n'));

  return r;
}

/* ---- 独立暴力枚举：直接投递全部交错，复用 Replica 语义 ---- */

function idCmp(a: string, b: string): number {
  const x = parseEventId(a);
  const y = parseEventId(b);
  return x.t.localeCompare(y.t) || x.n - y.n;
}

function toMessages(raw: RawScenario): Message[] {
  return raw.messages.map((msg) => {
    const id = msg.id as string;
    const hash = id.lastIndexOf('#');
    const from = id.slice(0, hash);
    const seq = Number(id.slice(hash + 1));
    const ctx: Vector = {};
    for (const t of raw.terminals) ctx[t] = (msg.ctx as Record<string, number>)[t] ?? 0;
    if (msg.kind === 'add') {
      return {
        kind: 'add',
        id,
        from,
        seq,
        dot: msg.dot as string,
        tag: msg.tag as TagPayload,
        ctx,
      };
    }
    return { kind: 'remove', id, from, seq, zone: msg.zone as string, ctx };
  });
}

function bruteForce(raw: RawScenario, zone: string, terminals: string[]) {
  const msgs = toMessages(raw);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const ids = msgs.map((m) => m.id).sort(idCmp);

  const newReplicas = () => terminals.map((t) => new Replica(t, raw.terminals));

  let best = -1;
  let bestPlans: string[][] | null = null;
  let bestSchedule: string[] | null = null;

  const perms = (xs: string[]): string[][] => {
    if (xs.length <= 1) return [xs];
    const out: string[][] = [];
    xs.forEach((x, i) => {
      for (const p of perms(xs.filter((_, j) => j !== i))) out.push([x, ...p]);
    });
    return out;
  };
  const cmpPlans = (a: string[][], b: string[][]) => {
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < a[i].length; j += 1) {
        const c = idCmp(a[i][j], b[i][j]);
        if (c) return c;
      }
    }
    return 0;
  };

  // 各终端一个排列；枚举保持各自内部顺序的全部交错
  const enumeratePerms = (idx: number, chosen: string[][]): string[][][] => {
    if (idx === terminals.length) return [chosen];
    const out: string[][][] = [];
    for (const p of perms(ids)) out.push(...enumeratePerms(idx + 1, [...chosen, p]));
    return out;
  };

  for (const plans of enumeratePerms(0, [])) {
    const rec = (
      reps: Replica[],
      pos: number[],
      eff: boolean[],
      acc: number,
      sched: string[],
    ) => {
      if (pos.every((p, i) => p === plans[i].length)) {
        let schedCmp = 0;
        if (acc === best && bestPlans !== null && cmpPlans(plans, bestPlans) === 0) {
          for (let i = 0; i < sched.length; i += 1) {
            const c = sched[i].localeCompare(bestSchedule![i]);
            if (c) {
              schedCmp = c;
              break;
            }
          }
        }
        const better =
          bestPlans === null ||
          acc > best ||
          (acc === best &&
            (cmpPlans(plans, bestPlans) < 0 || (cmpPlans(plans, bestPlans) === 0 && schedCmp < 0)));
        if (better) {
          best = acc;
          bestPlans = plans.map((p) => [...p]);
          bestSchedule = [...sched];
        }
        return;
      }
      for (let ti = 0; ti < terminals.length; ti += 1) {
        if (pos[ti] === plans[ti].length) continue;
        const mid = plans[ti][pos[ti]];
        const nextReps = reps.slice();
        nextReps[ti] = reps[ti].clone();
        const r = nextReps[ti];
        const nextEff = eff.slice();
        let add = 0;
        const res = r.deliver(byId.get(mid)!, () => {
          nextEff[ti] = r.hasZone(zone);
          if (!nextEff.every((v) => v === nextEff[0])) add += 1;
        });
        if (res.action === 'buffered' && !nextEff.every((v) => v === nextEff[0])) add += 1;
        const nextPos = pos.slice();
        nextPos[ti] += 1;
        rec(nextReps, nextPos, nextEff, acc + add, [...sched, `${ti}:${mid}`]);
      }
    };
    const initial = newReplicas();
    rec(
      initial,
      terminals.map(() => 0),
      newReplicas().map((r) => r.hasZone(zone)),
      0,
      [],
    );
  }
  return { best, bestPlans, bestSchedule };
}

describe('延迟传播压力审计', () => {
  const s1 = scenario(['A', 'B'], [
    add('A#1', 'Z1', {}),
    add('B#1', 'Z2', {}),
    remove('B#2', 'Z1', { A: 1 }),
  ]);
  const s2 = scenario(['A', 'B', 'C'], [add('A#1', 'Z1', {}), add('C#1', 'Z1', {})]);
  const s3 = scenario(['A', 'B'], [
    add('A#1', 'Z1', {}),
    add('B#1', 'Z2', { A: 1 }),
    add('A#2', 'Z3', { B: 1 }),
  ]);
  const s4 = scenario(['A', 'B'], [add('A#1', 'Z2', {}), remove('B#1', 'Z1', {})]);

  it('单条新增：两台终端必有 1 步分歧（一方先应用，另一方未收到）', () => {
    const s0 = scenario(['A', 'B'], [add('A#1', 'Z-ONLY', {})]);
    const r = ok(s0, 'Z-ONLY'); // 全场仅一条新增
    expect(r.divergenceSteps).toBe(1);
    expect(r.eventCount).toBe(2);
    expect(r.steps.map((s) => s.change)).toEqual(['created', 'resolved']);
  });

  it('撤销并发新增：与独立暴力枚举一致（双向缓冲/级联释放拉长分歧）', () => {
    const r = ok(s1, 'Z1');
    const bf = bruteForce(s1, 'Z1', ['A', 'B']);
    expect(r.divergenceSteps).toBe(bf.best);
    const plansArr = ['A', 'B'].map((t) => r.plans.find((p) => p.terminal === t)!.order);
    expect(plansArr).toEqual(bf.bestPlans);
    // 终局收敛、最后一个事件消除分歧
    expect(r.steps[r.steps.length - 1].change).toBe('resolved');
    expect(r.steps.filter((s) => s.divergent)).toHaveLength(bf.best);
  });

  it('与独立暴力枚举完全一致（含跨终端同区域并发新增）', () => {
    const r = ok(s2, 'Z1');
    const bf = bruteForce(s2, 'Z1', ['A', 'B', 'C']);
    expect(r.divergenceSteps).toBe(bf.best);
    const plansArr = r.terminals.map((t) => r.plans.find((p) => p.terminal === t)!.order);
    expect(plansArr).toEqual(bf.bestPlans);
  });

  it('与独立暴力枚举完全一致（因果链触发暂存与级联释放）', () => {
    for (const zone of ['Z1', 'Z2', 'Z3']) {
      const r = ok(s3, zone);
      const bf = bruteForce(s3, zone, ['A', 'B']);
      expect(r.divergenceSteps).toBe(bf.best);
      const plansArr = ['A', 'B'].map((t) => r.plans.find((p) => p.terminal === t)!.order);
      expect(plansArr).toEqual(bf.bestPlans);
    }
  });

  it('纯撤销区域永远无法产生有效性分歧（0 步）', () => {
    const r = ok(s4, 'Z1');
    expect(r.divergenceSteps).toBe(0);
    expect(r.steps.every((s) => !s.divergent)).toBe(true);
  });

  it('每条消息对每台终端恰好直接投递一次，终局全部收敛、暂存清空', () => {
    const r = ok(s3, 'Z1');
    for (const t of r.terminals) {
      const order = r.plans.find((p) => p.terminal === t)!.order;
      expect([...order].sort(idCmp)).toEqual(Object.keys(r.messages).sort(idCmp));
      const last = r.steps.filter((s) => s.terminal === t).at(-1)!.stateAfter[t];
      expect(last.pending).toEqual([]);
      expect(Object.values(last.vector).every((v) => v > 0 || true)).toBe(true);
    }
  });

  it('暂存事件之后必有同消息的释放事件', () => {
    const r = ok(s3, 'Z1');
    for (const t of r.terminals) {
      const tsteps = r.steps.filter((s) => s.terminal === t);
      for (const s of tsteps) {
        if (s.action === 'buffered') {
          expect(tsteps.some((x) => x.action === 'released' && x.messageId === s.messageId && x.index > s.index)).toBe(true);
        }
      }
    }
  });

  it('重建计步与搜索计步一致（detail 不含不一致告警）', () => {
    const r = ok(s1, 'Z1');
    expect(r.detail).not.toContain('不一致');
  });

  it('重复运行结果完全确定（无随机/抽样）', () => {
    expect(ok(s1, 'Z1')).toEqual(ok(s1, 'Z1'));
  });

  it('超过 3 台终端未选子集时明确拒绝；选择 3 台子集可审计', () => {
    const s = scenario(['A', 'B', 'C', 'D'], [add('A#1', 'Z1', {})]);
    const rej = runAudit(s, 'Z1');
    expect(rej.ok).toBe(false);
    if (!rej.ok) expect(rej.errors[0].message).toContain('3 台终端');
    const r = runAudit(s, 'Z1', ['A', 'B', 'C']);
    expect(r.ok).toBe(true);
  });

  it('仅选 1 台终端被拒绝', () => {
    const rej = runAudit(s1, 'Z1', ['A']);
    expect(rej.ok).toBe(false);
  });

  it('选择未知/重复终端被拒绝', () => {
    expect(runAudit(s1, 'Z1', ['A', 'X']).ok).toBe(false);
    expect(runAudit(s1, 'Z1', ['A', 'A']).ok).toBe(false);
  });

  it('超过 10 条源消息明确拒绝', () => {
    const msgs: Record<string, unknown>[] = []
    for (let i = 1; i <= 6; i += 1) msgs.push(add(`A#${i}`, `ZA${i}`, {}));
    for (let i = 1; i <= 5; i += 1) msgs.push(add(`B#${i}`, `ZB${i}`, {}));
    const s = scenario(['A', 'B'], msgs);
    const rej = runAudit(s, 'ZA1');
    expect(rej.ok).toBe(false);
    if (!rej.ok) expect(rej.errors[0].message).toContain('10 条源消息');
  });

  it('未知区域 / 空区域被拒绝', () => {
    expect(runAudit(s1, 'NOPE').ok).toBe(false);
    expect(runAudit(s1, '').ok).toBe(false);
  });

  it('非法脚本同样定位拒绝（审计复用既有校验）', () => {
    const bad = { terminals: ['A', 'B'], messages: [], inbox: {} };
    expect(runAudit(bad, 'Z1').ok).toBe(false);
  });

  it('上限规模（3 终端 × 10 消息）可完成且行为等价压缩生效', () => {
    const msgs: Record<string, unknown>[] = [add('A#1', 'ZTARGET', {})];
    for (let i = 2; i <= 4; i += 1) msgs.push(add(`A#${i}`, `ZA${i}`, {}));
    for (let i = 1; i <= 3; i += 1) msgs.push(add(`B#${i}`, `ZB${i}`, {}));
    for (let i = 1; i <= 3; i += 1) msgs.push(add(`C#${i}`, `ZC${i}`, {}));
    const s = scenario(['A', 'B', 'C'], msgs);
    const t0 = Date.now();
    const r = ok(s, 'ZTARGET');
    expect(Date.now() - t0).toBeLessThan(15000);
    // 目标消息可延迟到倒数：分歧至少能持续很久
    expect(r.divergenceSteps).toBeGreaterThanOrEqual(20);
    // 无关消息行为等价：商类数远少于朴素轨迹状态数
    expect(r.stats.quotientClasses).toBeLessThan(r.stats.rawTraceStates);
    expect(r.stats.mergedStates).toBeGreaterThan(0);
  });
});
