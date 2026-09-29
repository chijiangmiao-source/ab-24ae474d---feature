import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/crdt/audit';

describe('审计最坏规模性能', () => {
  it('3 终端 × 10 消息：无跨终端依赖、区域有效性频繁翻转', () => {
    // 每条消息独立（无跨终端依赖），掩码组合全部可达，构成最松剪枝情形。
    // 交替 add / remove 同一区域，使 zoneValid 在大量掩码下取不同值。
    const terms = ['A', 'B', 'C'];
    const messages = [];
    // 三条独立链（A:4, B:3, C:3 = 10），互相不引用
    const per: Record<string, number> = { A: 4, B: 3, C: 3 };
    let k = 0;
    for (const t of terms) {
      for (let s = 1; s <= per[t]; s += 1) {
        k += 1;
        if (k % 2 === 1) {
          messages.push({
            id: `${t}#${s}`,
            kind: 'add' as const,
            dot: `D-${t}-${s}`,
            tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
            ctx: { [t]: s },
          });
        } else {
          // remove 只清自己产生方的点（ctx[t]=s 自身链前序），制造频繁翻转
          messages.push({
            id: `${t}#${s}`,
            kind: 'remove' as const,
            zone: 'Z1',
            ctx: { [t]: s },
          });
        }
      }
    }
    const inbox: Record<string, string[]> = {};
    for (const t of terms) inbox[t] = messages.map((m) => m.id);
    const sc = { terminals: terms, messages, inbox };

    const t0 = Date.now();
    const r = runAudit(sc, { zone: 'Z1', terminals: terms });
    const ms = Date.now() - t0;
    console.log('worst-case ms =', ms, 'statesEvaluated =', r.ok ? r.stats.statesEvaluated : '-',
      'memoHits =', r.ok ? r.stats.memoHits : '-',
      'div =', r.ok ? `${r.divergenceSteps}/${r.totalDeliveries}` : JSON.stringify(r.ok ? '' : r.errors));
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(2000);
  }, 30000);

  it('3 终端 × 10 消息：全部新增同区域（有效性单调，剪枝应极强）', () => {
    const terms = ['A', 'B', 'C'];
    const messages = [];
    const per: Record<string, number> = { A: 4, B: 3, C: 3 };
    for (const t of terms) {
      for (let s = 1; s <= per[t]; s += 1) {
        messages.push({
          id: `${t}#${s}`,
          kind: 'add' as const,
          dot: `D-${t}-${s}`,
          tag: { zone: 'Z1', lat: 1, lng: 1, radiusKm: 1 },
          ctx: { [t]: s },
        });
      }
    }
    const inbox: Record<string, string[]> = {};
    for (const t of terms) inbox[t] = messages.map((m) => m.id);
    const t0 = Date.now();
    const r = runAudit({ terminals: terms, messages, inbox }, { zone: 'Z1', terminals: terms });
    const ms = Date.now() - t0;
    console.log('monotone ms =', ms, 'states =', r.ok ? r.stats.statesEvaluated : '-');
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(2000);
  }, 30000);
});
