/**
 * sm-demo-source — session-manager 第三方 agent source 贡献方示例（§4.8）。
 *
 * 契约三步：
 *  1. `ui.provides: ["session-agent-source"]` 声明能力 → session-manager 发现你
 *  2. GET agent-source/manifest → { agents: [{ id, label, dependencyHint? }] }
 *  3. GET agent-source/list?agent= / agent-source/session?agent=&sid=
 *     → 归一化 JSON（对齐 session-manager 内部 SessionFileMeta + IndexedMessage）
 *
 * 解析逻辑跑在你自己的进程里（你的代码你的依赖）；本示例用一个内置 fixture
 * 模拟一个虚构 agent "demobot"，真实实现换成读任意存储即可。
 */

const FIXTURE_SESSIONS = {
  sessions: [
    { id: "demo-001", artifactPath: "memory://demobot/demo-001" },
    { id: "demo-002", artifactPath: "memory://demobot/demo-002" },
  ],
};

const FIXTURE_DATA = {
  "demo-001": {
    meta: {
      path: "memory://demobot/demo-001",
      id: "demo-001",
      cwd: "/tmp/demo-bot",
      name: "Demo：问候",
      created: "2026-08-24T10:00:00.000Z",
      modified: "2026-08-24T10:05:00.000Z",
      messageCount: 2,
      firstMessage: "你好，介绍一下你自己",
      lastMessage: "我是 demobot，一个演示用 agent source。",
    },
    messages: [
      { entryId: "1", role: "user", ts: "2026-08-24T10:00:01.000Z", text: "你好，介绍一下你自己" },
      { entryId: "2", role: "assistant", ts: "2026-08-24T10:00:05.000Z", model: "demo-model-1", text: "我是 demobot，一个演示用 agent source。这个会话来自第三方扩展注册链路。" },
    ],
  },
  "demo-002": {
    meta: {
      path: "memory://demobot/demo-002",
      id: "demo-002",
      cwd: "/tmp/demo-bot",
      name: "Demo：工具调用",
      created: "2026-08-24T11:00:00.000Z",
      modified: "2026-08-24T11:02:00.000Z",
      messageCount: 3,
      firstMessage: "列出当前目录文件",
      lastMessage: "目录里有 hello.txt。",
    },
    messages: [
      { entryId: "1", role: "user", ts: "2026-08-24T11:00:01.000Z", text: "列出当前目录文件" },
      { entryId: "2", role: "assistant", ts: "2026-08-24T11:00:30.000Z", toolName: "ls", text: "🛠 ls /tmp/demo-bot" },
      { entryId: "3", role: "assistant", ts: "2026-08-24T11:01:00.000Z", model: "demo-model-1", text: "目录里有 hello.txt。" },
    ],
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export default {
  id: "sm-demo-source",
  name: "SM Demo Agent Source",
  version: "0.1.0",

  ui: {
    // §4.8：声明 slot 能力 —— session-manager 据此自动发现本扩展
    provides: ["session-agent-source"],
  },

  server: {
    async api(req, ctx) {
      const [section, op] = ctx.path;
      if (section !== "agent-source") return null;
      const params = ctx.searchParams;

      if (op === "manifest") {
        return json({
          agents: [{ id: "demobot", label: "Demo Bot", dependencyHint: undefined }],
        });
      }
      if (op === "list") {
        if (params.get("agent") !== "demobot") return json({ error: "unknown agent" }, 404);
        return json(FIXTURE_SESSIONS);
      }
      if (op === "session") {
        if (params.get("agent") !== "demobot") return json({ error: "unknown agent" }, 404);
        const d = FIXTURE_DATA[params.get("sid") ?? ""];
        return d ? json(d) : json({ error: "not found" }, 404);
      }
      return null;
    },
  },
};
