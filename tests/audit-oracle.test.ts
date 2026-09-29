import { describe, expect, it } from 'vitest';
import { Replica } from '../src/crdt/engine';
import { runAudit } from '../src/crdt/audit';
import type { Message } from '../src/crdt/types';

/**
 * 审计算法的独立预言机测试：
 * 用不剪枝的掩码格 DP 暴力求最优分歧步数与字典序最小方案，与 runAudit 交叉核对；
 * 覆盖记忆化分支限界（区间缓存、全局现任、可采纳上界）在数百个随机因果场景上的正确性。
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RMsg {
  id: string;
  kind: 'add' | 'remove';
  from: string;
  seq: number;
  dot?: string;
  tag?: { zone: string; lat: number; lng: number; radiusKm: number };
  zone?: string;
  ctx: Record<string, number>;
}

function genScenario(rnd: () => number, terms: string[], M: number) {
  const chainLen = Object.fromEntries(terms.map((t) => [t, 0]));
  const lastCtx: Record<string, Record<string, number>> = Object.fromEntries(
    terms.map((t) => [t, Object.fromEntries(terms.map((u) => [u, 0]))]),
  );
  const messages: RMsg[] = [];
  let dotN = 0;
  for (let k = 0; k < M; k += 1) {
    const from = terms[Math.floor(rnd() * terms.length)];
    const seq = chainLen[from] + 1;
    const ctx = Object.fromEntries(terms.map((t) => [t, 0]));
    for (const t of terms) {
      if (t === from) ctx[t] = seq;
      else ctx[t] = lastCtx[from][t] + Math.floor(rnd() * (chainLen[t] - lastCtx[from][t] + 1));
    }
    if (rnd() < 0.4) {
      messages.push({ id: `${from}#${seq}`, kind: 'remove', from, seq, zone: 'Z1', ctx });
    } else {
      dotN += 1;
      messages.push({
        id: `${from}#${seq}`,
        kind: 'add',
        from,
        seq,
        dot: `D-${dotN}`,
        tag: { zone: rnd() < 0.7 ? 'Z1' : 'Z2', lat: 1, lng: 1, radiusKm: 1 },
        ctx,
      });
    }
    chainLen[from] = seq;
    for (const t of terms) lastCtx[from][t] = ctx[t];
  }
  const inbox: Record<string, string[]> = {};
  for (const t of terms) inbox[t] = messages.map((m) => m.id);
  return { terminals: terms, messages: messages as Message[], inbox };
}

function deliversAll(sc: ReturnType<typeof genScenario>): boolean {
  for (const t of sc.terminals) {
    const rep = new Replica(t, sc.terminals);
    for (const m of sc.messages) rep.deliver(m);
    if (rep.pendingList.length !== 0) return false;
  }
  return true;
}

/** 无剪枝预言机：掩码格 DP，返回最大分歧步数与字典序最小完整方案 */
function oracle(sc: ReturnType<typeof genScenario>, zone: string, terms: string[]) {
  const msgs = [...sc.messages].sort((a, b) => (a.id < b.id ? -1 : 1));
  const M = msgs.length;
  const T = terms.length;
  const ts = [...terms].sort();
  const N = 1 << M;
  const full = N - 1;
  const V = new Uint8Array(N);
  for (let s = 0; s < N; s += 1) {
    const rep = new Replica('__oracle__', sc.terminals);
    // 按标识顺序投递（合法拓扑序；就绪者应用并可能触发级联释放，未就绪者暂存）
    for (let i = 0; i < M; i += 1) {
      if (s & (1 << i)) rep.deliver(msgs[i]);
    }
    V[s] = rep.view(0, 0).zones.some((z) => z.zone === zone) ? 1 : 0;
  }
  const keyOf = (masks: number[]) =>
    masks.reduce((acc, mk, t) => (acc | (mk << (t * M))) >>> 0, 0);
  const memo = new Map<number, { score: number; path: Array<[string, string]> }>();
  const solve = (key: number): { score: number; path: Array<[string, string]> } => {
    const c = memo.get(key);
    if (c) return c;
    const masks: number[] = [];
    let k = key >>> 0;
    for (let t = 0; t < T; t += 1) {
      masks.push(k & full);
      k = k >>> M;
    }
    if (masks.every((mk) => mk === full)) {
      const leaf = { score: 0, path: [] as Array<[string, string]> };
      memo.set(key, leaf);
      return leaf;
    }
    let best: { score: number; path: Array<[string, string]> } | null = null;
    for (let ti = 0; ti < T; ti += 1) {
      for (let mi = 0; mi < M; mi += 1) {
        const bit = 1 << mi;
        if (masks[ti] & bit) continue;
        const child = [...masks];
        child[ti] |= bit;
        const v0 = V[child[0]];
        const reward = child.slice(1).some((mk) => V[mk] !== v0) ? 1 : 0;
        const sub = solve(keyOf(child));
        const cand = {
          score: reward + sub.score,
          path: [[ts[ti], msgs[mi].id], ...sub.path] as Array<[string, string]>,
        };
        if (!best || cand.score > best.score) best = cand;
      }
    }
    memo.set(key, best!);
    return best!;
  };
  return solve(0);
}

