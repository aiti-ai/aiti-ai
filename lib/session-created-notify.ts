import { publishPageEventToBus } from "./agent-page-events.ts";

/**
 * 会话文件/会话 id 创建成功（或即将创建）时广播——侧栏 session-manager 草稿行
 * 即时可见（pendingDraft 通道），不依赖 running 帧或宿主 refreshKey 顺带。
 *
 * cwd 用于前端把草稿行归入正确项目分组；origin 标记创建路径便于排查；
 * 重复广播幂等（消费端按 sessionId 去重）。
 *
 * ⚠ 必须走 publishPageEventToBus（宽发布）：直调 publishPageEvent 只进本 realm
 * 的 core sinks，跨 realm（Turbopack 模块分裂）下到不了 aiti-event-bus 总线——
 * session-manager 的帧源正是总线。实测详见 aiti-ai
 * docs/todo-session-created-sidebar-notify.md §1.1。
 */
export function notifySessionCreated(sessionId: string, cwd: string, origin?: string): void {
  try {
    publishPageEventToBus("sm:session-created", { sessionId, cwd, ...(origin ? { origin } : {}) });
  } catch { /* 广播失败不阻断创建 */ }
}
