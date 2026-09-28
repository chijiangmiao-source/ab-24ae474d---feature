import { describe, expect, it } from 'vitest';
import { Replica } from '../src/crdt/engine';
import type { AddMessage, RemoveMessage } from '../src/crdt/types';

const TERMINALS = ['A', 'B', 'C'];

function add(id: string, dot: string, zone: string, ctx: Record<string, number>): AddMessage {
  const [from, seq] = id.split('#');
  return {
    kind: 'add',
    id,
    from,
    seq: Number(seq),
    dot,
    tag: { zone, lat: 0, lng: 0, radiusKm: 1 },
    ctx,
  };
}

function remove(id: string, zone: string, ctx: Record<string, number>): RemoveMessage {
  const [from, seq] = id.split('#');
  return { kind: 'remove', id, from, seq: Number(seq), zone, ctx };
}

describe('副本引擎', () => {
  it('应用新增并推进版本向量', () => {
    const r = new Replica('A', TERMINALS);
    const res = r.deliver(add('A#1', 'D1', 'Z1', { A: 1 }));
    expect(res.action).toBe('applied');
    expect(r.vector).toEqual({ A: 1, B: 0, C: 0 });
    const view = r.view(1, 1);
    expect(view.zones.map((z) => z.zone)).toEqual(['Z1']);
    expect(view.zones[0].dots[0].dot).toBe('D1');
  });

  it('缺少发送方前序时暂存，补齐后级联释放', () => {
    const r = new Replica('X', TERMINALS);
    const b2 = add('B#2', 'D2', 'Z2', { B: 2 });
    const b1 = add('B#1', 'D1', 'Z1', { B: 1 });

    const first = r.deliver(b2);
    expect(first.action).toBe('buffered');
    expect(first.reason).toContain('B#1');
    expect(r.pendingList.map((m) => m.id)).toEqual(['B#2']);

    const second = r.deliver(b1);
    expect(second.action).toBe('applied');
    expect(second.releases.map((x) => x.msg.id)).toEqual(['B#2']);
    expect(r.pendingList).toHaveLength(0);
    expect(r.vector.B).toBe(2);
  });

  it('缺少跨终端因果依赖时暂存，依赖到达后释放', () => {
    const r = new Replica('X', TERMINALS);
    const c1 = add('C#1', 'DC', 'ZC', { C: 1 });
    const b1 = add('B#1', 'DB', 'ZB', { B: 1, C: 1 });

    expect(r.deliver(b1).action).toBe('buffered');
    const res = r.deliver(c1);
    expect(res.action).toBe('applied');
    expect(res.releases.map((x) => x.msg.id)).toEqual(['B#1']);
    expect(r.view(2, 2).zones.map((z) => z.zone)).toEqual(['ZB', 'ZC']);
  });

  it('重复投递不改变状态（幂等）', () => {
    const r = new Replica('X', TERMINALS);
    const a1 = add('A#1', 'D1', 'Z1', { A: 1 });
    r.deliver(a1);
    const before = r.view(1, 2);
    const dup = r.deliver(a1);
    expect(dup.action).toBe('duplicate');
    expect(dup.reason).toContain('重复投递');
    const after = r.view(2, 2);
    expect(after.vector).toEqual(before.vector);
    expect(after.zones).toEqual(before.zones);
    expect(after.pending).toEqual(before.pending);
  });

  it('暂存中的消息重复投递不重复入队', () => {
    const r = new Replica('X', TERMINALS);
    const b2 = add('B#2', 'D2', 'Z2', { B: 2 });
    expect(r.deliver(b2).action).toBe('buffered');
    const dup = r.deliver(b2);
    expect(dup.action).toBe('duplicate');
    expect(r.pendingList).toHaveLength(1);
  });

  it('撤销只清除产生时已观察到的点，并发新增保留', () => {
    const r = new Replica('X', TERMINALS);
    r.deliver(add('A#1', 'D1', 'Z1', { A: 1 }));
    r.deliver(add('B#1', 'D2', 'Z1', { B: 1 }));
    // C 只见过 A#1，未见过 B#1：撤销 Z1 只能清掉 D1
    const res = r.deliver(remove('C#1', 'Z1', { C: 1, A: 1 }));
    expect(res.action).toBe('applied');
    expect(res.effect).toContain('D1');
    const view = r.view(3, 3);
    expect(view.zones).toHaveLength(1);
    expect(view.zones[0].dots.map((d) => d.dot)).toEqual(['D2']);
  });

  it('撤销覆盖全部观测点时区域消失', () => {
    const r = new Replica('X', TERMINALS);
    r.deliver(add('A#1', 'D1', 'Z1', { A: 1 }));
    const res = r.deliver(remove('B#1', 'Z1', { B: 1, A: 1 }));
    expect(res.effect).toContain('D1');
    expect(r.view(2, 2).zones).toHaveLength(0);
  });

  it('撤销不存在的区域是合法空操作', () => {
    const r = new Replica('X', TERMINALS);
    const res = r.deliver(remove('A#1', 'Z-NOPE', { A: 1 }));
    expect(res.action).toBe('applied');
    expect(res.effect).toContain('空操作');
    expect(r.vector.A).toBe(1);
  });
});
