/**
 * demo「新会话欢迎页小组件」示例（newSessionWidgets 插槽，宿主方案
 * docs/pi-web-new-session-widgets-plan.md）。
 *
 * 演示三件事：
 *   1. 注册 meta 标注（areas/defaultArea/w/h）→ 宿主栅格摆位与面板定制；
 *   2. 插槽 extra 只喂数据 { cwd, isMobile, area }——组件纯展示，不发请求；
 *   3. 跨区移动：本卡允许 top/bottom 两区，用户可在「自定义小组件」面板里搬。
 *
 * 动作类 widget 的参考：动作不塞回调（插槽 extra 红线），走 ctx 服务，如
 *   const svc = ctx.getExtService?.("pi-web.session"); svc?.open?.(id);  // 旧宿主判空降级
 */
export function WidgetDemoCard(props: { cwd?: string | null; isMobile?: boolean; area?: string }) {
  const cwd = props.cwd ?? null;
  const shortCwd = cwd ? cwd.replace(/^\/home\/[^/]+/, "~") : null;
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        border: "1px dashed var(--border)",
        borderRadius: 10,
        padding: "0 12px",
        background: "var(--bg)",
        overflow: "hidden",
      }}
    >
      <span style={{ fontSize: 16, flexShrink: 0 }}>🧩</span>
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: 12, color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          示例小组件（demo）
        </span>
        <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          area={props.area ?? "?"} · cwd={shortCwd ?? "—"}
        </span>
      </div>
    </div>
  );
}
