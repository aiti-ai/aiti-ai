/**
 * aiti-append-system · 追加系统提示词管理（APPEND_SYSTEM.md）
 *
 * 管理 pi 会话启动时追加进 system prompt 的两份提示词文件（pi resource-loader 契约）：
 *   - 全局：~/.pi/agent/APPEND_SYSTEM.md —— 所有项目的会话生效
 *   - 项目：<cwd>/.pi/APPEND_SYSTEM.md  —— 仅该项目的会话生效
 *
 * 能力：
 *   - 网页面板（📝）：全局 / 项目两个 tab，在线编辑 + 保存（空内容保存 = 删除文件，回到「未设置」态）
 *   - 🤖 ai-helper 帮助点（skills/write-append）：AI 帮用户起草追加提示词并直接写入
 *   - 工具条按钮 feature 门控默认关（behavior.showToolbar）；面板常驻 pages 插槽 —— 只能从扩展管理器打开
 *
 * 方案参照 aiti-model-check（feature 默认禁用 + extman 打开）。
 */
import { mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** project cwd 安全校验：绝对路径 + 目录在磁盘上存在（activeCwd 来自宿主页面状态；
 *  全新项目还没发过消息时不在已知会话列表里，不能拿会话白名单当唯一依据）。
 *  写入路径固定为 <cwd>/.pi/APPEND_SYSTEM.md，不受控输入只影响这个固定后缀目标。 */
function cwdAllowed(cwd: string): boolean {
  if (!cwd || !path.isAbsolute(cwd)) return false;
  try { if (!statSync(cwd).isDirectory()) return false; } catch { return false; }
  return true;
}

const globalPath = (home: string) => path.join(home, ".pi", "agent", "APPEND_SYSTEM.md");
const projectPath = (cwd: string) => path.join(cwd, ".pi", "APPEND_SYSTEM.md");

type FileInfo = { path: string; exists: boolean; size: number; mtime: number; content: string };

function readInfo(p: string): FileInfo {
  try {
    const st = statSync(p);
    return { path: p, exists: true, size: st.size, mtime: st.mtimeMs, content: readFileSync(p, "utf8") };
  } catch {
    return { path: p, exists: false, size: 0, mtime: 0, content: "" };
  }
}

/** 写入目标文件。返回动作：written / appended / deleted / absent（空内容 write 且本就不存在） */
function writeTarget(p: string, content: string, mode: "write" | "append"): string {
  if (mode === "append") {
    let prev = "";
    try { prev = readFileSync(p, "utf8"); } catch { /* 不存在 → 全新写 */ }
    const sep = prev && !prev.endsWith("\n") ? "\n" : "";
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, prev + sep + content.trim() + "\n");
    return "appended";
  }
  if (!content.trim()) {
    try { unlinkSync(p); return "deleted"; } catch { return "absent"; }
  }
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content.endsWith("\n") ? content : content + "\n");
  return "written";
}

export default {
  id: "aiti-append-system",
  name: "追加系统提示词（APPEND_SYSTEM.md 管理）",
  icon: "icon.svg",
  client: "dist/aiti-append-system-client.mjs",

  ai: {
    manage: true,
    intro: "帮用户起草并写入追加系统提示词（pi 的 APPEND_SYSTEM.md：全局 ~/.pi/agent/ 或项目 <cwd>/.pi/），让 AI 会话永久记住规则（aiti-append-system）",
    skills: "skills",
  },

  ui: {
    toolbar: [
      { id: "aiti-append-system-open", label: "提示词", title: "aiti-append-system：追加系统提示词（全局 / 项目）", icon: "icons/pen-line.svg" },
    ],
    pages: [{ id: "aiti-append-system-panel", label: "追加系统提示词" }], // 实际注册在 pages 插槽（client），声明与之一致
  },

  // 功能管理：工具条按钮默认隐藏（低频入口；面板从扩展管理器「打开」进入）。
  features: [
    { id: "behavior.showToolbar", label: "顶部工具条显示「提示词」按钮", group: "UI",
      description: "默认隐藏：面板从扩展管理器「打开」进入；打开后顶部工具条常显按钮", default: false },
  ],

  server: {
    async api(req, ctx) {
      const p = ctx.path || [];
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const home = await ctx.core.getHomeDir();

      // GET /files?cwd= → 两份文件现状（内容 + 存在性 + 大小/修改时间）
      if (p[0] === "files" && p.length === 1 && req.method === "GET") {
        const cwd = ctx.searchParams.get("cwd") || "";
        let project: FileInfo | { error: string; path?: string } = { error: "当前页面没有项目（无 cwd）" };
        if (cwd) {
          if (cwdAllowed(cwd)) project = readInfo(projectPath(cwd));
          else project = { error: "cwd 无效（需绝对路径且目录存在）", path: projectPath(cwd) };
        }
        return json({ ok: true, global: readInfo(globalPath(home)), project, cwd });
      }

      // POST /save { scope: "global"|"project", cwd?, content, mode?: "write"|"append" }
      //   write + 空内容 = 删除文件（回到「未设置」）；append = 追加到现有内容后
      if (p[0] === "save" && p.length === 1 && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const content = typeof (body && body.content) === "string" ? (body as any).content : null;
        if (content == null) return json({ ok: false, error: "需要 content（字符串）" }, 400);
        const scope = (body as any).scope === "project" ? "project" : "global";
        const mode: "write" | "append" = (body as any).mode === "append" ? "append" : "write";
        let target: string;
        if (scope === "project") {
          const cwd = String((body as any).cwd || "");
          if (!cwdAllowed(cwd)) {
            return json({ ok: false, error: "项目级写入需要有效 cwd（绝对路径且目录存在）" }, 403);
          }
          target = projectPath(cwd);
        } else {
          target = globalPath(home);
        }
        let action: string;
        try { action = writeTarget(target, content, mode); } catch (e: any) {
          return json({ ok: false, error: "写入失败：" + ((e && e.message) || e) }, 500);
        }
        return json({ ok: true, action, scope, mode, path: target, info: readInfo(target) });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  },
};
