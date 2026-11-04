/**
 * session-manager — self-contained .jsonl session-file parser.
 *
 * The extension lives out-of-tree and cannot import pi-web core, so this
 * mirrors the SDK's field semantics (id/cwd/name/created/modified/
 * messageCount/firstMessage + per-message text) for the message index.
 */

export interface SessionFileMeta {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  lastMessage: string;
  parentSessionPath?: string;
  /** 站位文件标记：外部 agent 键（cursor/claude/...，header.agent）。 */
  agent?: string;
  /** 站位文件标记：外部复合 id（"cursor:<chatId>"，header.extId）。 */
  extId?: string;
  /**
   * 外部源内父会话原生 sid（同一 agent 源内，非复合 id）：子代理会话标识
   * （zcode session.parent_id，task_type=subagent_child）。syncExt 落库
   * sessions.parent_sid，API 层组合 `${agent}:${sid}` 成 parentSessionId →
   * 前端父子树嵌套 + 🤖 徽标原生生效。父会话不在索引时子行仍是根节点（仅徽标）。
   */
  parentSid?: string;
  /** 会话模型（外部后端可解析时：最近一条 assistant 的模型 ref，如 "bigmodel/GLM-5.3"）。 */
  model?: string;
}

export interface IndexedMessage {
  entryId: string;
  role: string;
  ts: string | null;
  model?: string;
  provider?: string;
  toolName?: string;
  text: string;
  /** 消息内嵌图片（zcode 附件等；dataUrl 完整 data: URL）。预览/回放共用。 */
  images?: Array<{ mime: string; filename?: string; dataUrl: string }>;
  /** 结构化工具调用（opencode 系 + claude-like 系 + codex 系 adapter 携带；seedHistory 回放成 pi 形状
   *  toolCall/toolResult，前端按原生工具卡片渲染。text 仍是 🛠 兜底展示行，其它消费方零感知。
   *  claude-like 只在「该行仅一个 tool_use 且无正文」时给出——混排行带上会丢正文）。 */
  tool?: {
    callID?: string;
    name: string;
    input: Record<string, unknown> | null;
    output?: string;
    isError?: boolean;
  };
}

export interface ParsedSessionFile {
  meta: SessionFileMeta;
  messages: IndexedMessage[];
  /** 会话操作过的文件（read/edit/write 等 toolCall 的 path 参数；按「改过优先 → 触达次数 → 首次出现」排序，上限 100） */
  files: string[];
}

function isMessageWithContent(m: unknown): boolean {
  return typeof m === "object" && m !== null && typeof (m as { role?: unknown }).role === "string" && "content" in m;
}

function extractText(m: unknown): string {
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => ((b as { text?: unknown }).text ?? "") as string);
  if (texts.join("").trim()) return texts.join(" ");
  // No text block — assistant turns that only contain tool calls (no prose)
  // were silently dropped from the index, so big sessions looked "缺了好多".
  // Render toolCall blocks as a searchable/visible pseudo-text.
  const calls = content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "toolCall")
    .map((b) => {
      const t = b as { name?: unknown; arguments?: unknown };
      const args = typeof t.arguments === "string" ? t.arguments : t.arguments ? JSON.stringify(t.arguments) : "";
      return `🛠 ${t.name ?? "tool"}${args ? " " + args.slice(0, 400) : ""}`;
    });
  return calls.join("\n");
}

/**
 * 从 assistant 消息的 toolCall content 块收集被操作文件路径。
 * 取 arguments.path（read/edit/write 及同类工具）；相对路径按会话 cwd 解析；URL 排除。
 */
function toolCallFilePaths(content: unknown[], cwd: string): Array<{ path: string; modified: boolean }> {
  const out: Array<{ path: string; modified: boolean }> = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    const blk = b as { type?: unknown; name?: unknown; arguments?: unknown };
    if (blk.type !== "toolCall") continue;
    let args: unknown = blk.arguments;
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { continue; }
    }
    const p = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
    if (typeof p !== "string" || !p.trim()) continue;
    const trimmed = p.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) continue; // http:// file:// 等 URL 不是会话文件（要求 //，单字母盘符 C:/ 与 C:\ 不误伤）
    // 绝对路径：POSIX 的 / 开头 + Windows 的 盘符:\ 或 盘符:/ 或 \ 开头（旧实现只认 /，win 绝对路径被当相对拼 cwd）
    const isAbs = /^([a-z]:[\\/]|[\\/])/i.test(trimmed);
    const abs = isAbs
      ? trimmed
      : cwd ? `${cwd}/${trimmed.replace(/^\.\//, "")}` : "";
    if (!abs) continue;
    const name = typeof blk.name === "string" ? blk.name : "";
    out.push({ path: abs, modified: name === "edit" || name === "write" });
  }
  return out;
}

