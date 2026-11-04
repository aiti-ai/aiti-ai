/**
 * demo — 扩展框架自检扩展：一键诊断所有扩展点是否正常。
 *
 * 仍覆盖全部插槽/钩子（框架验证用），但可见 UI 收敛为一个自检面板：
 *   toolbar / sidebar / sessionTopbar / chatInputTop 都只是打开面板的小入口；
 *   面板实时调用 server api（ping/counter/core）+ middleware，逐项 ✓/✗ + 延迟。
 *
 *   server.startup / shutdown / api / middleware / agent hooks 照旧（供自检调用）。
 *   ui: toolbar / sidebar / sessionTopbar / sessionRowActions / dialogs / banners /
 *       pages / chatInputTop / userMessageActions / i18n + chat hook。
 *
 *   client 是**双写法演示**（一个扩展可任选）：
 *     - client/demo-client.mjs —— 纯 hyperscript（h()）手写，零构建直接 serve；
 *     - client/demo-jsx.mjs —— JSX + TypeScript + npm 依赖（client/src/*.tsx 经
 *       vite 构建，tools/build-client.mjs）。入口 client/src/entry.tsx 同时装配
 *       两套：复用了 demo-client.mjs 的自检面板 + 新增 JSX 示例面板（toolbar ⚛️）。
 *
 *   JSX client 构建：npm run build:client（vite lib mode，react→host-shim 委托）。
 *
 * No type imports from pi-web — extensions live out-of-tree and use the
 * structural contract only (see lib/ext/types.ts for the shape).
 */

// M2a 前置验证（@aiti-ai/ext-shared 包化）：服务端运行时经 npm 包名 + exports 子路径
// import _shared 模块（.mjs 与 .ts 各一）——jiti walk-up 解析由 /api/extensions/demo/shared 自检。
import { extProtocolInfo } from "@aiti-ai/ext-shared/ext-protocol";
import { EXT_DISPLAY_NAMES } from "@aiti-ai/ext-shared/ext-display-names";

// 幽默彩蛋：注入注册 + 语料管理（见 server/humor*.ts）
import { maybeFetchHumor, pickRandomHumor, listHumor, fetchHumorBatch } from "./server/humor.ts";
import { registerHumorInjector, isEnabled, setEnabled } from "./server/humor-inject.ts";

const fs = require("node:fs");
const path = require("node:path");

// agent hooks 拿不到 ExtServerContext（只有 sessionInfo），configDir 用固定规则：
// ~/.pi/web/data/demo/config/（三目录对称；与框架 dataRoot 一致）。扩展也可改用 ctx.configDir。
// 数据分层：configDir 根级 = 配置；configDir/cache/ = 可删缓存（宿主保证 cacheDir === configDir/cache）。
function ctxConfigDir() {
  const env = process.env.PI_WEB_DATA_DIR;
  const root = env || path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web", "data");
  return path.join(root, "demo", "config");
}
function ctxCacheDir() {
  return path.join(ctxConfigDir(), "cache");
}

const COUNTER_FILE = "counter.json";
const HELLO_FILE = "hello.txt";

function readCounter(cacheDir) {
  try {
    const raw = fs.readFileSync(path.join(cacheDir, COUNTER_FILE), "utf8");
    return JSON.parse(raw).count ?? 0;
  } catch {
    return 0;
  }
}

