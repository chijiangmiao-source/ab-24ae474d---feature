import type { AddMessage, Message, TerminalView, Vector, ZoneView } from './types';

export interface ReleasedApply {
  msg: Message;
  reason: string;
  effect: string;
  /** false=暂存队列级联释放；true=本次直接投递的消息本身 */
  direct: boolean;
}

export interface DeliverResult {
  action: 'applied' | 'duplicate' | 'buffered';
  reason: string;
  effect: string;
  /** 本次应用触发暂存队列释放的消息（按释放顺序，不含直接投递本身） */
  releases: ReleasedApply[];
}

/** 每发生一次实际应用（直接投递或暂存释放）、状态已变更后回调一次 */
export type ApplyVisitor = (e: ReleasedApply) => void;

export function parseEventId(id: string): { t: string; n: number } {
  const i = id.lastIndexOf('#');
  return { t: id.slice(0, i), n: Number(id.slice(i + 1)) };
}

/**
 * 单台终端副本：OR-Set 点集 + 版本向量 + 因果暂存队列。
 *
 * 归并规则（observed-remove）：
 * - add：把 (zone, 事件id) 加入点集；同一事件重复到达不产生任何变化（幂等）。
 * - remove(zone, ctx)：仅清除点集中被 ctx 覆盖（产生时已观察到）的事件点；
 *   并发新增（不在 ctx 内）的点保留，即“未见过的并发新增不被误删”。
 *
 * 因果投递规则：
 * - 来自 F 的第 n 条消息可应用当且仅当 vector[F] === n-1，
 *   且对所有其他终端 U 有 vector[U] >= ctx[U]；
 * - 不满足则进入暂存队列，待依赖补齐后按就绪顺序释放；
 * - vector[F] >= n 或已在暂存队列中的再次投递判为重复，状态不变。
 */
export class Replica {
  readonly id: string;
  private readonly terminals: string[];
  readonly vector: Vector;
  /** zone -> (事件id -> 新增消息)，即 OR-Set 的存活点集 */
  private live = new Map<string, Map<string, AddMessage>>();
  /** 因果暂存队列（到达顺序） */
  readonly pendingList: Message[] = [];

  constructor(id: string, terminals: string[]) {
    this.id = id;
    this.terminals = terminals;
    this.vector = {};
    for (const t of terminals) this.vector[t] = 0;
  }

  /** 列出消息当前未满足的因果前序（空数组 = 就绪） */
  private missing(m: Message): string[] {
    const out: string[] = [];
    const vf = this.vector[m.from] ?? 0;
    if (vf < m.seq - 1) {
      const lo = `${m.from}#${vf + 1}`;
      const hi = m.seq - 1 > vf + 1 ? `…${m.from}#${m.seq - 1}` : '';
      out.push(`缺少发送方前序 ${lo}${hi}（本机 ${m.from}=${vf}）`);
    }
    for (const u of this.terminals) {
      if (u === m.from) continue;
      const need = m.ctx[u] ?? 0;
      if ((this.vector[u] ?? 0) < need) {
        out.push(`缺少因果依赖 ${u}#${need}（本机 ${u}=${this.vector[u] ?? 0}）`);
      }
    }
    return out;
  }

  private readyReason(m: Message): string {
    const head =
      m.seq === 1 ? `发送方首条事件` : `发送方前序 ${m.from}#${m.seq - 1} 已应用`;
    const deps: string[] = [];
    for (const u of this.terminals) {
      if (u === m.from) continue;
      const need = m.ctx[u] ?? 0;
      if (need > 0) deps.push(`${u}≥${need}（本机 ${this.vector[u] ?? 0}）`);
    }
    const tail = deps.length > 0 ? `依赖已满足：${deps.join('，')}` : `无其他因果依赖`;
    return `因果就绪：${head}；${tail}`;
  }

