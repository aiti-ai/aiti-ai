/**
 * 恢复/队列条目类型镜像（源：pi-web fork lib/queue-store.ts；keeper types.ts 同款
 * 镜像范式——扩展自持，不依赖 core 模块路径）。
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

export interface PendingRecoveryItem {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  queuedAt: number;
  /** Client-side synthetic entry for an unsent input draft (crash recovery). */
  origin?: "draft";
}