function writeCounter(cacheDir, count) {
  fs.writeFileSync(path.join(cacheDir, COUNTER_FILE), JSON.stringify({ count, updatedAt: new Date().toISOString() }, null, 2));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  id: "demo",
  name: "扩展自检 (Demo)",
  version: "0.2.1",
  icon: "icon.svg",
  client: "dist/demo-jsx.mjs",

  // AI 自管理清单（M3）：声明后 aiti-helper 聚合 demo 的 AI 帮助点（skills/ 目录）。
  ai: {
    manage: true,
    intro: "demo 是扩展框架自检扩展：跑自检、看幽默彩蛋。AI 可以帮你执行各项检查。",
    skills: "skills", // 帮助点目录（缺省 "skills"）；skills/index.json 列 skill 名，每个 = skills/<name>/SKILL.md
  },

  server: {
    /** startup: prove config/cache dir provisioning + core access（数据分层示范：hello=配置，counter/语料=缓存）。 */
    async startup(ctx) {
      fs.writeFileSync(
        path.join(ctx.configDir, HELLO_FILE),
        `hello from demo ext at ${new Date().toISOString()}\n`,
      );
      writeCounter(ctx.cacheDir, readCounter(ctx.cacheDir) + 1);

      // 幽默彩蛋：注册注入源 + 异步预热语料（节流：距上次不足 6h 不拉）。
      registerHumorInjector(ctx.configDir, pickRandomHumor);
      maybeFetchHumor(ctx.cacheDir).catch(() => {});
    },

    async shutdown(ctx) {
      fs.writeFileSync(path.join(ctx.cacheDir, "shutdown.txt"), `shutdown at ${new Date().toISOString()}\n`);
    },

    /** api: /api/extensions/demo/<path> routes（自检面板逐项调用）。 */
    async api(req, ctx) {
      const [action] = ctx.path;
      if (action === "ping") return json({ pong: true, ts: Date.now() });

      // M2a 前置验证：@aiti-ai/ext-shared 子路径解析（.mjs + .ts 两路）；任一 import 失败整个扩展加载报错，此路由只验取值。
      if (action === "shared") {
        const info = extProtocolInfo("1.0");
        return json({
          protocol: { ok: info !== undefined, sample: info },
          displayNames: { ok: !!EXT_DISPLAY_NAMES, demo: EXT_DISPLAY_NAMES?.["demo"] ?? null, count: Object.keys(EXT_DISPLAY_NAMES || {}).length },
        });
      }

      if (action === "counter") {
        if (ctx.method === "POST") {
          const count = readCounter(ctx.cacheDir) + 1;
          writeCounter(ctx.cacheDir, count);
          return json({ count, updatedAt: new Date().toISOString() });
        }
        return json({ count: readCounter(ctx.cacheDir) });
      }

      if (action === "core") {
        const sessions = await ctx.core.listSessions();
        const running = await ctx.core.getRunningSessionIds();
        const home = await ctx.core.getHomeDir();
        return json({ sessionCount: sessions.length, runningCount: running.length, home, sample: sessions.slice(0, 2) });
      }

      if (action === "hello") {
        try {
          return json({ hello: fs.readFileSync(path.join(ctx.configDir, HELLO_FILE), "utf8").trim() });
        } catch {
          return json({ error: "no hello file" }, 500);
        }
      }

      // ---- 幽默彩蛋 ----------------
      if (action === "humor") {
        const [sub] = ctx.path.slice(1);
        if (sub === "random") {
          return json(pickRandomHumor(ctx.cacheDir));
        }
        if (sub === "refresh" && ctx.method === "POST") {
          // 强制刷新：绕过节流（管理员手动拉新）；失败静默返回当前状态
          try {
            const r = await fetchHumorBatch(ctx.cacheDir);
            return json({ ok: true, ...r });
          } catch {
            return json({ ok: false, error: "fetch failed" }, 502);
          }
        }
        if (sub === "toggle" && ctx.method === "POST") {
          const body = await req.json().catch(() => ({}));
          const on = Boolean(body.on);
          setEnabled(ctx.configDir, on);
          return json({ ok: true, enabled: on });
        }
        return json({ items: listHumor(ctx.cacheDir).items, enabled: isEnabled(ctx.configDir) });
      }

      return null; // 404
    },

    /** agent hooks（方案 M）：工具注入 + 会话生命周期事件。 */
    agent: {
      /** 注入一个 demo 工具：自检面板的「agent 工具」项依赖它。 */
      agentTools(info) {
        return [
          {
            name: "demo_ping", // 注意：provider 要求工具名匹配 ^[a-zA-Z0-9_-]+$，不能用冒号
            label: "Demo Ping", // SDK ToolDefinition 必填（UI 展示用）
            description: "Demo extension tool — returns the session cwd and a pong.",
            parameters: { type: "object", properties: {} }, // SDK 字段是 parameters（TypeBox），不是 inputSchema
            async execute() {
              return { pong: true, cwd: info.cwd };
            },
          },
        ];
      },
      /** 会话启动：写一行 agent 会话日志（数据目录）。 */
      onAgentSession(info) {
        try {
          fs.appendFileSync(
            path.join(ctxCacheDir(), "agent-sessions.log"),
            `[${new Date().toISOString()}] session ${info.sessionId} started (cwd=${info.cwd})\n`,
          );
        } catch { /* non-fatal */ }
      },
      /** 一轮执行完（agent_settled）：回显最终回答前 80 字符。 */
      onAgentSettled(info) {
        try {
          fs.appendFileSync(
            path.join(ctxCacheDir(), "agent-sessions.log"),
            `[${new Date().toISOString()}] ${info.sessionId} settled: ${String(info.text).slice(0, 80)}\n`,
          );
        } catch { /* non-fatal */ }
      },
    },

    /** middleware: 自检面板的「middleware」项直接 GET /demo-middleware 验证。 */
    async middleware(req) {
      // nextUrl.pathname strips the basePath (e.g. /dev); raw url keeps it.
      const nextUrl = req.nextUrl?.pathname;
      const path = nextUrl ?? new URL(req.url).pathname;
      if (path.startsWith("/demo-middleware")) {
        return {
          handled: true,
          response: new Response(`demo middleware handled ${path}`, {
            status: 200,
            headers: { "content-type": "text/plain", "cache-control": "no-store" },
          }),
        };
      }
      return { handled: false };
    },
  },

  ui: {
    toolbar: [{ id: "open", label: "demo 自检", title: "demo 扩展自检" }],
    sidebar: [{ id: "entry", label: "demo 自检", title: "demo 扩展自检", badge: false }],
    sessionTopbar: [{ id: "check", label: "🧪" }],
    sessionRowActions: [{ id: "demo-star", label: "demo 标记", title: "demo 会话标记（演示，非收藏）" }],
    dialogs: [{ id: "selfcheck", label: "demo 自检面板" }],
    banners: [{ id: "banner", label: "demo 横幅测试" }],
    pages: [{ id: "page", label: "demo 自检页面" }],
    chatInputTop: [{ id: "check", label: "🧪" }],
    // aiti-float dock v0.5.0 试点（dock 方案 §6）：右栏 tab 停靠 + 侧栏停靠区
    rightFileDock: [{ id: "dock-demo", label: "🧩 停靠示例" }],
    sidebarExplorerDock: [{ id: "dock-demo", label: "🧩 停靠示例" }],
    userMessageActions: [{ id: "demo-pin", label: "demo 标记", title: "demo：给消息打 demo 标记（本地演示，与收藏库无关）" }],
    // 新会话欢迎页小组件（渲染型；运行时注册在 client/src/entry.tsx，meta 携带尺寸/区域）
    newSessionWidgets: [{ id: "widget", label: "示例小组件" }],
    // client-modules 依赖边（启动图 inject）：informational，仅预取调度提示。
    clientDependsOn: [],
    // 能力接管示例（demo 不实际接管，写法见 lib/ext/types.ts EXT_PROVIDES）：
    // provides: ["session-delete"],
    i18n: {
      en: {
        "demo.title": "demo Extension self-check",
        "demo.open": "demo Self-check",
        "demo.close": "Close",
        "demo.rerun": "Re-run",
        "demo.check.api": "Server API (ping)",
        "demo.check.core": "Core data (sessions)",
        "demo.check.counter": "Cache dir (counter)",
        "demo.check.middleware": "Middleware (/demo-middleware)",
        "demo.check.client": "Client bundle (this panel)",
        "demo.check.agent": "Agent tool (demo_ping)",
        "demo.ms": "{ms} ms",
        "demo.ok": "OK",
        "demo.fail": "FAIL",
        "demo.bannerTest": "demo test banner (5s)",
        "demo.bannerText": "🧪 demo: banner slot works — auto-dismisses in 5s",
        "demo.toggleStar": "demo mark",
        "demo.pinTitle": "demo: mark this message locally (testing only; unrelated to favorites)",
        "jsx.title": "JSX Demo Panel",
        "jsx.close": "Close",
        "jsx.hint": "This panel is rendered by the JSX + npm client bundle (client/src/*.tsx → demo-jsx.mjs via vite). Compare with the hyperscript demo-client.mjs.",
        "jsx.jsx": "JSX syntax",
        "jsx.npm": "npm dependency: qrcode",
        "jsx.server": "Client ⇄ server",
        "jsx.fetch": "Fetch counter",
        "jsx.state": "How it works",
      },
      "zh-CN": {
        "demo.title": "demo 扩展自检",
        "demo.open": "demo 自检",
        "demo.close": "关闭",
        "demo.rerun": "重跑",
        "demo.check.api": "服务端 API（ping）",
        "demo.check.core": "核心数据（会话）",
        "demo.check.counter": "缓存目录（计数器）",
        "demo.check.middleware": "中间件（/demo-middleware）",
        "demo.check.client": "client bundle（本面板）",
        "demo.check.agent": "agent 工具（demo_ping）",
        "demo.ms": "{ms} ms",
        "demo.ok": "通过",
        "demo.fail": "失败",
        "demo.bannerTest": "demo 测试横幅（5 秒）",
        "demo.bannerText": "🧪 demo 横幅插槽正常 —— 5 秒后自动消失",
        "demo.toggleStar": "demo 标记",
        "demo.pinTitle": "demo：给消息打 demo 标记（本地演示，与收藏库无关）",
        "jsx.title": "JSX 示例面板",
        "jsx.close": "关闭",
        "jsx.hint": "本面板由 JSX + npm 的 client bundle 渲染（client/src/*.tsx → demo-jsx.mjs，vite 构建）；对比手写 hyperscript 的 demo-client.mjs。",
        "jsx.jsx": "JSX 语法",
        "jsx.npm": "npm 依赖：qrcode",
        "jsx.server": "client ⇄ server 联动",
        "jsx.fetch": "读取计数",
        "jsx.state": "原理",
      },
    },
  },
};
