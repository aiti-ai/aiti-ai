/**
 * 统一会话状态服务桥（pi-web.session，方案 docs/pi-web-session-state-and-perf-plan.md §4）。
 *
 * 轻模块（不引 React/重 chunk）：ai-speek 薄壳 register 时 install，重 chunk 组件经
 * getRootSessionId() 读取——**仅在会话 active 时返回 root id**，替代原先直读 URL
 * `?session=`（未验证 id 会对已删除会话产生幻影请求/读取）。服务缺席（旧宿主）
 * 静默降级：getRootSessionId() 恒 null（消费方走 props 通道）。
 */
let SVC_SESSION: { requestedId: string | null; id: string } | null = null;
let installed = false;

function applySessionSnapshot(snap: any): void {
  SVC_SESSION = snap && snap.phase === "active" && snap.sessionId
    ? { requestedId: snap.requestedId ? String(snap.requestedId) : null, id: String(snap.sessionId) }
    : null;
}

/** 挂载统一会话服务订阅（entry.tsx 调用一次）。 */
export function installSessionService(ctx: Record<string, any>): void {
  if (installed) return;
  installed = true;
  const attach = (): boolean => {
    const svc = ctx.getExtService?.("pi-web.session");
    if (!svc?.subscribe) return false;
    svc.subscribe(applySessionSnapshot);
    return true;
  };
  if (!attach()) {
    ctx.onExtServiceChange?.((key: string, phase: string) => {
      if (key === "pi-web.session" && phase === "up") attach();
    });
  }
}

/**
 * 服务 active 时的 root id（URL requestedId 优先，canonical 兜底）——消息列表/文本
 * 读取键。未确立（resolving）或失效（none/url-failed）→ null，消费方不得退回 URL 直读。
 */
export function getRootSessionId(): string | null {
  return SVC_SESSION ? (SVC_SESSION.requestedId || SVC_SESSION.id) : null;
}
