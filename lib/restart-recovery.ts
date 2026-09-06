/**
 * 重启恢复 — 中断会话清单扫描 + 恢复执行编排（pi-web 重启恢复 P1/P2）。
 *
 * 数据源：running-journal 的 interrupted 集（boot 时由上一代进程的运行集迁入）。
 * 扫描（GET 清单时）做逐条校验与元数据充实；恢复（POST resolve）复用既有原语：
 *   startRpcSession（打开会话，sidecar 自动入 pendingRecovery）
 *   → resolve_recovery（勾选条目 re-queue）
 *   → prompt(继续)（启动 run；「继续」而非重放原 prompt——原 prompt 可能是危险
 *     命令如 restart，重放不安全；这是用户显式拍板的语义）。
 *
 * 红线：绝不自动投递任何内容——prompt 只在用户点击「取回并继续」时发出，文案来自
 * 客户端 i18n（chat.continue），服务端仅兜底默认值。
 */
import { existsSync } from "fs";
import { readSessionHeader, getSessionEntries } from "./session-reader.ts";
import { loadQueue } from "./queue-store.ts";
import { listProviders } from "./session/providers.ts";
import {
  findOtherInstanceRunner,
  listInterrupted,
  removeInterrupted,
  setInterruptedState,
  type JournalEntry,
} from "./running-journal.ts";

/** GET /api/agent/recovery/interrupted 的条目形状（前端向导消费）。 */
export interface InterruptedSessionInfo {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  kind: "local" | "external";
  /** journal 里最后一次确认运行的时间 ≈ 中断时刻 */
  interruptedAt: number;
  state: "pending" | "dismissed";
  /** 会话名（session_info）或首条 user 消息 */
  title: string;
  /** 中断时正在跑的 prompt（最后一条 user 消息，截断预览） */
  lastPrompt: string;
  queueCount: number;
  /** 中断 turn 未正常收尾（最后一条不是 stop 的 assistant 消息） */
  turnInterrupted: boolean;
  resumable: boolean;
  /** 不可恢复原因：external | subagent | bridge | missing */
  reason?: string;
}

export interface InterruptedReport {
  items: InterruptedSessionInfo[];
  pendingCount: number;
  totalQueued: number;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface SessionTail {
  title: string;
  lastPrompt: string;
  turnInterrupted: boolean;
  isSubagentByPath: boolean;
}

/** 一次解析 entries 拿齐展示元数据（清单条目少，全量解析可接受）。 */
function readSessionTail(filePath: string): SessionTail {
  const out: SessionTail = { title: "", lastPrompt: "", turnInterrupted: true, isSubagentByPath: false };
  // pi-subagents spawn 模式路径特征：<parent>.jsonl 同目录 + /run-N/session.jsonl
  if (/\/run-\d+\/session\.jsonl$/.test(filePath) || /\/run-\d+\/[^/]+\.jsonl$/.test(filePath)) {
    out.isSubagentByPath = true;
  }
  try {
    const header = readSessionHeader(filePath) as { parentSession?: string; timestamp?: string } | null;
    if (header?.parentSession) out.isSubagentByPath = true;
    let firstUser = "";
    let lastUser = "";
    let lastAssistantStopped = false;
    for (const e of getSessionEntries(filePath) as Array<Record<string, unknown>>) {
      if (e.type === "session_info") {
        const name = (e as { name?: string }).name?.trim();
        if (name) out.title = name;
        continue;
      }
      if (e.type !== "message") continue;
      const msg = (e as { message?: { role?: string; content?: unknown; stopReason?: string } }).message;
      if (!msg) continue;
      if (msg.role === "user") {
        const text = extractText(msg.content);
        if (text) {
          if (!firstUser) firstUser = text;
          lastUser = text;
        }
      } else if (msg.role === "assistant") {
        // stop 正常收尾；error/aborted/无 stopReason（半截）都视为未完成
        lastAssistantStopped = msg.stopReason === "stop";
      }
    }
    if (!out.title) out.title = truncate(firstUser, 60);
    out.lastPrompt = truncate(lastUser);
    out.turnInterrupted = !lastAssistantStopped;
  } catch {
    // 读取失败不影响清单展示（元数据留空，仍可恢复）
  }
  return out;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text"
      ? String((b as { text?: string }).text ?? "")
      : ""))
    .filter(Boolean)
    .join(" ");
}

async function findBridgeOwner(sessionFile: string): Promise<string | null> {
  for (const p of listProviders()) {
    if (!p.ownsFile) continue;
    try {
      if (await p.ownsFile(sessionFile)) return p.type;
    } catch { /* 探测失败不阻塞清单 */ }
  }
  return null;
}

