import { Replica, parseEventId } from './engine';
import { parseScenario } from './parse';
import type {
  AuditPlan,
  AuditResult,
  AuditStats,
  AuditStep,
  DivergenceChange,
  Message,
  MessageSummary,
  TerminalView,
  ValidationError,
} from './types';

/** 审计硬性上限：参与终端 ≤ 3，源消息 ≤ 10，超限明确拒绝 */
export const AUDIT_MAX_TERMINALS = 3;
export const AUDIT_MIN_TERMINALS = 2;
export const AUDIT_MAX_MESSAGES = 10;

/** Worker 协议：延迟传播压力审计请求（回放请求仍直接投递场景 JSON） */
export interface AuditRequest {
  kind: 'audit';
  scenario: unknown;
  zone: string;
  /** 参与终端子集；省略时取脚本全部终端（仍受 ≤3 限制） */
  terminals?: unknown;
  requestId?: number;
}

/** 消息标识稳定比较：先按产生终端标识，再按序号数值 */
function cmpMessageId(a: string, b: string): number {
  const x = parseEventId(a);
  const y = parseEventId(b);
  const c = x.t.localeCompare(y.t);
  return c !== 0 ? c : x.n - y.n;
}

function anyDivergent(bits: number[]): boolean {
  if (bits.length === 0) return false;
  const first = bits[0];
  return bits.some((v) => v !== first);
}

/** 给定突发的 (n0,n1) 计数与其他终端突发前的位，突发贡献的分歧事件数 */
function burstGain(n0: number, n1: number, others: number[]): number {
  if (anyDivergent(others)) return n0 + n1; // 其他终端已分歧：本终端每个事件都处于分歧中
  return others[0] === 1 ? n0 : n1; // 其他一致：仅与其相反的事件计分歧
}

/* ===================== 单终端具体轨迹状态图 =====================
 *
 * 延迟传播下终端之间互不通信，一台终端的轨迹只取决于自身投递排列。
 * 状态 = (版本向量, 有序暂存, 已投递掩码)；一次直接投递是原子突发：
 * 直接应用/缓冲加上引擎确定性的级联释放，突发内逐事件记录目标区域位。
 * 该图是规模 (N+1) 层的 DAG，最坏约 2.4 万节点。
 */

interface TraceEdge {
  bits: number[]; // 突发内逐事件后的区域位
  to: number; // 后继具体节点
}

interface TraceNode {
  id: number;
  replica: Replica;
  mask: Uint8Array;
  bit: 0 | 1;
  layer: number;
  outs: TraceEdge[]; // 按消息序号索引（已投递的槽位留空）
}

interface Trace {
  nodes: TraceNode[];
  start: number;
  N: number;
  keyOf: Map<string, number>;
}

function buildTrace(messages: Message[], zone: string, terminals: string[]): Trace {
  const N = messages.length;
  const nodes: TraceNode[] = [];
  const byKey = new Map<string, number>();

  const stateKey = (replica: Replica, mask: Uint8Array): string => {
    const vec = terminals.map((t) => replica.vector[t] ?? 0).join(',');
    const pend = replica.pendingList.map((p) => p.id).join('.');
    return `${vec}|${pend}|${mask.join('')}`;
  };

  const build = (mask: Uint8Array, replica: Replica): number => {
    const key = stateKey(replica, mask);
    const hit = byKey.get(key);
    if (hit !== undefined) return hit;
    let layer = 0;
    for (const v of mask) layer += v;
    const node: TraceNode = {
      id: nodes.length,
      replica,
      mask,
      bit: replica.hasZone(zone) ? 1 : 0,
      layer,
      outs: [],
    };
    nodes.push(node);
    byKey.set(key, node.id);

    for (let mi = 0; mi < N; mi += 1) {
      if (mask[mi]) continue;
      const child = replica.clone();
      const bits: number[] = [];
      const res = child.deliver(messages[mi], () => {
        bits.push(child.hasZone(zone) ? 1 : 0);
      });
      if (res.action === 'buffered') bits.push(child.hasZone(zone) ? 1 : 0);
      const childMask = new Uint8Array(mask);
      childMask[mi] = 1;
      const to = build(childMask, child);
      node.outs[mi] = { bits, to };
    }
    return node.id;
  };

  const startReplica = new Replica(terminals[0], terminals);
  const start = build(new Uint8Array(N), startReplica);
  return { nodes, start, N, keyOf: byKey };
}

