import { describe, expect, it } from 'vitest';
import { runReplay } from '../src/crdt/replay';
import type { TerminalView } from '../src/crdt/types';
import { SAMPLES } from '../src/samples';

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

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 独立复核：末步快照中所有终端的有效标签一致且暂存清空 */
function assertConvergedIndependently(
  terminals: string[],
  stateAfter: Record<string, TerminalView>,
) {
  const zoneSets = terminals.map((t) => JSON.stringify(stateAfter[t].zones.map((z) => z.zone)));
  expect(new Set(zoneSets).size).toBe(1);
  for (const t of terminals) expect(stateAfter[t].pending).toEqual([]);
}

describe('回放：收敛、暂存释放、重复幂等', () => {
  it('样例1：并发新增与撤销收敛（add-wins）', () => {
    const r = runReplay(SAMPLES[0].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-ALPHA', 'Z-BETA']);
    // A#2 的撤销只见过 A#1：B#1 的并发点 D-02 必须存活
    const last = r.steps[r.steps.length - 1].stateAfter;
    for (const t of r.terminals) {
      const alpha = last[t].zones.find((z) => z.zone === 'Z-ALPHA');
      expect(alpha?.dots.map((d) => d.dot)).toEqual(['D-02']);
    }
    assertConvergedIndependently(r.terminals, last);
    // 该样例中 B、C 均出现乱序暂存并随后释放
    expect(r.steps.some((s) => s.action === 'buffered' && s.messageId === 'A#2')).toBe(true);
    expect(r.steps.some((s) => s.action === 'released' && s.messageId === 'A#2')).toBe(true);
    expect(r.steps.some((s) => s.action === 'released' && s.messageId === 'C#1')).toBe(true);
  });

  it('样例2：乱序暂存释放后收敛', () => {
    const r = runReplay(SAMPLES[1].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-SOUTH']);
    // B#2 在 A、B 两台都先缺前序被暂存，随后被释放
    for (const t of ['A', 'B']) {
      const buffered = r.steps.find(
        (s) => s.terminal === t && s.messageId === 'B#2' && s.action === 'buffered',
      );
      const released = r.steps.find(
        (s) => s.terminal === t && s.messageId === 'B#2' && s.action === 'released',
      );
      expect(buffered, `终端 ${t} 应暂存 B#2`).toBeDefined();
      expect(released, `终端 ${t} 应释放 B#2`).toBeDefined();
      expect(released!.index).toBeGreaterThan(buffered!.index);
    }
    assertConvergedIndependently(r.terminals, r.steps[r.steps.length - 1].stateAfter);
  });

  it('样例3：重复投递幂等且四终端收敛', () => {
    const r = runReplay(SAMPLES[2].data);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.converged).toBe(true);
    expect(r.finalZones).toEqual(['Z-1', 'Z-2']);
    const dups = r.steps.filter((s) => s.action === 'duplicate');
    expect(dups.length).toBeGreaterThanOrEqual(3);
    // 每个重复步骤前后，版本向量 / 有效标签 / 暂存队列完全不变
    const pick = (snap: Record<string, TerminalView>) =>
      Object.fromEntries(
        Object.entries(snap).map(([k, v]) => [
          k,
          { vector: v.vector, zones: v.zones, pending: v.pending },
        ]),
      );
    for (const d of dups) {
      const prev = r.steps[d.index - 1];
      expect(prev, '重复步骤之前应已有其他步骤').toBeDefined();
      expect(pick(d.stateAfter)).toEqual(pick(prev.stateAfter));
    }
    assertConvergedIndependently(r.terminals, r.steps[r.steps.length - 1].stateAfter);
  });

  it('任意乱序收件（含重复）均收敛到同一结果', () => {
    for (let iter = 0; iter < 20; iter += 1) {
      const rnd = mulberry32(iter + 1);
      const clone = structuredClone(SAMPLES[2].data) as {
        terminals: string[];
        inbox: Record<string, string[]>;
      };
      for (const t of clone.terminals) clone.inbox[t] = shuffle(clone.inbox[t], rnd);
      const r = runReplay(clone);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.converged, `第 ${iter} 轮乱序应收敛`).toBe(true);
      expect(r.finalZones).toEqual(['Z-1', 'Z-2']);
    }
  });

  it('回放是确定性的：同一场景两次运行结果一致', () => {
    const a = runReplay(SAMPLES[0].data);
    const b = runReplay(SAMPLES[0].data);
    expect(a).toEqual(b);
  });

  it('非法场景整体拒绝且不产生步骤', () => {
    const bad = structuredClone(SAMPLES[0].data) as {
      messages: Array<{ id: string; dot?: string }>;
    };
    bad.messages[1].dot = 'D-01'; // B#1 复用 A#1 的点标识，但载荷（Z-ALPHA 不同坐标）不同
    const r = runReplay(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.message.includes('点标识复用'))).toBe(true);
    expect('steps' in r).toBe(false);
  });
});
