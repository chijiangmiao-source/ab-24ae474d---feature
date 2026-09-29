/**
 * 核心类型：点集（dot set）+ 因果上下文（版本向量）的 observed-remove 归并。
 *
 * - 每条消息是一个因果事件，事件标识为 `终端#序号`（如 `A#2`）。
 * - 新增（add）携带全局唯一点标识 dot 与标签载荷 tag；事件 id 即 OR-Set 中的“点”。
 * - 撤销（remove）按区域 zone 清除其产生时已观察到的点（由 ctx 版本向量界定）。
 * - 版本向量 ctx[T] = 产生消息时已应用的来自 T 的事件数（含本条自身）。
 */

export type Vector = Record<string, number>;

/** 禁飞标签载荷（集合元素的业务内容，元素身份 = zone） */
export interface TagPayload {
  zone: string;
  lat: number;
  lng: number;
  radiusKm: number;
  note?: string;
}

export interface AddMessage {
  kind: 'add';
  id: string; // 事件标识 "T#n"
  from: string; // 产生终端 T
  seq: number; // 该终端链上的序号 n（从 1 开始连续）
  dot: string; // 全局唯一点标识（业务侧）
  tag: TagPayload;
  ctx: Vector; // 产生时已见上下文（含自身），已归一化为全终端键
}

export interface RemoveMessage {
  kind: 'remove';
  id: string;
  from: string;
  seq: number;
  zone: string; // 撤销目标区域：清除 ctx 覆盖到的该区域全部观测点
  ctx: Vector;
}

export type Message = AddMessage | RemoveMessage;

export interface Scenario {
  terminals: string[];
  messages: Message[];
  messagesById: Record<string, Message>;
  inbox: Record<string, string[]>; // 每台终端的收件顺序（允许重复投递）
}

export interface ValidationError {
  path: string; // 出错位置（JSON 路径）
  message: string;
}

export interface ZoneDotView {
  dot: string; // 业务点标识
  events: string[]; // 支撑该点的存活事件 id
}

export interface ZoneView {
  zone: string;
  dots: ZoneDotView[];
}

/** 某台终端在某一时刻的可视状态 */
export interface TerminalView {
  vector: Vector;
  zones: ZoneView[]; // 有效标签（observed-remove 归并结果）
  pending: string[]; // 暂存队列（缺因果前序的消息）
  inboxDone: number;
  inboxTotal: number;
}

export type StepAction = 'applied' | 'duplicate' | 'buffered' | 'released';

export interface Step {
  index: number;
  round: number;
  terminal: string;
  messageId: string;
  kind: 'add' | 'remove';
  action: StepAction;
  reason: string; // 因果依据
  effect: string; // 状态影响
  stateAfter: Record<string, TerminalView>; // 全终端快照
}

export interface MessageSummary {
  id: string;
  kind: 'add' | 'remove';
  from: string;
  seq: number;
  label: string;
  ctx: Vector;
}

export type ReplayResult =
  | { ok: false; errors: ValidationError[] }
  | {
      ok: true;
      terminals: string[];
      steps: Step[];
      messages: Record<string, MessageSummary>;
      inboxSizes: Record<string, number>;
      converged: boolean;
      finalZones: string[];
      convergenceDetail: string;
    };

// ---- 延迟传播压力审计 ----

/** 审计轨迹中单台终端的快照 */
export interface AuditTerminalSnapshot {
  terminal: string;
  vector: Vector;
  /** 全部有效标签（observed-remove 归并结果） */
  zones: ZoneView[];
  /** 目标航线区域当前是否有效（存在存活点） */
  zoneValid: boolean;
  /** 目标区域存活点（点标识 -> 支撑事件） */
  zoneDots: ZoneDotView[];
  /** 暂存队列（缺因果前序、已投递但尚未应用的消息） */
  pending: string[];
  /** 已向该终端投递的消息条数（审计中每条恰好一次） */
  delivered: number;
}

/** 一次投递触发的暂存释放（级联中的一条） */
export interface AuditReleaseInfo {
  messageId: string;
  kind: 'add' | 'remove';
  reason: string;
  effect: string;
}

export type DivergenceChange = 'created' | 'resolved' | 'none';

/** 审计最优方案中的一次投递（每台终端 × 每条源消息恰好一条） */
export interface AuditStep {
  index: number;
  terminal: string;
  messageId: string;
  kind: 'add' | 'remove';
  action: StepAction; // 审计方案内无重复投递：仅 applied / buffered（释放见 releases）
  reason: string;
  effect: string;
  /** 本次应用补齐依赖后级联释放的暂存消息（按释放顺序） */
  releases: AuditReleaseInfo[];
  stateAfter: Record<string, AuditTerminalSnapshot>;
  /** 本次投递（含级联释放）后目标区域是否处于有效性分歧 */
  divergent: boolean;
  /** 本次投递是造成分歧、消除分歧还是维持现状 */
  divergenceChange: DivergenceChange;
}

export interface AuditStats {
  /** 搜索中求值的不同等价状态数 */
  statesEvaluated: number;
  /** 命中等价状态剪枝的次数 */
  memoHits: number;
}

export type AuditResult =
  | { ok: false; errors: ValidationError[] }
  | {
      ok: true;
      terminals: string[]; // 实际参与审计的终端（按标识稳定排序）
      zone: string;
      messages: MessageSummary[]; // 全部源消息（按消息标识稳定排序）
      steps: AuditStep[]; // 最优完整投递方案的逐步轨迹
      divergenceSteps: number; // 目标：分歧持续的投递步数
      totalDeliveries: number; // = 终端数 × 源消息数
      /** 从全局方案派生的各终端收件序列（不改动原 inbox） */
      terminalPlans: Record<string, string[]>;
      finalValid: Record<string, boolean>;
      converged: boolean;
      tieBreakRule: string;
      stats: AuditStats;
    };