/* ===================== 行为等价商化 =====================
 *
 * 突发对分歧的贡献只取决于 (突发内 0/1 事件数, 后继) 与其他终端突发
 * 前的位，与突发内顺序无关。按“匿名轮廓多重集（(n0,n1,后继商类) 的
 * 多重集）+ 当前位”自底向上商化具体节点，无关消息因此大规模对称合并。
 */

interface QEdge {
  n0: number;
  n1: number;
  to: number;
}

interface Quotient {
  S: number;
  start: number;
  term: number;
  bit: Int8Array;
  layer: Int8Array;
  /** 每个商类的去重匿名边（按 n0,n1,to 排序） */
  edges: QEdge[][];
  /** 具体节点 -> 商类 */
  classOf: Int32Array;
  rawCount: number;
  classCount: number;
}

function buildQuotient(trace: Trace): Quotient {
  const { nodes, N } = trace;
  const classOf = new Int32Array(nodes.length).fill(-1);

  // 按层分组
  const byLayer: TraceNode[][] = [];
  for (const n of nodes) (byLayer[n.layer] ??= []).push(n);

  const classByKey = new Map<string, number>();
  const bitArr: number[] = [];
  const layerArr: number[] = [];
  const edgeArr: QEdge[][] = [];

  const internClass = (
    bit: 0 | 1,
    layer: number,
    signature: string,
    edges: QEdge[],
  ): number => {
    let c = classByKey.get(signature);
    if (c === undefined) {
      c = classByKey.size;
      classByKey.set(signature, c);
      bitArr.push(bit);
      layerArr.push(layer);
      edgeArr.push(edges);
    }
    return c;
  };

  for (let layer = N; layer >= 0; layer -= 1) {
    for (const n of byLayer[layer] ?? []) {
      if (layer === N) {
        classOf[n.id] = internClass(n.bit, N, 'T', []);
        continue;
      }
      const part = new Map<string, QEdge & { count: number }>();
      for (let mi = 0; mi < N; mi += 1) {
        if (n.mask[mi]) continue;
        const o = n.outs[mi];
        let n1 = 0;
        for (const b of o.bits) n1 += b;
        const n0 = o.bits.length - n1;
        const to = classOf[o.to];
        const ek = `${n0}.${n1}>${to}`;
        const e = part.get(ek);
        if (e) e.count += 1;
        else part.set(ek, { n0, n1, to, count: 1 });
      }
      const sigParts: string[] = [];
      const edges: QEdge[] = [];
      for (const [ek, e] of [...part.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        sigParts.push(`${ek}×${e.count}`);
        edges.push({ n0: e.n0, n1: e.n1, to: e.to });
      }
      const c = internClass(n.bit, layer, `${n.bit}|${sigParts.join(',')}`, edges);
      classOf[n.id] = c;
    }
  }

  return {
    S: classByKey.size,
    start: classOf[trace.start],
    term: classByKey.get('T')!,
    bit: Int8Array.from(bitArr),
    layer: Int8Array.from(layerArr),
    edges: edgeArr,
    classOf,
    rawCount: nodes.length,
    classCount: classByKey.size,
  };
}

/* ===================== 对称反向乘积 DP =====================
 *
 * g(c0,c1,c2) = 三终端处于这些商类时，到全部终局的最大分歧事件分。
 * 各终端共用同一自动机、起点相同，故 g 对参数对称，只存有序三元组
 * c0≤c1≤c2；两台终端时存有序对。边恒使某终端层 +1，按总层自高到低
 * 松弛。稠密 Int8Array（任意方案总分 ≤ 3N ≤ 30）。
 */

interface BackDP {
  g: Int8Array;
  S: number;
  k: number;
  bs: Int32Array;
}

/** 有序对 0<=a<=b<S 的下标 = a*S - a(a-1)/2 + (b-a) */
function pairIndex(S: number, a: number, b: number): number {
  return a * S - (a * (a - 1)) / 2 + (b - a);
}

function orderedPairCount(S: number): number {
  return (S * (S + 1)) / 2;
}

function sort2(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}
function sort3(a: number, b: number, c: number): [number, number, number] {
  return [a, b, c].sort((x, y) => x - y) as [number, number, number];
}

/** 有序三元组 0<=a<=b<=c<S 的稠密下标，块起点表 */
function makeBlockStarts(S: number): Int32Array {
  const bs = new Int32Array(S + 1);
  for (let a = 0; a < S; a += 1) {
    bs[a + 1] = bs[a] + ((S - a) * (S - a + 1)) / 2;
  }
  return bs;
}

function tripleIndex(bs: Int32Array, S: number, a0: number, b0: number, c0: number): number {
  const [a, b, c] = sort3(a0, b0, c0);
  let off = 0;
  for (let bb = a; bb < b; bb += 1) off += S - bb;
  return bs[a] + off + (c - b);
}

interface FlatEdges {
  start: Int32Array; // 每类在扁平边数组中的起点（长度 S+1）
  to: Int16Array;
  gain0: Int8Array; // 其他终端一致为 0 时的收益 = n1
  gain1: Int8Array; // 其他终端一致为 1 时的收益 = n0
  gainMix: Int8Array; // 其他终端已分歧时的收益 = n0+n1
}

function flattenEdges(q: Quotient): FlatEdges {
  const S = q.S;
  const start = new Int32Array(S + 1);
  const all: QEdge[] = [];
  for (let c = 0; c < S; c += 1) {
    start[c] = all.length;
    for (const e of q.edges[c]) all.push(e);
  }
  start[S] = all.length;
  const M = all.length;
  const to = new Int16Array(M);
  const gain0 = new Int8Array(M);
  const gain1 = new Int8Array(M);
  const gainMix = new Int8Array(M);
  all.forEach((e, i) => {
    to[i] = e.to;
    gain0[i] = e.n1;
    gain1[i] = e.n0;
    gainMix[i] = e.n0 + e.n1;
  });
  return { start, to, gain0, gain1, gainMix };
}

function buildBackDP(q: Quotient, k: number): BackDP & { states: number; transitions: number } {
  const S = q.S;
  const P = orderedPairCount(S);
  const bs = makeBlockStarts(S);
  // tri[a] = Σ_{i=0}^{a-1}(S-i)，三元组下标 O(1)：
  // idx3(a,b,c) = bs[a] + tri[b] - tri[a] + (c-b)，a≤b≤c
  const tri = new Int32Array(S + 1);
  for (let a = 0; a < S; a += 1) tri[a + 1] = tri[a] + (S - a);
  const idx3o = (a: number, b: number, c: number): number =>
    bs[a] + tri[b] - tri[a] + (c - b);
  const idx2 = (a: number, b: number) => pairIndex(S, a, b);
  const g = new Int8Array(k === 3 ? bs[S] : P).fill(-1);
  const fe = flattenEdges(q);
  const bit = q.bit;

  /** 移动有序三元组 (x≤y≤z) 中某一维到 t 后的下标（O(1) 插入排序） */
  const moveC = (x: number, y: number, t: number): number => {
    if (t <= x) return idx3o(t, x, y);
    if (t <= y) return idx3o(x, t, y);
    return idx3o(x, y, t);
  };
  const moveB = (x: number, z: number, t: number): number => {
    // 原元组 (x,y,z)，y 被替换；调用方给定 x≤z
    if (t <= x) return idx3o(t, x, z);
    if (t <= z) return idx3o(x, t, z);
    return idx3o(x, z, t);
  };
  const moveA = (y: number, z: number, t: number): number => {
    // 原元组 (a,b,c)，a 被替换；给定 y≤z
    if (t <= y) return idx3o(t, y, z);
    if (t <= z) return idx3o(y, t, z);
    return idx3o(y, z, t);
  };
  const gainOf = (gi: number, o0: number, o1: number): number =>
    o0 === o1 ? (o0 === 0 ? fe.gain0[gi] : fe.gain1[gi]) : fe.gainMix[gi];

  if (k === 3) g[idx3o(q.term, q.term, q.term)] = 0;
  else g[idx2(q.term, q.term)] = 0;

  // 各类按层分组
  const byLayer: number[][] = [];
  let maxLayer = 0;
  for (let c = 0; c < S; c += 1) {
    (byLayer[q.layer[c]] ??= []).push(c);
    if (q.layer[c] > maxLayer) maxLayer = q.layer[c];
  }

  let states = 0;
  let transitions = 0;

  if (k === 2) {
    const buckets: number[][] = Array.from({ length: 2 * maxLayer + 1 }, () => []);
    for (let a = 0; a < S; a += 1) {
      for (let b = a; b < S; b += 1) buckets[q.layer[a] + q.layer[b]].push(a * S + b);
    }
    for (let s = 2 * maxLayer - 1; s >= 0; s -= 1) {
      for (const packed of buckets[s]) {
        const a = Math.floor(packed / S);
        const b = packed - a * S;
        let best = -1;
        const ba = bit[a];
        const bb = bit[b];
        for (let gi = fe.start[a]; gi < fe.start[a + 1]; gi += 1) {
          transitions += 1;
          const t = fe.to[gi];
          const x = t <= b ? t : b;
          const y = t <= b ? b : t;
          const gv = g[idx2(x, y)];
          if (gv >= 0) {
            const v = (bb === 0 ? fe.gain0[gi] : fe.gain1[gi]) + gv;
            if (v > best) best = v;
          }
        }
        if (a !== b) {
          for (let gi = fe.start[b]; gi < fe.start[b + 1]; gi += 1) {
            transitions += 1;
            const t = fe.to[gi];
            const x = a <= t ? a : t;
            const y = a <= t ? t : a;
            const gv = g[idx2(x, y)];
            if (gv >= 0) {
              const v = (ba === 0 ? fe.gain0[gi] : fe.gain1[gi]) + gv;
              if (v > best) best = v;
            }
          }
        }
        if (best >= 0) {
          g[idx2(a, b)] = best;
          states += 1;
        }
      }
    }
  } else {
    const buckets: number[][] = Array.from({ length: 3 * maxLayer + 1 }, () => []);
    for (let a = 0; a < S; a += 1) {
      for (let b = a; b < S; b += 1) {
        const base = q.layer[a] + q.layer[b];
        for (let c = b; c < S; c += 1) buckets[base + q.layer[c]].push((a * S + b) * S + c);
      }
    }
    for (let s = 3 * maxLayer - 1; s >= 0; s -= 1) {
      for (const packed of buckets[s]) {
        const c = packed % S;
        const b = Math.floor(packed / S) % S;
        const a = Math.floor(packed / (S * S));
        const ba = bit[a];
        const bb = bit[b];
        const bc = bit[c];
        let best = -1;

        // 移动 a
        for (let gi = fe.start[a]; gi < fe.start[a + 1]; gi += 1) {
          transitions += 1;
          const gv = g[moveA(b, c, fe.to[gi])];
          if (gv >= 0) {
            const v = gainOf(gi, bb, bc) + gv;
            if (v > best) best = v;
          }
        }
        // 移动 b（b==a 时与移动 a 等价，跳过）
        if (b !== a) {
          for (let gi = fe.start[b]; gi < fe.start[b + 1]; gi += 1) {
            transitions += 1;
            const gv = g[moveB(a, c, fe.to[gi])];
            if (gv >= 0) {
              const v = gainOf(gi, ba, bc) + gv;
              if (v > best) best = v;
            }
          }
        }
        // 移动 c（c 与 a/b 同类时等价已覆盖）
        if (c !== b && c !== a) {
          for (let gi = fe.start[c]; gi < fe.start[c + 1]; gi += 1) {
            transitions += 1;
            const gv = g[moveC(a, b, fe.to[gi])];
            if (gv >= 0) {
              const v = gainOf(gi, ba, bb) + gv;
              if (v > best) best = v;
            }
          }
        }
        if (best >= 0) {
          g[idx3o(a, b, c)] = best;
          states += 1;
        }
      }
    }
  }

  return { g, S, k, bs, states, transitions };
}

/* ===================== 固定链约束可行性（贪心绑定用） =====================
 *
 * 每终端三种约束：
 * - null：全程自由（值域 S 个商类）；
 * - 完整链（len=N，已绑定终端）：进度 0..N，N=终态；
 * - 部分链（len<N，正在绑定终端的候选前缀）：进度 0..len-1，走完最后
 *   一跳即转回自由（自由类编码为 len+c）。
 * 一旦没有任何终端还处在链式推进中（完整链到终态、部分链已转自由），
 * 后续全自由，直接以反向 DP 的 g 截断。稠密分层紧循环。
 */

function constrainedFeasible(
  q: Quotient,
  dp: BackDP,
  chains: (QEdge[] | null)[],
): number {
  const S = q.S;
  const k = chains.length;
  const N = q.layer[q.term];

  // 每终端值域大小、模式
  const D: number[] = [];
  for (let i = 0; i < k; i += 1) {
    const c = chains[i];
    if (c === null) D.push(S);
    else if (c.length === N) D.push(N + 1); // 进度 0..N
    else D.push(c.length + S); // 进度 0..len-1，自由类编码 len+c
  }
  const stride: number[] = [];
  let total = 1;
  for (let i = 0; i < k; i += 1) {
    stride.push(total);
    total *= D[i];
  }
  const f = new Int8Array(total).fill(-1);

  const classAt = (i: number, v: number): number => {
    const c = chains[i]!;
    if (c === null) return v;
    if (c.length === N) return v === 0 ? q.start : c[v - 1].to; // v=N -> c[N-1].to=term
    return v < c.length ? (v === 0 ? q.start : c[v - 1].to) : v - c.length;
  };
  /** 是否仍处于链式推进（未到终态/未转自由） */
  const inChain = (i: number, v: number): boolean => {
    const c = chains[i]!;
    if (c === null) return false;
    if (c.length === N) return v < N;
    return v < c.length;
  };

  const startVals: number[] = [];
  for (let i = 0; i < k; i += 1) startVals.push(chains[i] === null ? q.start : 0);
  let startId = 0;
  for (let i = 0; i < k; i += 1) startId += startVals[i] * stride[i];
  f[startId] = 0;

  const maxLevel = k * N;
  const buckets: number[][] = [];
  for (let lv = 0; lv <= maxLevel; lv += 1) buckets.push([]);
  buckets[0].push(startId);
  let answer = -1;

  for (let level = 0; level <= maxLevel; level += 1) {
    const bucket = buckets[level];
    for (let bi = 0; bi < bucket.length; bi += 1) {
      const id = bucket[bi];
      const cur = f[id];
      const vals: number[] = [];
      const cls: number[] = [];
      let chainedLeft = false;
      for (let i = 0; i < k; i += 1) {
        const v = Math.floor(id / stride[i]) % D[i];
        vals.push(v);
        cls.push(classAt(i, v));
        if (inChain(i, v)) chainedLeft = true;
      }

      // 无终端处于链式：后续全自由，g 截断（全部到 term 时 g=0）
      if (!chainedLeft) {
        const gv =
          k === 3
            ? dp.g[tripleIndex(dp.bs, S, cls[0], cls[1], cls[2])]
            : dp.g[pairIndex(S, ...sort2(cls[0], cls[1]))];
        if (gv >= 0 && cur + gv > answer) answer = cur + gv;
        continue;
      }

      for (let i = 0; i < k; i += 1) {
        const v = vals[i];
        const c = chains[i];
        const onChain = inChain(i, v);
        const moves: QEdge[] = onChain ? [c![v]] : q.edges[cls[i]];
        const others: number[] = [];
        for (let t = 0; t < k; t += 1) if (t !== i) others.push(q.bit[cls[t]]);
        for (const e of moves) {
          let nv: number;
          if (c === null) nv = e.to;
          else if (c.length === N) nv = v + 1;
          else if (v < c.length - 1) nv = v + 1;
          else nv = c.length + e.to; // 部分链最后一跳 -> 转自由
          const nid = id + (nv - v) * stride[i];
          const val = cur + burstGain(e.n0, e.n1, others);
          if (val > f[nid]) {
            if (f[nid] === -1) buckets[level + 1].push(nid); // 每条突发恰使层 +1
            f[nid] = val;
          }
        }
      }
    }
  }
  return answer;
}
/**
 * 延迟传播压力审计。
 *
 * 从同一份操作脚本为每台参与终端派生全部源消息（不使用原 inbox），穷举
 * “每条消息对每台终端恰好直接投递一次”的完整投递方案；缺少前序的到达
 * 沿用现有暂存与依赖补齐释放语义（级联释放事件同样计步）。寻找使目标
 * 区域有效性分歧持续事件步数最大的方案；同分按终端标识、消息标识序列
 * 稳定裁决。全程确定性穷举：无随机乱序、无抽样、不套用原 inbox。
 */
export function runAudit(raw: unknown, zone: unknown, selectedRaw?: unknown): AuditResult {
  const parsed = parseScenario(raw);
  if (!parsed.ok) return { ok: false, requestType: 'audit', errors: parsed.errors };
  const sc = parsed.scenario;

  const errors: ValidationError[] = [];

  if (typeof zone !== 'string' || zone.length === 0) {
    errors.push({ path: '$.audit.zone', message: '审计须指定一个航线区域 zone（非空字符串）' });
  }
  const zoneStr = typeof zone === 'string' ? zone : '';
  const zoneTouched =
    zoneStr.length > 0 &&
    sc.messages.some((m) => (m.kind === 'add' ? m.tag.zone === zoneStr : m.zone === zoneStr));
  if (typeof zone === 'string' && zone.length > 0 && !zoneTouched) {
    errors.push({
      path: '$.audit.zone',
      message: `区域 "${zoneStr}" 未在操作脚本的任何新增/撤销中出现，无法产生有效性分歧`,
    });
  }

  if (sc.messages.length > AUDIT_MAX_MESSAGES) {
    errors.push({
      path: '$.messages',
      message: `压力审计仅支持不超过 ${AUDIT_MAX_MESSAGES} 条源消息，当前 ${sc.messages.length} 条，已拒绝`,
    });
  }
  if (sc.messages.length === 0) {
    errors.push({ path: '$.messages', message: '场景没有任何源消息，无法发起压力审计' });
  }

  const selected: string[] = [];
  if (selectedRaw === undefined) {
    selected.push(...sc.terminals);
  } else if (!Array.isArray(selectedRaw)) {
    errors.push({ path: '$.audit.terminals', message: '参与终端集合必须是终端标识数组' });
  } else {
    const seen = new Set<string>();
    selectedRaw.forEach((t, i) => {
      if (typeof t !== 'string' || !sc.terminals.includes(t)) {
        errors.push({
          path: `$.audit.terminals[${i}]`,
          message: `参与终端 ${JSON.stringify(t)} 不是脚本中的已知终端`,
        });
        return;
      }
      if (seen.has(t)) {
        errors.push({ path: `$.audit.terminals[${i}]`, message: `参与终端重复："${t}"` });
        return;
      }
      seen.add(t);
      selected.push(t);
    });
  }
  if (errors.length === 0 && selected.length > AUDIT_MAX_TERMINALS) {
    errors.push({
      path: '$.audit.terminals',
      message: `压力审计仅支持不超过 ${AUDIT_MAX_TERMINALS} 台终端，当前选择 ${selected.length} 台，已拒绝`,
    });
  }
  if (errors.length === 0 && selected.length < AUDIT_MIN_TERMINALS) {
    errors.push({
      path: '$.audit.terminals',
      message: `有效性分歧至少需要 ${AUDIT_MIN_TERMINALS} 台终端，当前仅 ${selected.length} 台`,
    });
  }
  if (errors.length > 0) return { ok: false, requestType: 'audit', errors };

  const order = [...selected].sort((a, b) => a.localeCompare(b));
  const k = order.length;
  const canonical: Message[] = [...sc.messages].sort((a, b) => cmpMessageId(a.id, b.id));
  const N = canonical.length;

  // ---- 具体轨迹 -> 行为商化 -> 对称反向 DP 求全局最大分 S ----
  const trace = buildTrace(canonical, zoneStr, sc.terminals);
  const q = buildQuotient(trace);
  const dp = buildBackDP(q, k);
  const startTriple = Array.from({ length: k }, () => q.start);
  const targetScore =
    k === 3
      ? dp.g[tripleIndex(dp.bs, q.S, startTriple[0], startTriple[1], startTriple[2])]
      : dp.g[pairIndex(q.S, startTriple[0], startTriple[1])];
  if (targetScore < 0) {
    return {
      ok: false,
      requestType: 'audit',
      errors: [{ path: '$', message: '审计内部错误：起始状态不可达终局' }],
    };
  }

  /* ---- 逐终端贪心绑定：每个位置选仍能达到 S 的最小消息标识 ----
   * 终端 ci 的已固定前缀用具体 QEdge 序列描述；其余终端在反向 DP 中
   * 自由。固定前缀可行性由 prefixFeasible 判定。
   */
  interface ConcreteEvent {
    msg: Message;
    action: 'applied' | 'buffered' | 'released';
    reason: string;
    effect: string;
  }
  interface ConcreteBurst {
    direct: Message;
    events: ConcreteEvent[];
    bits: number[];
  }

  const plans: AuditPlan[] = [];
  const concrete: ConcreteBurst[][] = [];
  const fixedChains: QEdge[][] = order.map(() => []);
  let oracleCalls = 0;

  for (let ci = 0; ci < k; ci += 1) {
    const replica = new Replica(order[ci], sc.terminals);
    const used = new Uint8Array(N);
    const planIds: string[] = [];
    const bursts: ConcreteBurst[] = [];

    for (let pos = 0; pos < N; pos += 1) {
      const tries: { mi: number; edge: QEdge }[] = [];
      for (let mi = 0; mi < N; mi += 1) {
        if (used[mi]) continue;
        const probe = replica.clone();
        const bits: number[] = [];
        const pr = probe.deliver(canonical[mi], () => {
          bits.push(probe.hasZone(zoneStr) ? 1 : 0);
        });
        if (pr.action === 'buffered') bits.push(probe.hasZone(zoneStr) ? 1 : 0);
        let n1 = 0;
        for (const b of bits) n1 += b;
        const probeMask = new Uint8Array(used);
        probeMask[mi] = 1;
        const traceId = traceNodeId(trace, sc.terminals, probe, probeMask);
        tries.push({ mi, edge: { n0: bits.length - n1, n1, to: q.classOf[traceId] } });
      }
      tries.sort((a, b) => cmpMessageId(canonical[a.mi].id, canonical[b.mi].id));
      // 同状态下 (n0,n1,后继商类) 相同的消息在可行性上完全等价，
      // 贪心只须试每种轮廓的最小标识消息。
      const seenProfile = new Set<string>();
      const distinct = tries.filter((tr) => {
        const key = `${tr.edge.n0}.${tr.edge.n1}>${tr.edge.to}`;
        if (seenProfile.has(key)) return false;
        seenProfile.add(key);
        return true;
      });

      let accepted: (typeof tries)[number] | null = null;
      for (const tr of distinct) {
        // 已绑定终端走完整固定链；当前终端尝试该候选的部分链；其余自由
        const chains: (QEdge[] | null)[] = order.map((_, i) =>
          i < ci ? fixedChains[i] : i === ci ? [...fixedChains[ci], tr.edge] : null,
        );
        oracleCalls += 1;
        if (constrainedFeasible(q, dp, chains) === targetScore) {
          accepted = tr;
          break;
        }
      }
      if (!accepted) {
        return {
          ok: false,
          requestType: 'audit',
          errors: [{ path: '$', message: '审计贪心绑定失败（内部错误：无可保持最优的消息）' }],
        };
      }

      const mi = accepted.mi;
      used[mi] = 1;
      planIds.push(canonical[mi].id);
      fixedChains[ci].push(accepted.edge);

      const events: ConcreteEvent[] = [];
      const bits: number[] = [];
      const res = replica.deliver(canonical[mi], (v) => {
        events.push({
          msg: v.msg,
          action: v.direct ? 'applied' : 'released',
          reason: v.reason,
          effect: v.effect,
        });
        bits.push(replica.hasZone(zoneStr) ? 1 : 0);
      });
      if (res.action === 'buffered') {
        events.push({ msg: canonical[mi], action: 'buffered', reason: res.reason, effect: '' });
        bits.push(replica.hasZone(zoneStr) ? 1 : 0);
      }
      bursts.push({ direct: canonical[mi], events, bits });
    }
    plans.push({ terminal: order[ci], order: planIds });
    concrete.push(bursts);
  }

  /* ---- 洗牌 DP：三终端具体突发序列上的最优全局交错（突发原子）----
   * 状态 = 各终端已完成突发数（进度元组，≤ C(N+k-1,k-1)）；转移推进
   * 一台终端的一个突发，逐事件计分歧；同分按 (终端标识, 消息标识) 对
   * 的字典序取最小，得到稳定裁决的交错时间线。
   */
  interface Pick {
    ci: number;
    mid: string;
  }
  interface ShuffleState {
    score: number;
    picks: Pick[];
  }
  const sdp = new Map<string, ShuffleState>();
  const startKey = Array.from({ length: k }, () => 0).join('.');
  sdp.set(startKey, { score: 0, picks: [] });
  let frontier = new Set<string>([startKey]);
  const endKey = Array.from({ length: k }, () => N).join('.');

  while (frontier.size > 0) {
    const next = new Set<string>();
    for (const key of frontier) {
      const cur = sdp.get(key)!;
      if (key === endKey) continue;
      const prog = key.split('.').map(Number);
      const lastBit = prog.map((p, ci) =>
        p === 0 ? 0 : concrete[ci][p - 1].bits[concrete[ci][p - 1].bits.length - 1],
      );
      for (let ci = 0; ci < k; ci += 1) {
        if (prog[ci] >= N) continue;
        const burst = concrete[ci][prog[ci]];
        let gain = 0;
        for (const b of burst.bits) {
          const g = lastBit.slice();
          g[ci] = b;
          if (anyDivergent(g)) gain += 1;
        }
        const np = prog.slice();
        np[ci] += 1;
        const nk = np.join('.');
        const picks = [...cur.picks, { ci, mid: burst.direct.id }];
        const exist = sdp.get(nk);
        const better =
          !exist ||
          cur.score + gain > exist.score ||
          (cur.score + gain === exist.score && lexPicks(picks, exist.picks, order) < 0);
        if (better) sdp.set(nk, { score: cur.score + gain, picks });
        next.add(nk);
      }
    }
    frontier = next;
  }

  const finalShuffle = sdp.get(endKey)!;
  if (finalShuffle.score !== targetScore) {
    return {
      ok: false,
      requestType: 'audit',
      errors: [
        {
          path: '$',
          message: `审计内部错误：洗牌得分 ${finalShuffle.score} 与最大分 ${targetScore} 不一致`,
        },
      ],
    };
  }

  // ---- 按胜出交错生成逐步快照 ----
  const replicas = order.map((t) => new Replica(t, sc.terminals));
  const eff = new Array<number>(k).fill(0);
  const burstProg = new Array<number>(k).fill(0);
  const directDone = new Array<number>(k).fill(0);
  const steps: AuditStep[] = [];
  let eventIndex = 0;

  const capture = (): Record<string, TerminalView> => {
    const out: Record<string, TerminalView> = {};
    for (let ci = 0; ci < k; ci += 1) {
      out[order[ci]] = replicas[ci].view(directDone[ci], N);
    }
    return out;
  };

  const pushStep = (ci: number, ev: ConcreteEvent, before: number[]): void => {
    const wasDiv = anyDivergent(before);
    eff[ci] = replicas[ci].hasZone(zoneStr) ? 1 : 0;
    const nowDiv = anyDivergent(eff);
    const change: DivergenceChange = !wasDiv && nowDiv
      ? 'created'
      : wasDiv && !nowDiv
        ? 'resolved'
        : wasDiv && nowDiv
          ? 'persisted'
          : 'none';
    eventIndex += 1;
    steps.push({
      index: eventIndex,
      terminal: order[ci],
      planIndex: directDone[ci],
      messageId: ev.msg.id,
      kind: ev.msg.kind,
      action: ev.action,
      reason: ev.reason,
      effect: ev.effect,
      divergent: nowDiv,
      change,
      zoneEffective: Object.fromEntries(order.map((t, i) => [t, eff[i] === 1])),
      stateAfter: capture(),
    });
  };

  for (const pick of finalShuffle.picks) {
    const ci = pick.ci;
    const burst = concrete[ci][burstProg[ci]];
    directDone[ci] += 1;
    let recorded = false;
    replicas[ci].deliver(burst.direct, (v) => {
      recorded = true;
      pushStep(
        ci,
        { msg: v.msg, action: v.direct ? 'applied' : 'released', reason: v.reason, effect: v.effect },
        eff.slice(),
      );
    });
    if (!recorded) pushStep(ci, burst.events[0], eff.slice());
    burstProg[ci] += 1;
  }

  const rebuilt = steps.filter((s) => s.divergent).length;

  const messages: Record<string, MessageSummary> = {};
  for (const m of sc.messages) {
    messages[m.id] = {
      id: m.id,
      kind: m.kind,
      from: m.from,
      seq: m.seq,
      zone: m.kind === 'add' ? m.tag.zone : m.zone,
      ctx: m.ctx,
      label: m.kind === 'add' ? `新增 ${m.tag.zone}（点 ${m.dot}）` : `撤销 ${m.zone}`,
    };
  }

  const stats: AuditStats = {
    rawTraceStates: trace.nodes.length,
    quotientClasses: q.classCount,
    mergedStates: trace.nodes.length - q.classCount,
    productStates: dp.states,
    productTransitions: dp.transitions,
  };

  const detail =
    targetScore === 0
      ? `区域 ${zoneStr}：在 ${N} 条源×${k} 终端的全部完整投递方案下均无法制造有效性分歧（最长 0 步）`
      : `区域 ${zoneStr}：最长有效性分歧持续 ${targetScore} 个事件步（共 ${steps.length} 步，含暂存级联释放）；` +
        `单终端轨迹 ${trace.nodes.length} 状态→行为商类 ${q.classCount}（等价合并 ${trace.nodes.length - q.classCount}），` +
        `对称乘积 DP ${dp.states} 状态/${dp.transitions} 转移确定最优，无随机抽样`;

  return {
    ok: true,
    requestType: 'audit',
    zone: zoneStr,
    terminals: order,
    messageCount: N,
    divergenceSteps: targetScore,
    eventCount: steps.length,
    plans,
    steps,
    messages,
    stats,
    detail:
      rebuilt === targetScore
        ? detail
        : `${detail}（注意：重建计步 ${rebuilt} 与最大分 ${targetScore} 不一致）`,
  };
}

/** 由具体副本状态反查轨迹节点 id（key 构造与 buildTrace 完全一致） */
function traceNodeId(
  trace: Trace,
  terminals: string[],
  replica: Replica,
  mask: Uint8Array,
): number {
  const vec = terminals.map((t) => replica.vector[t] ?? 0).join(',');
  const pend = replica.pendingList.map((p) => p.id).join('.');
  const id = trace.keyOf.get(`${vec}|${pend}|${mask.join('')}`);
  if (id === undefined) throw new Error('副本状态不在轨迹图内');
  return id;
}

function lexPicks(a: { ci: number; mid: string }[], b: { ci: number; mid: string }[], order: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const ct = order[a[i].ci].localeCompare(order[b[i].ci]);
    if (ct !== 0) return ct;
    const cm = cmpMessageId(a[i].mid, b[i].mid);
    if (cm !== 0) return cm;
  }
  return a.length - b.length;
}
