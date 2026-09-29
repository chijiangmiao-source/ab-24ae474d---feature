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
  /** 消息涉及的航线区域（add=tag.zone，remove=zone），用于审计选区 */
  zone: string;
  ctx: Vector;
}

/* ===================== 延迟传播压力审计 ===================== */

/** 一个计步事件后，目标区域相对上一事件的分歧变化 */
export type DivergenceChange = 'created' | 'resolved' | 'persisted' | 'none';

/** 审计逐步事件：直接投递（应用/暂存）或暂存后的级联释放，每一次都计一步 */
export interface AuditStep {
  index: number; // 全局事件序号，从 1 开始（含级联释放）
  terminal: string; // 该事件发生的终端
  planIndex: number; // 该终端投递方案中的序号（释放事件沿用触发它的投递序号）
  messageId: string;
  kind: 'add' | 'remove';
  action: 'applied' | 'buffered' | 'released';
  reason: string; // 因果依据
  effect: string; // 状态影响
  divergent: boolean; // 本事件之后目标区域是否处于有效性分歧
  change: DivergenceChange;
  /** 各参与终端在本事件后对目标区域是否有效 */
  zoneEffective: Record<string, boolean>;
  stateAfter: Record<string, TerminalView>; // 全参与终端快照
}

/** 稳定裁决出的完整投递方案：每台参与终端的消息投递序列（每消息恰好一次） */
export interface AuditPlan {
  terminal: string;
  order: string[];
}

export interface AuditStats {
  rawTraceStates: number; // 单终端朴素轨迹状态数（副本状态 × 已投递掩码去重后）
  quotientClasses: number; // 行为等价商化后的商类数
  mergedStates: number; // 被等价合并的朴素状态数
  productStates: number; // 乘积 DP 访问的组合状态数
  productTransitions: number; // 乘积 DP 扩展的突发转移数
}

export type AuditResult =
  | { ok: false; requestType: 'audit'; errors: ValidationError[] }
  | {
      ok: true;
      requestType: 'audit';
      zone: string;
      terminals: string[]; // 参与审计的终端（按标识稳定排序）
      messageCount: number; // 源消息总数
      divergenceSteps: number; // 最大分歧持续事件步数
      eventCount: number; // 完整方案的总事件步数（直接投递 + 级联释放）
      plans: AuditPlan[];
      steps: AuditStep[];
      messages: Record<string, MessageSummary>;
      stats: AuditStats;
      detail: string;
    };

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
