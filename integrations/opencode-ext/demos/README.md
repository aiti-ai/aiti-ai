# demos —— aiti-devtools-opencode 演示页

> 测试 aiti-devtools 在 **opencode web UI AI 窗**（`opencode.pi.example.com:8443` 调试口）上的完整链路。
> 结构对齐 `dsh-web-ext/demos/`（跳转/返回帧管理 + 错误候选）。

## 页面

| 文件 | 说明 |
|---|---|
| `page-a.html` | Demo A：注入 launcher，跳转 B / 返回 / 💥throw / 💥Promise 拒绝 |
| `page-b.html` | Demo B：与 A 互跳（JSON.parse 错误） |
| `serve.mjs` | 本地静态服务器（默认 8091） |

launcher 基址 `window.__AITI_BASE__` = `https://opencode.pi.example.com:8443`（调试口，免认证直通——
demo 页无需登录即可拉 launcher/连桥）。AI 窗 = 该口的 opencode web UI（nginx 已自动注入
`aiti-client-opencode.js`：剥 CSP + sub_filter + `/aiti/` 同源挂桥）。

## 运行

```bash
node demos/serve.mjs            # http://127.0.0.1:8091/page-a.html（AITI_DEMOS_PORT 可覆盖）
```

## 测试点（对照 dsh-web-ext/demos 的步骤，opencode 版语义）

1. 打开 `http://127.0.0.1:8091/page-a.html` → launcher 加载（console `[aiti] launcher 已启用`）。
2. **先开 AI 窗**（页面 💬 或直接开 `https://opencode.pi.example.com:8443/`）→ 桥会话出现 `<id>/host` 与 `<id>/ai`
   （`curl http://127.0.0.1:8777/aiti/bridge/sessions`）。
3. **错误候选**：AI 窗开着 → 点 💥 → opencode web UI 出现 `[错误N]` 红 chip → 点 chip 补占位符 → 发送 →
   会话里模型看到完整错误详情（插件 `messages.transform` 展开；发送后候选自动清——`aiti_consumed`）。
4. **元素候选**：Inspector 点选元素 → HUD ✓ → web UI 候选条 `[元素N]`（占位符区/描述区/✕/清空）→
   点描述区开详情（字段筛选/后台打开）。
5. **交互卡**：让模型调 `aiti_user_confirm`（如发送「用 aiti_user_confirm 问我要不要…」）→
   web UI 右下角渲染确认卡 → 点 ✅/❌ → 结果回模型。
6. **跳转/返回**：A→B→返回，桥会话切 URL/标题；agent 用 `aiti_page_exec`/`aiti_bridge_status` 观察帧管理。

## 与 dsh demos 的差异

- 桥基址：`opencode.pi.example.com:8443` 的 `/aiti/` 反代到独立桥 8777（非 DSH 进程内桥 3080）。
- 占位符展开：插件 `experimental.chat.messages.transform`（DSH 是 `agent/pre-step`）——
  **会话历史保留原占位符、只有 LLM 输入展开**（DSH 是历史也展开）。
- 8443 免认证（调试口），8443 生产口需 Authelia。