  /** 应用消息到点集，返回状态影响描述 */
  private apply(m: Message): string {
    if (m.kind === 'add') {
      let z = this.live.get(m.tag.zone);
      if (!z) {
        z = new Map();
        this.live.set(m.tag.zone, z);
      }
      z.set(m.id, m);
      return `新增标签 ${m.tag.zone}（点 ${m.dot}，半径 ${m.tag.radiusKm}km）`;
    }
    const z = this.live.get(m.zone);
    if (!z || z.size === 0) {
      return `撤销 ${m.zone}：本机无匹配观测点，空操作`;
    }
    const cleared: string[] = [];
    for (const [eid, add] of z) {
      const { t, n } = parseEventId(eid);
      if ((m.ctx[t] ?? 0) >= n) {
        cleared.push(`${add.dot}(${eid})`);
        z.delete(eid);
      }
    }
    if (z.size === 0) this.live.delete(m.zone);
    return cleared.length > 0
      ? `撤销 ${m.zone}：清除产生时已观测点 ${cleared.join('、')}`
      : `撤销 ${m.zone}：上下文未覆盖现存点，并发新增保留`;
  }

  deliver(m: Message, visit?: ApplyVisitor): DeliverResult {
    // 幂等：已应用过的事件再次投递不改变状态
    if ((this.vector[m.from] ?? 0) >= m.seq) {
      return {
        action: 'duplicate',
        reason: `重复投递：${m.id} 已应用（本机 ${m.from}=${this.vector[m.from]} ≥ ${m.seq}），状态不变`,
        effect: '',
        releases: [],
      };
    }
    if (this.pendingList.some((p) => p.id === m.id)) {
      return {
        action: 'duplicate',
        reason: `重复投递：${m.id} 已在暂存队列中，状态不变`,
        effect: '',
        releases: [],
      };
    }
    // 因果前序检查：缺失则暂存
    const miss = this.missing(m);
    if (miss.length > 0) {
      this.pendingList.push(m);
      return { action: 'buffered', reason: `暂存：${miss.join('；')}`, effect: '', releases: [] };
    }
    // 应用并推进版本向量
    const effect = this.apply(m);
    this.vector[m.from] = m.seq;
    const reason = this.readyReason(m);
    visit?.({ msg: m, reason, effect, direct: true });
    // 依赖补齐后释放暂存消息（可能级联）
    const releases: ReleasedApply[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.pendingList.length; i += 1) {
        const p = this.pendingList[i];
        if ((this.vector[p.from] ?? 0) >= p.seq) {
          this.pendingList.splice(i, 1);
          i -= 1;
          continue;
        }
        if (this.missing(p).length === 0) {
          this.pendingList.splice(i, 1);
          i -= 1;
          const eff = this.apply(p);
          this.vector[p.from] = p.seq;
          const relReason = `暂存解除（由 ${m.id} 的应用触发）：因果依赖已补齐`;
          const rel: ReleasedApply = { msg: p, reason: relReason, effect: eff, direct: false };
          releases.push(rel);
          visit?.(rel);
          progressed = true;
        }
      }
    }
    return { action: 'applied', reason, effect, releases };
  }

  /**
   * 深拷贝副本：消息对象不可变可共享，点集/暂存/向量独立。
   * 供压力审计在不同投递分支上复用同一前缀状态。
   */
  clone(): Replica {
    const r = new Replica(this.id, this.terminals);
    for (const t of this.terminals) r.vector[t] = this.vector[t] ?? 0;
    for (const [zone, adds] of this.live) {
      r.live.set(zone, new Map(adds));
    }
    r.pendingList.push(...this.pendingList);
    return r;
  }

  /** 该区域当前是否在本机有效（存活点集非空） */
  hasZone(zone: string): boolean {
    const z = this.live.get(zone);
    return z !== undefined && z.size > 0;
  }

  /** 当前可视状态快照 */
  view(inboxDone: number, inboxTotal: number): TerminalView {
    const zones: ZoneView[] = [...this.live.entries()]
      .map(([zone, adds]) => {
        const byDot = new Map<string, string[]>();
        for (const [eid, a] of [...adds.entries()].sort()) {
          const arr = byDot.get(a.dot) ?? [];
          arr.push(eid);
          byDot.set(a.dot, arr);
        }
        return {
          zone,
          dots: [...byDot.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([dot, events]) => ({ dot, events })),
        };
      })
      .sort((a, b) => a.zone.localeCompare(b.zone));
    return {
      vector: { ...this.vector },
      zones,
      pending: this.pendingList.map((p) => p.id),
      inboxDone,
      inboxTotal,
    };
  }
}
