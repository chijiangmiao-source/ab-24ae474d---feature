import type {
  AddMessage,
  Message,
  Scenario,
  TagPayload,
  ValidationError,
  Vector,
} from './types';

const ID_RE = /^([A-Za-z0-9_-]{1,16})#([0-9]+)$/;
const TERMINAL_RE = /^[A-Za-z0-9_-]{1,16}$/;

type Err = (path: string, message: string) => void;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function parseTag(raw: unknown, path: string, err: Err): TagPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(path, '标签载荷 tag 必须是对象');
    return null;
  }
  const o = raw as Record<string, unknown>;
  let ok = true;
  if (typeof o.zone !== 'string' || o.zone.length === 0) {
    err(`${path}.zone`, '标签缺少区域标识 zone（非空字符串）');
    ok = false;
  }
  if (typeof o.lat !== 'number' || o.lat < -90 || o.lat > 90) {
    err(`${path}.lat`, `纬度非法：${JSON.stringify(o.lat)}（需在 [-90,90]）`);
    ok = false;
  }
  if (typeof o.lng !== 'number' || o.lng < -180 || o.lng > 180) {
    err(`${path}.lng`, `经度非法：${JSON.stringify(o.lng)}（需在 [-180,180]）`);
    ok = false;
  }
  if (typeof o.radiusKm !== 'number' || !(o.radiusKm > 0)) {
    err(`${path}.radiusKm`, `半径非法：${JSON.stringify(o.radiusKm)}（需为正数）`);
    ok = false;
  }
  if (o.note !== undefined && typeof o.note !== 'string') {
    err(`${path}.note`, '备注 note 须为字符串');
    ok = false;
  }
  if (!ok) return null;
  const tag: TagPayload = {
    zone: o.zone as string,
    lat: o.lat as number,
    lng: o.lng as number,
    radiusKm: o.radiusKm as number,
  };
  if (typeof o.note === 'string') tag.note = o.note;
  return tag;
}

function parseMessage(
  raw: unknown,
  path: string,
  terminals: string[],
  tset: Set<string>,
  err: Err,
): Message | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    err(path, '消息必须是对象');
    return null;
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== 'string') {
    err(`${path}.id`, '缺少消息标识 id（格式 "终端#序号"，如 "A#1"）');
    return null;
  }
  const m = ID_RE.exec(o.id);
  if (!m) {
    err(`${path}.id`, `非法消息标识 "${o.id}"（格式 "终端#序号"，如 "A#1"）`);
    return null;
  }
  const from = m[1];
  const seq = Number(m[2]);
  if (!tset.has(from)) {
    err(`${path}.id`, `消息来自未知终端 "${from}"`);
    return null;
  }
  if (seq < 1) {
    err(`${path}.id`, `消息序号须从 1 开始，实际 ${seq}`);
    return null;
  }

  // 因果上下文：键必须全部属于已知终端，值为非负整数；归一化为全终端键
  const ctxRaw = o.ctx;
  if (typeof ctxRaw !== 'object' || ctxRaw === null || Array.isArray(ctxRaw)) {
    err(`${path}.ctx`, '缺少因果上下文 ctx（{ 终端: 已见序号 }）');
    return null;
  }
  const ctx: Vector = {};
  for (const t of terminals) ctx[t] = 0;
  let ctxOk = true;
  for (const [k, v] of Object.entries(ctxRaw as Record<string, unknown>)) {
    if (!tset.has(k)) {
      err(`${path}.ctx`, `非法上下文：引用了未知终端 "${k}"`);
      ctxOk = false;
      continue;
    }
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      err(`${path}.ctx`, `非法上下文：${k} 的值须为非负整数，实际 ${JSON.stringify(v)}`);
      ctxOk = false;
      continue;
    }
    ctx[k] = v;
  }
  if (!ctxOk) return null;

  if (o.kind === 'add') {
    let ok = true;
    if (typeof o.dot !== 'string' || o.dot.length === 0) {
      err(`${path}.dot`, '新增缺少全局唯一点标识 dot（非空字符串）');
      ok = false;
    }
    const tag = parseTag(o.tag, `${path}.tag`, err);
    if (!tag) ok = false;
    if (!ok) return null;
    const msg: AddMessage = {
      kind: 'add',
      id: o.id,
      from,
      seq,
      dot: o.dot as string,
      tag: tag as TagPayload,
      ctx,
    };
    return msg;
  }
  if (o.kind === 'remove') {
    if (typeof o.zone !== 'string' || o.zone.length === 0) {
      err(`${path}.zone`, '撤销缺少目标区域 zone（非空字符串）');
      return null;
    }
    return { kind: 'remove', id: o.id, from, seq, zone: o.zone, ctx };
  }
  err(`${path}.kind`, `未知操作类型 ${JSON.stringify(o.kind)}（仅支持 add / remove）`);
  return null;
}

/**
 * 解析并校验场景。任何非法输入都会定位到具体 JSON 路径并整体拒绝，
 * 调用方应据此清除旧回放。
 */
