import { Replica } from './engine';
import { parseScenario } from './parse';
import type {
  AuditReleaseInfo,
  AuditResult,
  AuditStep,
  AuditTerminalSnapshot,
  Message,
  MessageSummary,
  ValidationError,
} from './types';

/**
 * 延迟传播压力审计（纯函数核心）。
 *
 * 值班员在已完成的回放中选择一个航线区域（zone）与 2-3 台终端发起审计：
 * 系统从同一份操作脚本（scenario.messages）派生每台终端可接收的全部消息，
 * 在“每条消息最终向每台参与终端恰好投递一次、不允许重复、也不改写原 inbox”
 * 的前提下，穷举所有完整投递方案（终端间投递可任意交错；缺少因果前序的到达
 * 仍按现有暂存 / 依赖补齐后级联释放的语义计步），寻找让该区域在各终端间的
 * 有效性分歧持续最久的方案。
 *
 * 状态压缩依据（CRDT 语义）：
 * - 单台终端在某时刻的结算结果只取决于“已投递集合”：已应用集合是已投递集合
 *   的因果闭包（唯一，与暂存到达顺序无关），OR-Set 归并结果对可应用消息的
 *   排列不敏感。因此用每台终端的已投递位掩码即可代表等价副本状态。
 * - 全局状态 = 各终端掩码元组，构成一个格上 DAG，求最长加权路径；节点权重
 *   为“该步结算（含级联释放）后目标区域有效性是否在各终端间存在分歧”。
 *
 * 剪枝（不使用随机乱序、固定抽样，也不直接套用原 inbox）：
 * 1) 等价副本状态：以各终端“已投递位掩码元组”为状态（同一掩码结算结果唯一），
 *    预计算每个已投递集合的因果闭包与区域有效性 f(S)，天然合并交错排列；
 * 2) 记忆化分支限界：先沿字典序最前着法取到可行现任解，再为每个状态维护
 *    “可行下界 / 可采纳上界”区间；上界取两类可采纳界的较小者——两台终端的
 *    成对精确最优之和（任一分歧步至少属于一对不一致），与只看各终端已投递
 *    条数的计数界；连“已得分 + 上界”都不超过现任的子树整体剪去；
 * 3) 同分时按 (终端标识, 消息标识) 的完整投递序列字典序取首个，裁决可复现。
 */

export interface AuditRequest {
  /** 目标航线区域 */
  zone: string;
  /** 参与审计的终端标识（2-3 台，必须为场景终端子集） */
  terminals: string[];
}

const MAX_TERMINALS = 3;
const MIN_TERMINALS = 2;
const MAX_MESSAGES = 10;