describe('审计 × 暴力预言机（精确性守护）', () => {
  it('2 终端 / 2-5 条：最优值与同分裁决路径一致', () => {
    let cases = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const rnd = mulberry32(seed * 7919 + 13);
      const terms = ['A', 'B'];
      const M = 2 + Math.floor(rnd() * 4);
      const sc = genScenario(rnd, terms, M);
      if (!deliversAll(sc)) continue;
      const zones = new Set(
        sc.messages.filter((m) => m.kind === 'add').map((m) => m.tag!.zone),
      );
      if (!zones.has('Z1')) continue;
      const r = runAudit(sc, { zone: 'Z1', terminals: terms });
      expect(r.ok, `seed=${seed}`).toBe(true);
      if (!r.ok) continue;
      const o = oracle(sc, 'Z1', terms);
      expect(r.divergenceSteps, `seed=${seed} M=${M} 最优值`).toBe(o.score);
      expect(r.steps.map((s) => `${s.terminal}:${s.messageId}`), `seed=${seed} 裁决路径`).toEqual(
        o.path.map(([t, id]) => `${t}:${id}`),
      );
      cases += 1;
    }
    expect(cases).toBeGreaterThan(50);
  });

  it('3 终端 / 2-4 条：最优值与同分裁决路径一致', () => {
    let cases = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const rnd = mulberry32(seed * 104729 + 7);
      const terms = ['A', 'B', 'C'];
      const M = 2 + Math.floor(rnd() * 3);
      const sc = genScenario(rnd, terms, M);
      if (!deliversAll(sc)) continue;
      const zones = new Set(
        sc.messages.filter((m) => m.kind === 'add').map((m) => m.tag!.zone),
      );
      if (!zones.has('Z1')) continue;
      const r = runAudit(sc, { zone: 'Z1', terminals: terms });
      expect(r.ok, `seed=${seed}`).toBe(true);
      if (!r.ok) continue;
      const o = oracle(sc, 'Z1', terms);
      expect(r.divergenceSteps, `seed=${seed} M=${M} 最优值`).toBe(o.score);
      expect(r.steps.map((s) => `${s.terminal}:${s.messageId}`)).toEqual(
        o.path.map(([t, id]) => `${t}:${id}`),
      );
      cases += 1;
    }
    expect(cases).toBeGreaterThan(30);
  });

  it('3 终端 / 5 条：更大状态空间仍一致', () => {
    let cases = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const rnd = mulberry32(seed * 15485863 + 1);
      const terms = ['A', 'B', 'C'];
      const sc = genScenario(rnd, terms, 5);
      if (!deliversAll(sc)) continue;
      const zones = new Set(
        sc.messages.filter((m) => m.kind === 'add').map((m) => m.tag!.zone),
      );
      if (!zones.has('Z1')) continue;
      const r = runAudit(sc, { zone: 'Z1', terminals: terms });
      expect(r.ok, `seed=${seed}`).toBe(true);
      if (!r.ok) continue;
      const o = oracle(sc, 'Z1', terms);
      expect(r.divergenceSteps, `seed=${seed} 最优值`).toBe(o.score);
      cases += 1;
    }
    expect(cases).toBeGreaterThan(10);
  });
});
