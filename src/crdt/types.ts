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