export function parseScenario(
  raw: unknown,
): { ok: true; scenario: Scenario } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const err: Err = (path, message) => errors.push({ path, message });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: '$', message: '场景必须是 JSON 对象' }] };
  }
  const root = raw as Record<string, unknown>;

  // ---- 终端列表：2-4 台，标识唯一（终端标识冲突须拒绝） ----
  const terminals: string[] = [];
  const rawTerminals = root.terminals;
  if (!Array.isArray(rawTerminals) || rawTerminals.length === 0) {
    err('$.terminals', 'terminals 必须是非空终端标识数组（2-4 台）');
  } else {
    const seenAt = new Map<string, number>();
    rawTerminals.forEach((t, i) => {
      if (typeof t !== 'string' || !TERMINAL_RE.test(t)) {
        err(`$.terminals[${i}]`, `非法终端标识 ${JSON.stringify(t)}（1-16 位字母/数字/"-"/"_"）`);
        return;
      }
      const prev = seenAt.get(t);
      if (prev !== undefined) {
        err(`$.terminals[${i}]`, `终端标识冲突："${t}" 与第 ${prev + 1} 项重复`);
        return;
      }
      seenAt.set(t, i);
      terminals.push(t);
    });
    if (terminals.length > 0 && (terminals.length < 2 || terminals.length > 4)) {
      err('$.terminals', `终端数量须为 2-4 台，当前 ${terminals.length} 台`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const tset = new Set(terminals);

  // ---- 消息体 ----
  const messages: Message[] = [];
  const byId = new Map<string, Message>();
  const rawMessages = root.messages;
  if (!Array.isArray(rawMessages)) {
    err('$.messages', 'messages 必须是消息数组');
  } else {
    rawMessages.forEach((rm, i) => {
      const msg = parseMessage(rm, `$.messages[${i}]`, terminals, tset, err);
      if (!msg) return;
      if (byId.has(msg.id)) {
        err(`$.messages[${i}].id`, `消息标识重复："${msg.id}"`);
        return;
      }
      byId.set(msg.id, msg);
      messages.push(msg);
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  // ---- 链结构：每台终端的事件序号必须 1..k 连续 ----
  const chainLen: Record<string, number> = {};
  for (const t of terminals) chainLen[t] = 0;
  for (const m of messages) chainLen[m.from] += 1;
  for (const t of terminals) {
    const seqs = messages
      .filter((m) => m.from === t)
      .map((m) => m.seq)
      .sort((a, b) => a - b);
    for (let k = 1; k <= seqs.length; k += 1) {
      if (seqs[k - 1] !== k) {
        err('$.messages', `终端 ${t} 的消息链不连续：缺少 ${t}#${k}`);
        break;
      }
    }
  }

  // ---- 因果上下文合法性：自身序号、不可观察未来、沿链单调不减 ----
  for (const t of terminals) {
    const chain = messages
      .filter((m) => m.from === t)
      .sort((a, b) => a.seq - b.seq);
    let prev: Vector | null = null;
    for (const m of chain) {
      const path = `$.messages[${m.id}].ctx`;
      if (m.ctx[t] !== m.seq) {
        err(path, `非法上下文：ctx["${t}"] 应等于自身序号 ${m.seq}，实际 ${m.ctx[t]}`);
      }
      for (const u of terminals) {
        const v = m.ctx[u] ?? 0;
        if (v > chainLen[u]) {
          err(path, `非法上下文：声称已见 ${u}#${v}，但 ${u} 全场景仅产生 ${chainLen[u]} 条消息`);
        }
        if (prev !== null && v < (prev[u] ?? 0)) {
          err(
            path,
            `非法上下文：相对上一条 ${t}#${m.seq - 1} 发生回退（${u}: ${prev[u] ?? 0} → ${v}），终端已见集合不可收缩`,
          );
        }
      }
      prev = m.ctx;
    }
  }

  // ---- 点标识复用：同一 dot 必须对应相同载荷，否则拒绝 ----
  const byDot = new Map<string, AddMessage[]>();
  for (const m of messages) {
    if (m.kind !== 'add') continue;
    const list = byDot.get(m.dot) ?? [];
    list.push(m);
    byDot.set(m.dot, list);
  }
  for (const [dot, adds] of byDot) {
    for (let i = 1; i < adds.length; i += 1) {
      if (!deepEqual(adds[0].tag, adds[i].tag)) {
        err(
          `$.messages[${adds[i].id}]`,
          `点标识复用："${dot}" 在 ${adds[0].id} 与 ${adds[i].id} 中载荷不同，须全局唯一`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // ---- 收件顺序：键为已知终端、引用已知消息、覆盖全部消息（保证收敛） ----
  const inbox: Record<string, string[]> = {};
  const rawInbox = root.inbox;
  if (typeof rawInbox !== 'object' || rawInbox === null || Array.isArray(rawInbox)) {
    err('$.inbox', 'inbox 必须是 { 终端: [消息id, ...] } 对象');
  } else {
    const ri = rawInbox as Record<string, unknown>;
    for (const key of Object.keys(ri)) {
      if (!tset.has(key)) err(`$.inbox.${key}`, `收件顺序属于未知终端 "${key}"`);
    }
    for (const t of terminals) {
      const list = ri[t];
      const path = `$.inbox.${t}`;
      if (!Array.isArray(list)) {
        err(path, `终端 ${t} 缺少收件顺序数组`);
        continue;
      }
      const ids: string[] = [];
      list.forEach((e, i) => {
        if (typeof e !== 'string' || !byId.has(e)) {
          err(`${path}[${i}]`, `引用了未知消息标识 ${JSON.stringify(e)}`);
        } else {
          ids.push(e);
        }
      });
      inbox[t] = ids;
    }
    if (errors.length === 0) {
      for (const t of terminals) {
        const have = new Set(inbox[t]);
        for (const m of messages) {
          if (!have.has(m.id)) {
            err(`$.inbox.${t}`, `收件顺序未覆盖消息 ${m.id}，该终端将无法收敛`);
          }
        }
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    scenario: {
      terminals,
      messages,
      messagesById: Object.fromEntries(byId),
      inbox,
    },
  };
}