type Move = [number, number]; // [参与终端序号, 消息序号]

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function runAudit(raw: unknown, req: AuditRequest): AuditResult {
  const parsed = parseScenario(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const sc = parsed.scenario;

  const errors: ValidationError[] = [];
  const reject = (path: string, message: string) => errors.push({ path, message });

  // ---- 请求参数校验 ----
  if (typeof req?.zone !== 'string' || req.zone.length === 0) {
    reject('$.audit.zone', '审计请求缺少目标航线区域 zone（非空字符串）');
  }
  if (!Array.isArray(req?.terminals)) {
    reject('$.audit.terminals', '审计请求缺少终端列表 terminals');
  }
  const picked: string[] = [];
  if (Array.isArray(req?.terminals)) {
    req.terminals.forEach((t, i) => {
      if (typeof t !== 'string') {
        reject(`$.audit.terminals[${i}]`, '终端标识必须是字符串');
        return;
      }
      if (!sc.terminals.includes(t)) {
        reject(`$.audit.terminals[${i}]`, `审计终端 "${t}" 不在场景终端集合中`);
        return;
      }
      if (picked.includes(t)) {
        reject(`$.audit.terminals[${i}]`, `审计终端重复选择："${t}"`);
        return;
      }
      picked.push(t);
    });
    if (errors.length === 0 && picked.length > MAX_TERMINALS) {
      reject(
        '$.audit.terminals',
        `延迟传播压力审计最多支持 ${MAX_TERMINALS} 台终端，当前选择 ${picked.length} 台，已明确拒绝`,
      );
    }
    if (errors.length === 0 && picked.length < MIN_TERMINALS) {
      reject(
        '$.audit.terminals',
        `延迟传播压力审计至少需要 ${MIN_TERMINALS} 台终端（单终端不存在有效性分歧），当前 ${picked.length} 台`,
      );
    }
  }
  if (sc.messages.length === 0) {
    reject('$.messages', '场景中没有任何源消息，无法派生投递方案');
  }
  if (sc.messages.length > MAX_MESSAGES) {
    reject(
      '$.messages',
      `延迟传播压力审计仅支持不超过 ${MAX_MESSAGES} 条源消息，当前 ${sc.messages.length} 条，已明确拒绝`,
    );
  }
  const addZones = new Set(
    sc.messages.filter((m) => m.kind === 'add').map((m) => (m.kind === 'add' ? m.tag.zone : '')),
  );
  if (typeof req?.zone === 'string' && req.zone.length > 0 && !addZones.has(req.zone)) {
    reject(
      '$.audit.zone',
      `目标航线区域 "${req.zone}" 不存在于脚本任何新增标签中（可选：${[...addZones].sort().join('、') || '（无）'}）`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  // 稳定排序：终端按标识、消息按事件标识（后续所有枚举顺序的裁决基础）
  const terminals = [...picked].sort(cmpId);
  const messages = [...sc.messages].sort((a, b) => cmpId(a.id, b.id));
  const M = messages.length;
  const T = terminals.length;
  const zone = req.zone as string;
  const fullMask = (1 << M) - 1;

  // ---- 就绪判定：发送方链前序 + ctx 跨终端依赖（与 Replica.deliver 完全一致） ----
  // 因果投递保证 vector[F]=n ⟺ F#1..F#n 全部已应用，故只需统计各终端最大已应用序号。
  const appliedSeq = (applied: number, from: string): number => {
    let n = 0;
    for (let i = 0; i < M; i += 1) {
      const m = messages[i];
      if (m.from === from && (applied & (1 << i)) !== 0) n = Math.max(n, m.seq);
    }
    return n;
  };
  const ready = (applied: number, m: Message): boolean => {
    if (appliedSeq(applied, m.from) !== m.seq - 1) return false;
    for (const u of sc.terminals) {
      if (u === m.from) continue;
      const need = m.ctx[u] ?? 0;
      if (need > 0 && appliedSeq(applied, u) < need) return false;
    }
    return true;
  };

  // ---- 预计算全部已投递集合（≤1024）的因果闭包 ----
  const closureOf = new Int32Array(1 << M);
  for (let s = 0; s <= fullMask; s += 1) {
    let applied = 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < M; i += 1) {
        const bit = 1 << i;
        if ((s & bit) === 0 || (applied & bit) !== 0) continue;
        if (ready(applied, messages[i])) {
          applied |= bit;
          progressed = true;
        }
      }
    }
    closureOf[s] = applied;
  }

  // ---- f(已应用集合)：目标区域是否存在存活点（与 Replica.apply 同一 OR-Set 规则） ----
  const zoneAdds: number[] = [];
  const zoneRemoves: number[] = [];
  messages.forEach((m, i) => {
    if (m.kind === 'add' && m.tag.zone === zone) zoneAdds.push(i);
    if (m.kind === 'remove' && m.zone === zone) zoneRemoves.push(i);
  });
  const validByApplied = new Uint8Array(1 << M);
  for (let a = 0; a <= fullMask; a += 1) {
    let anyAlive = false;
    for (const ai of zoneAdds) {
      if ((a & (1 << ai)) === 0) continue;
      const add = messages[ai];
      let alive = true;
      for (const ri of zoneRemoves) {
        if ((a & (1 << ri)) === 0) continue;
        const rm = messages[ri];
        if (rm.kind !== 'remove') continue;
        if ((rm.ctx[add.from] ?? 0) >= add.seq) {
          alive = false;
          break;
        }
      }
      if (alive) {
        anyAlive = true;
        break;
      }
    }
    validByApplied[a] = anyAlive ? 1 : 0;
  }
  const validOf = (delivered: number): number => validByApplied[closureOf[delivered]];

  // ---- 成对精确 DP：两台终端时即为精确答案；三终端时提供可采纳上界 ----
  // P[ma,mb]：仅在两台（脚本相同的）终端间投递，从已投递掩码 (ma,mb) 出发，
  // 两者目标区域有效性不同的最大步数。第三台终端的投递对该对掩码无影响，
  // 只会插入零贡献步，故任意完整调度的成对分歧数不超过 P，是可采纳上界。
  const N = 1 << M;
  const P = new Uint8Array(N * N); // 值 ≤ 2M ≤ 20
  // 字典序最小最优首着：编码 ti*M+mi（0..T*M-1），叶节点为 -1
  const PNext = new Int16Array(N * N);
  const V = new Uint8Array(N);
  for (let s = 0; s < N; s += 1) V[s] = validOf(s);
  for (let flat = N * N - 1; flat >= 0; flat -= 1) {
    const ma = Math.floor(flat / N);
    const mb = flat - ma * N;
    if (ma === fullMask && mb === fullMask) {
      PNext[flat] = -1;
      continue;
    }
    let best = -1;
    let bestCode = -1;
    // 着法顺序与全局裁决一致：先终端 A（位序低者）后 B，各自消息标识升序
    for (let mi = 0; mi < M; mi += 1) {
      const bit = 1 << mi;
      if (ma & bit) continue;
      const na = ma | bit;
      const cand = (V[na] !== V[mb] ? 1 : 0) + P[na * N + mb];
      if (cand > best) {
        best = cand;
        bestCode = mi; // ti=0
      }
    }
    for (let mi = 0; mi < M; mi += 1) {
      const bit = 1 << mi;
      if (mb & bit) continue;
      const nb = mb | bit;
      const cand = (V[ma] !== V[nb] ? 1 : 0) + P[ma * N + nb];
      if (cand > best) {
        best = cand;
        bestCode = M + mi; // ti=1
      }
    }
    P[flat] = best;
    PNext[flat] = bestCode;
  }

  // ---- 全局求解：最长加权路径，同分时字典序最小，记忆化 + 可采纳分支限界 ----
  const masksOf = (key: number): number[] => {
    const ms: number[] = [];
    let k = key >>> 0;
    for (let t = 0; t < T; t += 1) {
      ms.push(k & fullMask);
      k = k >>> M;
    }
    return ms;
  };
  const keyOf = (masks: number[]): number =>
    masks.reduce((acc, mk, t) => (acc | (mk << (t * M))) >>> 0, 0);
  const divergentAt = (masks: number[]): boolean => {
    const first = V[masks[0]];
    for (let t = 1; t < T; t += 1) if (V[masks[t]] !== first) return true;
    return false;
  };
  /** 三终端可采纳上界：三对成对最优之和（不一致 ⇒ 至少一对不同，故不超对数和） */
  const upperBound3 = (masks: number[]): number =>
    P[masks[0] * N + masks[1]] +
    P[masks[0] * N + masks[2]] +
    P[masks[1] * N + masks[2]];

  // ---- 计数上界 H(k1,k2,k3)：只看各终端已投递条数时，剩余路径最多分歧步数 ----
  // 放宽同一条数下掩码之间的耦合（允许各终端在该条数下独立取任意可达有效性），
  // 因此是可采纳上界；与成对上界取 min 后在最坏（无依赖）情形仍足够紧。
  let upperBound = upperBound3;
  if (T === 3) {
    const possibleValid: Array<Set<number>> = Array.from({ length: M + 1 }, () => new Set());
    for (let s = 0; s < N; s += 1) {
      let k = 0;
      let x = s;
      while (x) {
        k += x & 1;
        x >>>= 1;
      }
      possibleValid[k].add(V[s]);
    }
    const K = M + 1;
    const hIndex = (ks: number[]): number => ks[0] * K * K + ks[1] * K + ks[2];
    const H = new Uint16Array(K * K * K);
    /** 三个条数下，有效性既可能为真也可能为假 ⇒ 该结算状态可能存在分歧 */
    const seenOf = (ks: number[]): number => {
      let seen = 0;
      for (const k of ks) {
        if (possibleValid[k].has(0)) seen |= 1;
        if (possibleValid[k].has(1)) seen |= 2;
      }
      return seen === 3 ? 1 : 0;
    };
    for (let flat = K ** 3 - 1; flat >= 0; flat -= 1) {
      const k3 = flat % K;
      const k2 = Math.floor(flat / K) % K;
      const k1 = Math.floor(flat / (K * K));
      const ks = [k1, k2, k3];
      if (k1 === M && k2 === M && k3 === M) {
        H[flat] = 0;
        continue;
      }
      let bestNext = 0;
      // 层权属于“投递后的子状态”，故对每个合法着法看其子状态是否可能分歧
      for (let t = 0; t < 3; t += 1) {
        if (ks[t] >= M) continue;
        const nks = [...ks];
        nks[t] += 1;
        const cand = seenOf(nks) + H[hIndex(nks)];
        if (cand > bestNext) bestNext = cand;
      }
      H[flat] = bestNext;
    }
    const countUpper = (masks: number[]): number => {
      const ks = masks.map((mk) => {
        let k = 0;
        let x = mk;
        while (x) {
          k += x & 1;
          x >>>= 1;
        }
        return k;
      });
      return H[hIndex(ks)];
    };
    upperBound = (masks) => Math.min(upperBound3(masks), countUpper(masks));
  }

  let statesEvaluated = 0;
  let memoHits = 0;
  let bestPath: Move[] = [];

  if (T === 2) {
    // 成对表即精确解：按 PNext 还原字典序最小最优方案
    let ma = 0;
    let mb = 0;
    while (!(ma === fullMask && mb === fullMask)) {
      const code = PNext[ma * N + mb];
      if (code < M) {
        bestPath.push([0, code]);
        ma |= 1 << code;
      } else {
        const mi = code - M;
        bestPath.push([1, mi]);
        mb |= 1 << mi;
      }
    }
    statesEvaluated = N * N; // 成对表逐项求值（所有掩码组合均可达）
    memoHits = 0;
  } else {
    // T === 3：记忆化分支限界。备忘录为每个等价状态保存一个区间：
    //   lb：已实际找到的可行尾段得分（下界，附带可行尾段 seg）
    //   ub：可采纳上界（成对上界 / 计数上界，及各子着法上界的最大值）
    // 全局现任最优 incumbent 随搜索单调收紧；连“已得分 + 子树上界”都不超过
    // 现任的分支直接剪去（等同时该方案在字典序上必然更靠后，同分必败）。
    // 首趟沿字典序最前着法一路深入到叶，天然得到最前可行解；只有严格更高才
    // 更新现任，故最终现任方案即所有最优方案中字典序最小者。
    interface Entry {
      lb: number; // 可行下界（-1 表示该次访问中尚未找到可行尾段）
      ub: number; // 可采纳上界
      seg: Move[]; // 达成 lb 的尾段
    }
    const memo3 = new Map<number, Entry>();
    const fullKey = keyOf(new Array<number>(T).fill(fullMask));
    let incumbent = -1;
    let incumbentPath: Move[] = [];
    const consider = (path: Move[], score: number) => {
      if (score > incumbent) {
        incumbent = score;
        incumbentPath = path;
      }
    };

    const dfs = (key: number, acc: number, prefix: Move[]): Entry => {
      const masks = masksOf(key);
      const known = memo3.get(key);
      const knownUb = known ? known.ub : upperBound(masks);
      // 全局分支限界：上界都无法超过现任，则该子树不含更优 / 同分更前的方案
      if (acc + knownUb <= incumbent) {
        return { lb: -1, ub: knownUb, seg: [] };
      }
      if (known) {
        memoHits += 1;
        if (known.lb >= 0) consider([...prefix, ...known.seg], acc + known.lb);
        if (known.lb === known.ub) return known; // 已精确，无需重开
      } else {
        statesEvaluated += 1;
      }

      if (key === fullKey) {
        const leaf: Entry = { lb: 0, ub: 0, seg: [] };
        memo3.set(key, leaf);
        consider([...prefix], acc);
        return leaf;
      }

      let lb = known?.lb ?? -1;
      let ub = -1;
      let seg = known?.seg ?? [];
      // 规范展开：终端标识升序 × 消息标识升序
      for (let ti = 0; ti < T; ti += 1) {
        for (let mi = 0; mi < M; mi += 1) {
          const bit = 1 << mi;
          if (masks[ti] & bit) continue;
          const childMasks = [...masks];
          childMasks[ti] |= bit;
          const reward = divergentAt(childMasks) ? 1 : 0;
          const childKey = keyOf(childMasks);
          const cachedChild = memo3.get(childKey);
          const childUb0 = cachedChild ? cachedChild.ub : upperBound(childMasks);
          // 该子着法（含其尾段）不可能改进现任：跳过，但纳入本状态上界
          if (acc + reward + childUb0 <= incumbent) {
            ub = Math.max(ub, reward + childUb0);
            continue;
          }
          const move: Move = [ti, mi];
          prefix.push(move);
          const ce = dfs(childKey, acc + reward, prefix);
          prefix.pop();
          ub = Math.max(ub, reward + ce.ub); // ce.ub 可采纳，故本状态上界可靠
          if (ce.lb >= 0) {
            const cand = reward + ce.lb;
            if (cand > lb) {
              lb = cand;
              seg = [move, ...ce.seg];
              consider([...prefix, move, ...ce.seg], acc + cand);
            }
          }
        }
      }
      const entry: Entry = { lb, ub, seg };
      memo3.set(key, entry);
      return entry;
    };

    dfs(0, 0, []);
    bestPath = incumbentPath;
  }

  // ---- 按最优方案用真实副本逐步重放（含暂存 / 级联释放的完整计步细节）----
  const replicas = new Map(terminals.map((t) => [t, new Replica(t, sc.terminals)]));
  const deliveredCount = new Map(terminals.map((t) => [t, 0]));

  const snapshotAll = (): Record<string, AuditTerminalSnapshot> => {
    const out: Record<string, AuditTerminalSnapshot> = {};
    for (const t of terminals) {
      const view = replicas.get(t)!.view(deliveredCount.get(t)!, M);
      const zoneView = view.zones.find((z) => z.zone === zone);
      out[t] = {
        terminal: t,
        vector: view.vector,
        zones: view.zones,
        zoneValid: !!zoneView,
        zoneDots: zoneView ? zoneView.dots : [],
        pending: view.pending,
        delivered: deliveredCount.get(t)!,
      };
    }
    return out;
  };

  const terminalPlans: Record<string, string[]> = Object.fromEntries(
    terminals.map((t) => [t, [] as string[]]),
  );
  const steps: AuditStep[] = [];
  let divergenceSteps = 0;
  let prevDivergent = false; // 初始：全部空副本，区域均无效，不存在分歧
  for (let i = 0; i < bestPath.length; i += 1) {
    const [ti, mi] = bestPath[i];
    const t = terminals[ti];
    const m = messages[mi];
    terminalPlans[t].push(m.id);
    deliveredCount.set(t, deliveredCount.get(t)! + 1);
    const res = replicas.get(t)!.deliver(m);
    const stateAfter = snapshotAll();
    const divergent = terminals.some(
      (x) => stateAfter[x].zoneValid !== stateAfter[terminals[0]].zoneValid,
    );
    if (divergent) divergenceSteps += 1;
    const change: AuditStep['divergenceChange'] =
      divergent === prevDivergent ? 'none' : divergent ? 'created' : 'resolved';
    const releases: AuditReleaseInfo[] = res.releases.map((r) => ({
      messageId: r.msg.id,
      kind: r.msg.kind,
      reason: r.reason,
      effect: r.effect,
    }));
    steps.push({
      index: i,
      terminal: t,
      messageId: m.id,
      kind: m.kind,
      action: res.action,
      reason: res.reason,
      effect: res.effect,
      releases,
      stateAfter,
      divergent,
      divergenceChange: change,
    });
    prevDivergent = divergent;
  }

  const lastSnap = steps[steps.length - 1].stateAfter;
  const finalValid = Object.fromEntries(terminals.map((t) => [t, lastSnap[t].zoneValid]));
  const converged = terminals.every((t) => finalValid[t] === finalValid[terminals[0]]);

  const messageSummaries: MessageSummary[] = messages.map((m) => ({
    id: m.id,
    kind: m.kind,
    from: m.from,
    seq: m.seq,
    ctx: m.ctx,
    label: m.kind === 'add' ? `新增 ${m.tag.zone}（点 ${m.dot}）` : `撤销 ${m.zone}`,
  }));

  return {
    ok: true,
    terminals,
    zone,
    messages: messageSummaries,
    steps,
    divergenceSteps,
    totalDeliveries: T * M,
    terminalPlans,
    finalValid,
    converged,
    tieBreakRule:
      '同分方案按完整投递序列字典序裁决：从第 1 次投递起逐位比较，先比终端标识（升序），相同再比消息标识（升序），取首个最优方案',
    stats: { statesEvaluated, memoHits },
  };
}