/** 扫描中断集：校验 + 充实元数据。文件已消失的条目顺手清除（等价下次 boot 兜底）。 */
export async function scanInterruptedSessions(): Promise<InterruptedReport> {
  const entries = listInterrupted();
  const items: InterruptedSessionInfo[] = [];
  for (const entry of entries) {
    if (entry.kind === "external") {
      items.push(toInfo(entry, { title: entry.id, resumable: false, reason: "external" }));
      continue;
    }
    if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
      // 文件没了（被清理/删除）——中断记录一并清掉
      removeInterrupted(entry.sessionFile);
      continue;
    }
    const tail = readSessionTail(entry.sessionFile);
    if (tail.isSubagentByPath) {
      // 子代理工件误入 journal（理论不该有）：静默清除
      removeInterrupted(entry.sessionFile);
      continue;
    }
    const bridgeOwner = await findBridgeOwner(entry.sessionFile);
    if (bridgeOwner) {
      items.push(toInfo(entry, {
        title: tail.title, lastPrompt: tail.lastPrompt, queueCount: loadQueue(entry.sessionFile).length,
        turnInterrupted: tail.turnInterrupted, resumable: false, reason: "bridge",
      }));
      continue;
    }
    // 跨实例互斥：同一 session 文件正被另一个活实例运行（共享 sessions 目录，
    // dev/prod 同文件双开 runtime 会互相覆盖写入）→ 只展示不可恢复
    const otherInstance = findOtherInstanceRunner(entry.sessionFile);
    if (otherInstance) {
      items.push(toInfo(entry, {
        title: tail.title, lastPrompt: tail.lastPrompt, queueCount: loadQueue(entry.sessionFile).length,
        turnInterrupted: tail.turnInterrupted, resumable: false, reason: "other-instance",
      }));
      continue;
    }
    items.push(toInfo(entry, {
      title: tail.title, lastPrompt: tail.lastPrompt, queueCount: loadQueue(entry.sessionFile).length,
      turnInterrupted: tail.turnInterrupted, resumable: true,
    }));
  }
  const pending = items.filter((i) => i.state === "pending");
  return {
    items,
    pendingCount: pending.length,
    totalQueued: pending.reduce((n, i) => n + i.queueCount, 0),
  };
}

function toInfo(
  entry: JournalEntry & { detectedAt?: number; state?: "pending" | "dismissed" },
  extra: Partial<InterruptedSessionInfo>,
): InterruptedSessionInfo {
  return {
    sessionId: entry.id,
    sessionFile: entry.sessionFile,
    cwd: entry.cwd,
    kind: entry.kind,
    interruptedAt: entry.updatedAt,
    state: entry.state ?? "pending",
    title: "",
    lastPrompt: "",
    queueCount: 0,
    turnInterrupted: false,
    resumable: true,
    ...extra,
  };
}

export interface ResolveInterruptedOptions {
  sessionId: string;
  sessionFile: string;
  /** 重新入队的 recovery 条目 id */
  keep?: string[];
  /** 丢弃的 recovery 条目 id */
  discard?: string[];
  /** 恢复后立即以「继续」启动 run */
  continueRun?: boolean;
  /** 继续提示词文案（客户端 i18n 传入；服务端兜底「继续」） */
  continueText?: string;
  /** 只忽略不恢复 */
  dismiss?: boolean;
}

export interface ResolveInterruptedResult {
  ok: boolean;
  error?: string;
  kept?: number;
  failed?: string[];
}

/** 执行恢复/忽略。恢复 = 打开会话 + re-queue 选中条目 +（可选）prompt「继续」。 */
export async function resolveInterruptedSession(options: ResolveInterruptedOptions): Promise<ResolveInterruptedResult> {
  const { sessionId, sessionFile } = options;
  const entry = listInterrupted().find((e) => e.sessionFile === sessionFile);
  if (!entry) return { ok: false, error: "Not in interrupted list" };

  if (options.dismiss) {
    setInterruptedState(sessionFile, "dismissed");
    return { ok: true };
  }

  if (entry.kind === "external") return { ok: false, error: "External sessions cannot be auto-resumed" };
  if (!sessionFile || !existsSync(sessionFile)) {
    removeInterrupted(sessionFile);
    return { ok: false, error: "Session file no longer exists" };
  }
  const tail = readSessionTail(sessionFile);
  if (tail.isSubagentByPath) return { ok: false, error: "Subagent sessions cannot be resumed" };
  const bridgeOwner = await findBridgeOwner(sessionFile);
  if (bridgeOwner) return { ok: false, error: `Session is claimed by backend "${bridgeOwner}"` };
  // TOCTOU 兜底：扫描后、恢复前另一实例可能刚开跑——执行前再拦一道
  const otherInstance = findOtherInstanceRunner(sessionFile);
  if (otherInstance) return { ok: false, error: `Session is currently running on another instance (${otherInstance})` };

  // 动态 import：避免 rpc-manager → running-journal 之外的启动期强依赖
  const { startRpcSession } = await import("./rpc-manager.ts");
  try {
    const { session } = await startRpcSession(sessionId, sessionFile, undefined);
    const keep = options.keep ?? [];
    const discard = options.discard ?? [];
    let kept = 0;
    let failed: string[] = [];
    if (keep.length > 0 || discard.length > 0) {
      const result = await session.send({
        type: "resolve_recovery",
        keep,
        discard,
        continueRun: false,
      }) as { kept?: number; failed?: string[] };
      kept = result.kept ?? 0;
      failed = result.failed ?? [];
    }
    if (options.continueRun) {
      // 不 await：prompt 会等整个 run 跑完；错误经 catch 落日志（prompt_error 事件
      // 由 wrapper 内部路径广播给前端）。
      void session.send({ type: "prompt", message: options.continueText || "继续" }).catch((error) => {
        console.error("[pi-web] restart-recovery continue prompt failed:", error instanceof Error ? error.message : String(error));
      });
    }
    removeInterrupted(sessionFile);
    return { ok: true, kept, failed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
