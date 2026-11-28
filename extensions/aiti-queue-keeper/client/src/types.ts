/**
 * aiti-queue-keeper 扩展侧契约类型（pi-web lib/composer/queue-api.ts 的结构镜像）。
 *
 * 扩展在 pi-web 仓外（不 import core），靠结构契约消费 queuePanel 插槽 props。
 * 变更时与 core queue-api.ts 保持同步（类型级文档；运行时靠 loader 保证）。
 */

export type QueueKind = "steer" | "followUp" | "composer";

export interface QueueImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface QueueEntry {
  id: string;
  kind: QueueKind;
  text: string;
  images?: QueueImage[];
  queuedAt: number;
}

export interface QueueEntryInput {
  kind: QueueKind;
  text: string;
  images?: QueueImage[];
}

export interface QueueTrashItem {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  queuedAt: number;
}

export interface QueueEntryView {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  /** 前向兼容：队列链路尚不支持文件附件（pi steer/followUp 仅图片），恒 false。 */
  hasFiles?: boolean;
  queuedAt: number;
  index: number;
}

export interface QueueLiveView {
  steering: QueueEntryView[];
  followUp: QueueEntryView[];
}

export interface QueueExportMeta {
  sessionId?: string;
  source: "live" | "recovery";
  exportedAt?: string;
}

/** queuePanel 插槽 extra props（core → ext）。 */
export interface QueuePanelProps {
  live: QueueLiveView;
  trash: QueueTrashItem[] | null;
  queueCount: number;
  trashCount: number;
  actions: QueuePanelActions;
  isMobile?: boolean;
  isCoarsePointer?: boolean;
  /** steer 只读（按能力位判定，非 sessionId 前缀）：后端有 steer 注入面、但条目已注入对端
   *  进程（zcode 这类 CLI 后端），协议不支持撤回/移动/转换——面板应隐藏 steer 条目行级操作
   *  仅展示；本地 pi 与 pi 协议后端（remote-queue 变更即重注入）保持可管理
   *  （与 pi-web queue-api.ts 契约镜像）。 */
  steerReadonly?: boolean;
}

/** 扩展可调用的队列操作原语（core 转发既有 RPC 处理器）。 */
export interface QueuePanelActions {
  move(kind: QueueKind, from: number, to: number): Promise<boolean>;
  convert(kind: QueueKind, index: number, target: QueueKind): Promise<boolean>;
  recallOne(kind: QueueKind, index: number): Promise<{ text: string } | null>;
  requeueAt(kind: QueueKind, index: number, text: string, images?: QueueImage[]): Promise<boolean>;
  remove(kind: QueueKind, index: number, opts?: { permanent?: boolean }): Promise<QueueTrashItem | null>;
  restore(id: string, index?: number): Promise<boolean>;
  /** 从回收站恢复到输入框（仅 kind="composer" 的输入清除条目；回填后继续编辑）。 */
  restoreToComposer(id: string): Promise<boolean>;
  purge(ids?: string[]): Promise<boolean>;
  recallAll(): void;
  /** Send the queue head as a steer (the extension then removes it itself via remove(permanent)).
   *  Presence is the capability: core omits it when the backend declares steer:false or there is no
   *  steer surface at runtime; the panel must then hide every "steer this entry" affordance — calling
   *  through would remove the entry without sending it, i.e. silently swallow input (mirrors pi-web
   *  lib/composer/queue-api.ts).
   *  The returned promise resolves once the backend ACCEPTED the steer: the extension must await it
   *  before removing the entry. On pi/omp a removal is clear + re-enqueue, so a removal racing the
   *  send clears the row the send just created (the message disappears, never steered). */
  steerSend?(text: string, images?: QueueImage[]): void | Promise<void>;
  exportAll(): Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>;
  downloadExport(entries: QueueEntry[], meta: QueueExportMeta, format: "md" | "json"): void;
  parseImport(content: string): QueueEntryInput[];
  importEntries(entries: QueueEntryInput[]): Promise<number | null>;
  stageImport(entries: QueueEntryInput[]): Promise<number | null>;
}

/** ext → core 反向通道（bus 注册）。 */
export interface QueuePanelController {
  expand(): void;
  notice?(text: string, ok: boolean): void;
}
