/**
 * aiti-float · 小屏「系统返回」关闭浮窗的接线（宿主退栈服务消费方）。
 *
 * 宿主历史退栈唯一写入口 = pi-web `lib/overlay-back.ts`（客户端服务 `pi-web.overlayBack`）。
 * 本模块是纯逻辑（零 DOM 依赖，便于单测）：维护「哪些面板可关闭」→ 小屏且服务可用时
 * 逐面板 acquire，面板离场 / 断点回大屏 / 服务下线 / 实例拆除时 release。
 * DOM 细节（找 ✕ 并点击）由 float.ts 经 ports.dismiss 注入。
 *
 * 注意：本模块不监听 popstate——两套栈会互踩历史条目（历史教训见 float.ts 头注释）。
 */
export interface OverlayBackHandle {
  release(): void;
}

export interface OverlayBackService {
  acquire(close: () => void): OverlayBackHandle;
}

export interface BackLayerPorts {
  /** 宿主服务（懒加载/旧宿主可能缺席）。 */
  getService(): OverlayBackService | null;
  /** 小屏断点（≤640px，与 data-ext-float-full / FULL_MQ 同款）。 */
  isSmallScreen(): boolean;
  /** 订阅断点变化（进小屏/回大屏都要重估注册态）。 */
  onSmallScreenChange(cb: () => void): () => void;
  /** 关闭面板（点面板自己的 ✕；由接入方提供 DOM 查找）。 */
  dismiss(panel: object): void;
}

export interface BackLayerManager {
  /** 面板出现且可关闭（有 ✕）：纳入管理，条件满足即注册返回层（幂等）。 */
  panelReady(panel: object): void;
  /** 面板离场 / 不可关闭：释放返回层并忘掉。 */
  panelGone(panel: object): void;
  /** 是否已纳入管理（调用方用它跳过重复的 DOM 查找）。 */
  knows(panel: object): boolean;
  /** 重估全部面板（断点变化/服务上线后手动触发）。 */
  syncAll(): void;
  /** 全量拆除（扩展实例 teardown）。 */
  dispose(): void;
  /** 当前已注册层数（自检/测试）。 */
  size(): number;
}

export function createBackLayerManager(ports: BackLayerPorts): BackLayerManager {
  const panels = new Set<object>();
  const held = new Map<object, OverlayBackHandle>();

  function release(panel: object): void {
    const handle = held.get(panel);
    if (!handle) return;
    held.delete(panel);
    try {
      handle.release();
    } catch {
      /* 宿主服务异常不阻断面板清理 */
    }
  }

  function sync(panel: object): void {
    const service = ports.getService();
    if (!panels.has(panel) || service === null || !ports.isSmallScreen()) {
      release(panel);
      return;
    }
    if (held.has(panel)) return;
    try {
      held.set(panel, service.acquire(() => ports.dismiss(panel)));
    } catch {
      /* 注册失败降级为「无返回关闭」，不抛 */
    }
  }

  function syncAll(): void {
    for (const panel of [...panels]) sync(panel);
  }

  const off = ports.onSmallScreenChange(syncAll);

  return {
    panelReady(panel) {
      panels.add(panel);
      sync(panel);
    },
    panelGone(panel) {
      panels.delete(panel);
      release(panel);
    },
    knows(panel) {
      return panels.has(panel);
    },
    syncAll,
    dispose() {
      off();
      panels.clear();
      for (const panel of [...held.keys()]) release(panel);
    },
    size() {
      return held.size;
    },
  };
}
