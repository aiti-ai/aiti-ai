/**
 * session-manager — built-in agent adapter registry.
 *
 * M1 ships four jsonl/json sources. SQLite-backed sources (Cursor, OpenCode,
 * Trae) land in M2; third-party sources register via the standard slot
 * mechanism (EXT_PROVIDES "session-agent-source" / register API — plan §4.6).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AgentAdapter } from "./types.ts";
import { createClaudeLikeAdapter } from "./claude-like.ts";
import { createCodexAdapter } from "./codex.ts";
import { createGeminiAdapter } from "./gemini.ts";
import { createOpencodeAdapter } from "./opencode.ts";
import { createCursorAdapter } from "./cursor.ts";
import { createCursorCliAdapter } from "./cursor-cli.ts";
import { createTraeAdapter } from "./trae.ts";
import { createDshAdapter } from "./dsh.ts";
import { createKimiAdapter } from "./kimi.ts";
import { createAntigravityAdapter } from "./antigravity.ts";
import { createOpenclawAdapter } from "./openclaw.ts";
import { createCopilotAdapter } from "./copilot.ts";
import { createZedAdapter } from "./zed.ts";
import { createClineFamilyAdapter } from "./cline.ts";
import { createWindsurfAdapter } from "./windsurf.ts";
import { createZcodeAdapter } from "./zcode.ts";
import { createCodebuddyAdapter } from "./codebuddy.ts";
import { createGooseAdapter, createAmpAdapter, createFactoryAdapter } from "./simple-cli.ts";
// ACP 家族补齐（2026-11-08，acp-agents.ts）：omp/kiro/auggie/vibe 直读 + qwen 复用 gemini 形状。
// grok/junie/hermes 暂缺——CLI 在开发机被墙/未登录，store 形状不可观测；首次真实装机后照
// acp-agents.ts 先例补（acp-agents.ts 头注有各自证据链）。
import { createOmpAdapter, createKiroAdapter, createAuggieAdapter, createVibeAdapter } from "./acp-agents.ts";

export function builtinAdapters(): AgentAdapter[] {
  return [
    createClaudeLikeAdapter("claude", "Claude Code", ".claude", "projects"),
    createClaudeLikeAdapter("qoder", "Qoder", ".qoder", "projects"),
    // QoderCN（中国版）：行形状与 claude 同构（fork），目录 ~/.qoder-cn/projects/
    createClaudeLikeAdapter("qodercn", "QoderCN", ".qoder-cn", "projects"),
    createCodexAdapter(),
    createGeminiAdapter(),
    // Qwen Code（gemini-cli fork）：store 同构 ~/.qwen/tmp/<hash>/chats/ —— id "qwen" 对齐 aiti-acp-agent 后端
    createGeminiAdapter(".qwen", "qwen", "Qwen Code"),
    createOpencodeAdapter(),
    // Cursor Agent CLI（cursor-agent）会话 —— id "cursor" 对齐 aiti-cursor-agent 后端（open-live 接管直通 --resume）
    createCursorCliAdapter(),
    createCursorAdapter(),
    createTraeAdapter(),
    createDshAdapter(),
    // cc-connect 家族：iFlow CLI 用 Claude-Code 同构 jsonl（projects/<key>/<sid>.jsonl）
    createClaudeLikeAdapter("iflow", "iFlow", ".iflow", "projects"),
    createKimiAdapter(),
    createAntigravityAdapter(),
    createOpenclawAdapter(),
    createCopilotAdapter(),
    createZedAdapter(),
    createClineFamilyAdapter(),
    createGooseAdapter(),
    createAmpAdapter(),
    createFactoryAdapter(),
    createWindsurfAdapter(),
    // ZCode（智谱桌面端内嵌 CLI）：id "zcode" 对齐 aiti-zcode-agent 后端（open-live 接管直通 --resume）；
    // 本 adapter 也是 zcode 会话的唯一读取实现（services.sessions 出口消费）
    createZcodeAdapter(),
    // ACP 家族 2026-11-08 批次：id 对齐 aiti-acp-agent 后端 agentKey（open-live 接管走 session/load）
    createOmpAdapter(),
    createKiroAdapter(),
    createAuggieAdapter(),
    createVibeAdapter(),
    // CodeBuddy Code（腾讯 cbc）：行形状与 claude 非同构（顶层 role/content + 数字毫秒），
    // 独立实现见 codebuddy.ts；id "codebuddy" 对齐 aiti-codebuddy-agent 后端（open-live 直通 --resume）
    createCodebuddyAdapter(),
  ];
}

/**
 * 具备 A03 真归档三原语的 agent id（snapshot + removeSession + putBack）——
 * 📦 菜单按这份名单显隐「真归档」项。判据与服务端 runExtArchive 的硬门槛
 * （server/runtime.ts）对齐，并额外要求 putBack：能归档必须能放回，否则
 * 会话只是被搬进 .pwarc 而 UI 承诺的「可放回」落空。
 * 第三方 provider 源（server/ext-sources.ts proxyAdapter）只转发读端点、
 * 没有写回原语，天然不在表内。构造零 IO（adapter 工厂只算路径），结果常驻。
 */
let archiveCapableIds: string[] | null = null;
export function archiveCapableAgents(): string[] {
  if (!archiveCapableIds) {
    archiveCapableIds = builtinAdapters()
      .filter((a) => a.capabilities?.remove && a.snapshot && a.removeSession && a.putBack)
      .map((a) => a.id)
      .sort();
  }
  return archiveCapableIds;
}

/** Cheap existence check for the source-area card (never parses contents). */
export function rootExists(roots: string[]): boolean {
  if (!roots.length) return false;
  return roots.some((r) => existsSync(r));
}

/** Resolve ~ in declarative root lists (third-party descriptors). */
export function expandRoots(roots: string[]): string[] {
  const home = homedir();
  return roots.map((r) => (r.startsWith("~/") ? join(home, r.slice(2)) : r));
}
