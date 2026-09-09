/**
 * 队列面板契约（去 fork 化 P3，见 docs/pi-web-queue-cluster-ext-plan.md）。
 *
 * 目标：把 ChatInput 内 ~900–1000 行队列增强 UI（横幅/行操作/回收站/撤销条/
 * 导入导出/通知/拖拽）从「原地修改 ChatInput」外迁为扩展 aiti-queue-keeper
 * 经 queuePanel 插槽渲染；core 回到「上游同形机制 + 薄接入」（兜底 banner +
 * ExtSlot 单行接入 + edit-intent 检查）。
 *
 * 与既有 composer 契约（值观测/写值/恢复项）同源：core 保机制（rpc-manager
 * 队列持久化/12 RPC 全部留核），扩展保策略（UI 消费 actions 原语）。
 *
 * 方向：
 *   core → ext   QueuePanelProps（live/trash 视图 + actions 原语）经插槽传入
 *   ext  → core  QueuePanelController（expand：恢复/导入解析后强制展开面板）
 *
 * 数据零迁移：sidecar/trash 全在 core（rpc-manager），扩展无自有存储——关停
 * 扩展只是回到兜底 banner，任何状态下数据无损。
 */
import type {
  QueueEntry,
  QueueEntryInput,
  QueueImage,
  QueueKind,
  QueueTrashItem,
} from "../queue-store";
import type { QueueExportMeta } from "../queue-export";

export type { QueueExportMeta };
export type {
  QueueEntry,
  QueueEntryInput,
  QueueImage,
  QueueKind,
  QueueTrashItem,
};

/** 行视图（core 从 queueMirror 投影，脱掉图片 base64——扩展需要时经 recallOne 取）。 */
export interface QueueEntryView {
  id: string;
  kind: QueueKind;
  text: string;
  hasImages: boolean;
  queuedAt: number;
  index: number;
}

/** 队列 live 视图（与 core queuedMessages 同形状的投影）。 */
export interface QueueLiveView {
  steering: QueueEntryView[];
  followUp: QueueEntryView[];
}

/** 扩展侧可调用的队列操作原语（core 全部转发既有 RPC 处理器；无扩展时核心兜底不依赖它们）。 */
export interface QueuePanelActions {
  /** 队列内移动（clear + re-enqueue）。 */
  move(kind: QueueKind, from: number, to: number): Promise<boolean>;
  /** 转换条目类型（steer ↔ followUp）。 */
  convert(kind: QueueKind, index: number, target: QueueKind): Promise<boolean>;
  /** 取回单条到输入框（core 同时置 edit-intent）；返回文本供 ext 展示。 */
  recallOne(kind: QueueKind, index: number): Promise<{ text: string } | null>;
  /** 取回编辑后按原位置放回。 */
  requeueAt(kind: QueueKind, index: number, text: string, images?: QueueImage[]): Promise<boolean>;
  /** 删除单条（软删 → trash；permanent 跳过 trash）。返回删除的条目视图（undo 用）。 */
  remove(kind: QueueKind, index: number, opts?: { permanent?: boolean }): Promise<QueueTrashItem | null>;
  /** 从回收站恢复（可选 index 放回原 kind 内位置）。 */
  restore(id: string, index?: number): Promise<boolean>;
  /** 永久删除回收站条目（省略 ids = 清空整个回收站）。 */
  purge(ids?: string[]): Promise<boolean>;
  /** 全部取回（清空 live 队列，文本合并进输入框）。 */
  recallAll(): void;
  /** 队列首条插队为 steer（扩展负责在插队后调用 remove 移除首条，permanent）。带图条目图片随发。 */
  steerSend(text: string, images?: QueueImage[]): void;
  /** 导出（live + recovery 全量数据）。 */
  exportAll(): Promise<{ live: QueueEntry[]; recovery: QueueEntry[] } | null>;
  /** 触发浏览器下载（md/json；core 实现，单来源）。 */
  downloadExport(entries: QueueEntry[], meta: QueueExportMeta, format: "md" | "json"): void;
  /** 解析导入文件文本（core 纯函数；非法条目跳过，坏文件返回空数组）。 */
  parseImport(content: string): QueueEntryInput[];
  /** 导入条目（服务端分配 id；返回入队数量）。 */
  importEntries(entries: QueueEntryInput[]): Promise<number | null>;
  /** 导入条目暂存为 pending recovery（弹出恢复对话框）。 */
  stageImport(entries: QueueEntryInput[]): Promise<number | null>;
}

/** queuePanel 插槽的 extra props（core → ext 单向数据 + actions 原语）。 */
export interface QueuePanelProps {
  /** live 队列投影（文本视图，图片信息仅 hasImages 标记）。 */
  live: QueueLiveView;
  /** 回收站条目（软删；可恢复）。 */
  trash: QueueTrashItem[] | null;
  queueCount: number;
  trashCount: number;
  /** 全部队列操作原语。 */
  actions: QueuePanelActions;
  /** 小屏适配（与 core useIsMobile 同源）。 */
  isMobile?: boolean;
  /** 粗指针（触屏）判定——扩展无 useIsCoarsePointer hook，由核心传入（HTML5 drag vs touch drag）。 */
  isCoarsePointer?: boolean;
  /** steer 只读（外部 agent 后端，如 zcode:/codex:）：条目已注入后端 CLI 进程的 steer
   *  队列（工具间隙自动消费），协议不支持撤回/移动/转换——对这些条目的管理操作一律
   *  报 AgentCommandError。扩展应隐藏 steer 条目的行级操作仅展示；core 兕底 banner
   *  本就纯展示不受影响。内置 pi 后端（无前缀/ new: 草稿）恒 false。 */
  steerReadonly?: boolean;
}

/** ext → core 反向通道（bus 注册；core 恢复流等调用，无接管时 no-op）。 */
export interface QueuePanelController {
  /** 恢复/导入解析后强制展开队列面板。 */
  expand(): void;
  /** 跨组件通知（可选：ext 自渲染则不注册；核心兜底 banner 无折叠态不需要）。 */
  notice?(text: string, ok: boolean): void;
}

let controller: QueuePanelController | null = null;

/** 注册队列面板控制器；返回 disposer（精确移除本次注册）。传 null = 卸载。 */
export function registerQueuePanelController(c: QueuePanelController | null): () => void {
  controller = c;
  return () => {
    if (controller === c) controller = null;
  };
}

/** 同步读取当前控制器（core 恢复流调用；未接管返回 null）。 */
export function getQueuePanelController(): QueuePanelController | null {
  return controller;
}

/** 测试辅助：清空状态（生产代码勿调）。 */
export function resetQueuePanelControllerForTests(): void {
  controller = null;
}
