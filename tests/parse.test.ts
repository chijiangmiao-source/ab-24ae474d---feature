import { describe, expect, it } from 'vitest';
import { parseScenario } from '../src/crdt/parse';

const tag = (zone: string) => ({ zone, lat: 1, lng: 2, radiusKm: 1 });

interface RawScenario {
  terminals: string[];
  messages: Array<Record<string, unknown>>;
  inbox: Record<string, string[]>;
}

function base(): RawScenario {
  return {
    terminals: ['A', 'B'],
    messages: [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D2', tag: tag('Z2'), ctx: { B: 1 } },
    ],
    inbox: { A: ['A#1', 'B#1'], B: ['B#1', 'A#1'] },
  };
}

function expectRejected(s: unknown, needle: string) {
  const r = parseScenario(s);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(
      r.errors.some((e) => e.message.includes(needle)),
      `应包含错误「${needle}」，实际：${JSON.stringify(r.errors)}`,
    ).toBe(true);
  }
}

describe('场景校验', () => {
  it('接受合法场景并归一化上下文', () => {
    const r = parseScenario(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scenario.terminals).toEqual(['A', 'B']);
      expect(r.scenario.messagesById['A#1'].ctx).toEqual({ A: 1, B: 0 });
    }
  });

  it('拒绝终端标识冲突并定位', () => {
    const s = base();
    s.terminals = ['A', 'A'];
    expectRejected(s, '终端标识冲突');
  });

  it('拒绝终端数量越界（须 2-4 台）', () => {
    const s1 = base();
    s1.terminals = ['A'];
    expectRejected(s1, '2-4');
    const s5 = base();
    s5.terminals = ['A', 'B', 'C', 'D', 'E'];
    expectRejected(s5, '2-4');
  });

  it('拒绝未知终端的消息与非法事件标识', () => {
    const s = base();
    s.messages.push({ id: 'X#1', kind: 'add', dot: 'D9', tag: tag('Z9'), ctx: { X: 1 } });
    expectRejected(s, '未知终端');

    const s2 = base();
    s2.messages[0].id = 'A-1';
    expectRejected(s2, '非法消息标识');
  });

  it('拒绝不连续的消息链', () => {
    const s = base();
    s.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'A#3', kind: 'add', dot: 'D3', tag: tag('Z3'), ctx: { A: 3 } },
      { id: 'B#1', kind: 'add', dot: 'D2', tag: tag('Z2'), ctx: { B: 1 } },
    ];
    expectRejected(s, '不连续');
  });

  it('拒绝点标识复用但载荷不同，并定位双方', () => {
    const s = base();
    s.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D1', tag: tag('Z-DIFFERENT'), ctx: { B: 1 } },
    ];
    const r = parseScenario(s);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const e = r.errors.find((x) => x.message.includes('点标识复用'));
      expect(e).toBeDefined();
      expect(e!.message).toContain('A#1');
      expect(e!.message).toContain('B#1');
    }
  });

  it('允许点标识复用但载荷完全相同（重复广播）', () => {
    const s = base();
    s.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1 } },
      { id: 'B#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { B: 1 } },
    ];
    expect(parseScenario(s).ok).toBe(true);
  });

  it('拒绝非法上下文：自身序号不符', () => {
    const s = base();
    s.messages[0].ctx = { A: 2 };
    expectRejected(s, '自身序号');
  });

  it('拒绝非法上下文：引用未知终端 / 负值 / 观察未来 / 沿链回退', () => {
    const s1 = base();
    s1.messages[0].ctx = { A: 1, X: 1 };
    expectRejected(s1, '未知终端');

    const s2 = base();
    s2.messages[0].ctx = { A: 1, B: -1 };
    expectRejected(s2, '非负整数');

    const s3 = base();
    s3.messages[0].ctx = { A: 1, B: 5 };
    expectRejected(s3, '仅产生');

    const s4 = base();
    s4.messages = [
      { id: 'A#1', kind: 'add', dot: 'D1', tag: tag('Z1'), ctx: { A: 1, B: 0 } },
      { id: 'B#1', kind: 'add', dot: 'D2', tag: tag('Z2'), ctx: { B: 1 } },
      { id: 'A#2', kind: 'remove', zone: 'Z2', ctx: { A: 2, B: 1 } },
      { id: 'A#3', kind: 'remove', zone: 'Z1', ctx: { A: 3 } },
    ];
    s4.inbox = {
      A: ['A#1', 'A#2', 'A#3', 'B#1'],
      B: ['B#1', 'A#1', 'A#2', 'A#3'],
    };
    expectRejected(s4, '回退');
  });

  it('拒绝非法收件顺序：未知消息 / 缺少终端 / 覆盖不全', () => {
    const s1 = base();
    s1.inbox.A = ['A#1', 'B#9'];
    expectRejected(s1, '未知消息标识');

    const s2 = base();
    s2.inbox = { A: ['A#1', 'B#1'] };
    expectRejected(s2, '缺少收件顺序');

    const s3 = base();
    s3.inbox = { A: ['A#1'], B: ['A#1', 'B#1'] };
    expectRejected(s3, '未覆盖消息 B#1');
  });

  it('允许撤销从未新增的区域（合法空操作）', () => {
    const s = base();
    s.messages.push({ id: 'A#2', kind: 'remove', zone: 'Z-NOPE', ctx: { A: 2 } });
    s.inbox.A = ['A#1', 'A#2', 'B#1'];
    s.inbox.B = ['B#1', 'A#1', 'A#2'];
    expect(parseScenario(s).ok).toBe(true);
  });
});