export function parseSessionFile(filePath: string, raw: string): ParsedSessionFile | null {
  let header: { id?: unknown; cwd?: unknown; timestamp?: unknown; parentSession?: unknown } | null = null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let lastMessage = "";
  let lastActivity: number | undefined;
  const messages: IndexedMessage[] = [];
  // 被操作文件收集：path → { 改动次数, 触达次数, 首见序 }
  const fileStats = new Map<string, { edits: number; touches: number; first: number }>();
  let fileSeq = 0;
  const noteFile = (p: string, modified: boolean) => {
    const st = fileStats.get(p);
    if (st) { st.touches++; if (modified) st.edits++; }
    else fileStats.set(p, { edits: modified ? 1 : 0, touches: 1, first: fileSeq++ });
  };

  // Truncated/interrupted sessions may be missing the "session" header line
  // (e.g. pi crashed mid-write). Fall back to the file name so the session is
  // still visible instead of silently disappearing from the list.
  function synthHeaderFromPath(): { id: string; cwd: string; timestamp: string } | null {
    const m = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
    if (!m) return null;
    // filename ts: "2026-08-16T13-41-44-301Z" (time uses dashes) → ISO "2026-08-16T13:41:44.301Z"
    let ts = filePath.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z?)/)?.[1];
    if (ts) ts = ts.replace(/^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z?$/, "$1$2:$3:$4.$5Z");
    ts ??= new Date().toISOString();
    // cwd dir: "--home-wind-workspace-aiti-ai--" → "/home/pi/workspace/aiti-ai"
    const dir = filePath.match(/sessions\/--([a-z0-9.-]+)--\//)?.[1] ?? "";
    const cwd = dir ? "/" + dir.replace(/-/g, "/") : "";
    return { id: m[1], cwd, timestamp: ts };
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!header) {
      if (entry.type === "session") {
        header = entry;
        continue;
      }
      const synth = synthHeaderFromPath();
      if (synth) {
        header = synth;
        // fall through and treat this first line as a normal entry below
      } else {
        return null; // first parseable line is not a session header
      }
    }
    if (entry.type === "session_info") {
      const n = (entry.name as string | undefined)?.trim();
      if (n) name = n;
      continue;
    }
    if (entry.type !== "message") continue;
    messageCount++;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (msg && isMessageWithContent(msg)) {
      const role = msg.role as string;
      if (role === "user" || role === "assistant") {
        const tsNum = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
        const tsStr = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
        const t = tsNum ?? (tsStr ? Date.parse(tsStr) : NaN);
        if (typeof t === "number" && !Number.isNaN(t)) lastActivity = Math.max(lastActivity ?? 0, t);
        const text = extractText(msg);
        if (text) {
          if (!firstMessage && role === "user") firstMessage = text;
          lastMessage = text;
          messages.push({
            entryId: typeof entry.id === "string" ? entry.id : "",
            role,
            ts: tsStr ?? (tsNum !== undefined ? new Date(tsNum).toISOString() : null),
            model: typeof msg.model === "string" ? msg.model : undefined,
            provider: typeof msg.provider === "string" ? msg.provider : undefined,
            text,
          });
        }
        // toolCall 块里的文件路径（extractText 的伪文本被截断 400 字符，不可靠——直接读原块）
        if (role === "assistant" && Array.isArray(msg.content)) {
          const cwd = typeof header.cwd === "string" ? header.cwd : "";
          for (const f of toolCallFilePaths(msg.content, cwd)) noteFile(f.path, f.modified);
        }
      } else if (role === "toolResult") {
        const text = extractText(msg);
        if (text) {
          messages.push({
            entryId: typeof entry.id === "string" ? entry.id : "",
            role: "toolResult",
            ts: typeof entry.timestamp === "string" ? entry.timestamp : null,
            toolName: typeof msg.toolName === "string" ? msg.toolName : undefined,
            text,
          });
        }
      }
    }
  }

  if (!header) return null;
  // 排序：改过的文件优先 → 触达次数多优先 → 首见顺序；上限 100（防超大 session 撑爆响应）
  const files = [...fileStats.entries()]
    .sort((a, b) => b[1].edits - a[1].edits || b[1].touches - a[1].touches || a[1].first - b[1].first)
    .slice(0, 100)
    .map(([p]) => p);
  const headerTs = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
  const modified = typeof lastActivity === "number" && lastActivity > 0
    ? new Date(lastActivity)
    : !Number.isNaN(headerTs) ? new Date(headerTs) : new Date();
  return {
    meta: {
      path: filePath,
      id: typeof header.id === "string" ? header.id : "",
      cwd: typeof header.cwd === "string" ? header.cwd : "",
      name,
      created: typeof header.timestamp === "string" ? header.timestamp : new Date().toISOString(),
      modified: modified.toISOString(),
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      lastMessage: lastMessage || "",
      parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
      agent: typeof header.agent === "string" && header.agent ? header.agent : undefined,
      extId: typeof header.extId === "string" && header.extId ? header.extId : undefined,
    },
    messages,
    files,
  };
}
