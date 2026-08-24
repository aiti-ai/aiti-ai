/**
 * Composer 增强契约类型（去 fork 化 P1，见 docs/composer-enhancement-contract.md）。
 *
 * 目标：对 composer 的扩展差异（草稿持久化、队列 UI、输入增强…）从「原地修改
 * ChatInput」变为「机制之上的策略插件」。本文件只放类型；注册表与分发在 bus.ts。
 */

export interface ComposerSnapshot {
  value: string;
  /**
   * 已附加图片的持久化形态（base64 data，无 previewUrl）——与对象引用共享，
   * 仅在持久化时才序列化；高频 onChange 下无拷贝开销。
   */
  images: { data: string; mimeType: string }[];
  /** 便捷字段：images.length */
  imageCount: number;
  /** 框内有文字或图片（含用户正在输入的情况） */
  hasInput: boolean;
}

/** 扩展侧实现的增强器；core 在固定时机回调。所有回调同步、抛错被隔离。 */
export interface ComposerEnhancement {
  id: string;
  /** 值变化（用户输入 / 程序写入 / 清空）。高频——实现方自行节流。 */
  onChange?(snapshot: ComposerSnapshot): void;
  /** draftKey 切换（会话切换 / 新建会话提升 rekey）。undefined = 无 key（无 cwd 空态）。 */
  onKeyChange?(previousKey: string | undefined, nextKey: string | undefined): void;
  /** 发送前最后一步（清空之前）。可返回替换文本（链式）；返回 void/undefined = 原文放行。 */
  onSubmit?(text: string, imageCount: number): { text: string } | void;
}

/** core 提供给增强流程的受控写入口（经 bus 持有；ChatInput 装配）。 */
export interface ComposerWriter {
  snapshot(): ComposerSnapshot;
  /**
   * 程序化写值：React state 写入后由既有 [value] DOM 同步 effect 落 DOM，
   * 该 effect 经 writeTextareaValue（原生 setter + _valueTracker 同步）——
   * 绝不允许绕过此路径裸写 textarea.value（b30d131 教训）。
   */
  setValue(text: string): void;
}

/**
 * 恢复项提供者（P2：草稿簇等把残留输入并入恢复对话框；实现见
 * lib/composer/recovery.ts）。items 与服务端队列恢复项同一结构。
 */
export interface RecoveryItemsProvider {
  id: string;
  getItems(): unknown[];
  /** 订阅 items 变化（storage 事件等）；返回取消订阅函数。 */
  subscribe?(cb: () => void): () => void;
}
