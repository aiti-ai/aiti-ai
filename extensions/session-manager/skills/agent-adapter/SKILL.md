---
name: agent-adapter
title: AI 帮我接入新 agent 的会话
placeholder: 描述要接入的 agent（如：帮我把 Windsurf 的会话接进 all sessions）…
---

# agent-adapter · 接入新的外部 agent 会话源

你是 session-manager 助手。用户想让 All Sessions 面板支持一个新的 AI 编码工具的会话。
目标：写一个**贡献方扩展**（不改 session-manager 源码），通过标准 slot 机制注册，
让新 agent 的会话出现在面板里，可查看、可搜索、可一键导入为 pi 会话继续聊。

## 第一步：判定存储形态

先探查目标 agent 在本机的会话存储（常见位置 `~/.<agent>/`、`~/.config/<Agent>/`、
`~/Library/Application Support/<Agent>/`），分四类：

| 形态 | 特征 | 难度 |
|---|---|---|
| JSONL 明文 | 每会话一个 .jsonl | ★ 最简单 |
| 单文件 JSON | 每会话一个 .json | ★ 简单 |
| SQLite 明文 | state.vscdb / *.db，表里有会话数据 | ★★ 中等 |
| 加密库 / 私有二进制 | 文件头不是 "SQLite format 3" | ★★★ 先调研可行性 |

用 `head -c 200 <文件>` 看结构；SQLite 用 `sqlite3 <file> ".tables"` 看表。

## 第二步：创建贡献方扩展（最小骨架）

新建扩展目录（如 `pi-web-ext/sm-xxx-source/`），两个文件：

**package.json**
```json
{ "name": "sm-xxx-source", "version": "0.1.0", "type": "module" }
```

**index.mjs** —— 完整模板（把 FIXTURE 换成真实解析）：
```js
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status,
    headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  id: "sm-xxx-source",
  name: "SM XXX Agent Source",
  version: "0.1.0",
  ui: { provides: ["session-agent-source"] },   // ← slot 声明，session-manager 据此发现你
  server: {
    async api(req, ctx) {
      const [section, op] = ctx.path;            // 路径 = [agent-source, <op>]
      if (section !== "agent-source") return null;
      const p = ctx.searchParams;
      if (op === "manifest") return json({
        agents: [{ id: "xxx", label: "XXX", dependencyHint: undefined }],
      });
      if (op === "list") return json({ sessions: [
        // id = 该 agent 内部的 sessionId；artifactPath 可选（能 stat 到的真实文件路径，
        // 用于增量水位；纯内存/远程源可不传）
        { id: "<sid>", artifactPath: "/home/u/.xxx/projects/a/b.jsonl" },
      ]});
      if (op === "session") return json(parseSession(p.get("sid")));
      return null;
    },
  },
};
```

parseSession(sid) 返回归一化结构（字段必须对齐）：

```js
{
  meta: {
    path: "<artifact 路径或虚拟标识>", id: "<sid>",
    cwd: "/项目绝对路径",          // 导入为 pi 会话时落盘目录，尽量提供
    name: "标题（可省略，兜底 firstMessage）",
    created: "ISO", modified: "ISO",
    messageCount: N, firstMessage: "...", lastMessage: "...",
  },
  messages: [
    { entryId: "1", role: "user"|"assistant"|"toolResult", ts: "ISO"|null,
      model?: "...", toolName?: "...", text: "消息文本" },
  ],
}
```

要点：
- **tool calls 降级为伪文本** `🛠 name(args)`（跨 agent 工具语义不通映射）
- **未知行类型必须跳过**，脏数据不能丢掉整个会话
- 注入块（system-reminder/environment_context 等）过滤掉，不进时间线
- 子 agent 侧链（如 CC 的 isSidechain）不在主时间线展示
- 大存储（SQLite）读副本不读原库（copy 到 /tmp 再开），避免锁冲突

## 第三步：部署 + 验证闭环

1. 把扩展目录拷到 `~/.pi/web-dev/extensions/<id>/`，然后
   `POST /api/extensions/reload`
2. `GET /api/extensions/session-manager/sources` → 新 agent 出现且 status=discovered
3. `POST .../sources/activate {"agent":"xxx"}` → ok:true 且 indexed≥1
4. `GET .../sessions` → 出现 `xxx:<sid>` 行；`GET .../session-ext?id=xxx%3A<sid>` 能看消息
5. `POST .../import {"id":"xxx:<sid>"}` → 返回新 pi sessionId，在 pi-web 打开续聊
6. 面板 UI 里：顶部源区出现卡片 → 点击加载 → 行带徽标 → 查看器可导入

## 常见坑

- **水位别全量读**：manifest 只做 stat/readdir 级探测，毫秒级返回
- **artifactPath 尽量给真实文件**：增量 sync 按 mtime/size 跳过未变会话；纯虚拟路径
  （memory:// 等）每次全量重解析，量大时慢
- **多会话共享同一 db 文件**：artifactPath 用 `file.db#session:<id>` 虚拟段即可，
  session-manager 会 stat 真实文件部分
- **id 冲突**：agent id 与内置（claude/qoder/codex/gemini/opencode/cursor/trae/dsh）
  同名时注册被跳过
- **加密库**：需要外部二进制时在 manifest 写 dependencyHint，并在 parse 失败时优雅降级

## 输出

自然语言说明：接入结果 + 发现/激活了多少会话 + 导入验证结论。若失败，给出卡在哪一步、
原因和修复建议。
