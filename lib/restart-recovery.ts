/**
 * Restart recovery — interrupted-session list scanning + recovery execution orchestration
 * (app restart-recovery P1/P2).
 *
 * Data source: the running-journal's interrupted set (migrated in at boot from the previous
 * process generation's running set). Scanning (on the GET listing) validates each entry and
 * enriches metadata; recovery (POST resolve) reuses existing primitives:
 *   startRpcSession (open the session; the sidecar auto-enters pendingRecovery)
 *   → resolve_recovery (re-queue the checked entries)
 *   → prompt("continue") (start the run; "continue" rather than replaying the original
 *     prompt — the original prompt may be a dangerous command such as restart, and replaying
 *     it is unsafe; this is the user-approved semantics).
 *
 * Red line: never auto-deliver anything — the prompt is only sent when the user clicks
 * "recover and continue"; the copy comes from client i18n (chat.continue), with the server
 * only providing a fallback default.
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

/** Entry shape for GET /api/agent/recovery/interrupted (consumed by the frontend wizard). */
export interface InterruptedSessionInfo {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  kind: "local" | "external";
  /** Last time the journal confirmed it running ≈ the moment of interruption */
  interruptedAt: number;
  state: "pending" | "dismissed";
  /** Session name (session_info) or the first user message */
  title: string;
  /** The prompt running at interruption (last user message, truncated preview) */
  lastPrompt: string;
  /** Last assistant message (truncated preview; empty if the user's prompt had no reply yet) */
  lastAssistant: string;
  queueCount: number;
  /** The interrupted turn didn't finish cleanly (the last assistant message isn't a stop) */
  turnInterrupted: boolean;
  resumable: boolean;
  /** Why it can't be resumed: external | subagent | bridge | missing */
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
  lastAssistant: string;
  turnInterrupted: boolean;
  isSubagentByPath: boolean;
}

/** Parse the entries once and gather all display metadata (few list entries, so a full parse is acceptable). */
function readSessionTail(filePath: string): SessionTail {
  const out: SessionTail = { title: "", lastPrompt: "", lastAssistant: "", turnInterrupted: true, isSubagentByPath: false };
  // pi-subagents spawn-mode path signature: alongside <parent>.jsonl + /run-N/session.jsonl
  if (/\/run-\d+\/session\.jsonl$/.test(filePath) || /\/run-\d+\/[^/]+\.jsonl$/.test(filePath)) {
    out.isSubagentByPath = true;
  }
  try {
    const header = readSessionHeader(filePath) as { parentSession?: string; timestamp?: string } | null;
    if (header?.parentSession) out.isSubagentByPath = true;
    let firstUser = "";
    let lastUser = "";
    let lastAssistantStopped = false;
    for (const e of getSessionEntries(filePath) as unknown as Array<Record<string, unknown>>) {
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
        // stop = clean finish; error/aborted/missing stopReason (truncated) all count as unfinished
        lastAssistantStopped = msg.stopReason === "stop";
        // a truncated reply (aborted/missing stopReason) is still worth showing — the user can see how far the AI got
        const text = extractText(msg.content);
        if (text) out.lastAssistant = truncate(text);
      }
    }
    if (!out.title) out.title = truncate(firstUser, 60);
    out.lastPrompt = truncate(lastUser);
    out.turnInterrupted = !lastAssistantStopped;
  } catch {
    // a read failure must not break the list display (metadata left empty; still resumable)
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
    } catch { /* a probe failure must not block the listing */ }
  }
  return null;
}

/** Scan the interrupted set: validate + enrich metadata. Entries whose file has vanished are removed along the way (equivalent to the next boot's fallback). */
export async function scanInterruptedSessions(): Promise<InterruptedReport> {
  const entries = listInterrupted();
  const items: InterruptedSessionInfo[] = [];
  for (const entry of entries) {
    if (entry.kind === "external") {
      items.push(toInfo(entry, { title: entry.id, resumable: false, reason: "external" }));
      continue;
    }
    if (!entry.sessionFile || !existsSync(entry.sessionFile)) {
      // file gone (cleaned up/deleted) — drop the interrupted record too
      removeInterrupted(entry.sessionFile);
      continue;
    }
    const tail = readSessionTail(entry.sessionFile);
    if (tail.isSubagentByPath) {
      // subagent artifact wrongly in the journal (shouldn't happen): remove silently
      removeInterrupted(entry.sessionFile);
      continue;
    }
    const bridgeOwner = await findBridgeOwner(entry.sessionFile);
    if (bridgeOwner) {
      items.push(toInfo(entry, { ...tailInfo(tail, entry), resumable: false, reason: "bridge" }));
      continue;
    }
    // Cross-instance mutual exclusion: the same session file is being run by another live
    // instance (shared sessions directory; dev/prod double-opening a runtime on one file would
    // overwrite each other's writes) → display only, not resumable
    const otherInstance = findOtherInstanceRunner(entry.sessionFile);
    if (otherInstance) {
      items.push(toInfo(entry, { ...tailInfo(tail, entry), resumable: false, reason: "other-instance" }));
      continue;
    }
    items.push(toInfo(entry, { ...tailInfo(tail, entry), resumable: true }));
  }
  const pending = items.filter((i) => i.state === "pending");
  return {
    items,
    pendingCount: pending.length,
    totalQueued: pending.reduce((n, i) => n + i.queueCount, 0),
  };
}

/** readSessionTail result + queueCount → the list entry's display fields. */
function tailInfo(tail: SessionTail, entry: JournalEntry): Partial<InterruptedSessionInfo> {
  return {
    title: tail.title,
    lastPrompt: tail.lastPrompt,
    lastAssistant: tail.lastAssistant,
    queueCount: loadQueue(entry.sessionFile).length,
    turnInterrupted: tail.turnInterrupted,
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
    lastAssistant: "",
    queueCount: 0,
    turnInterrupted: false,
    resumable: true,
    ...extra,
  };
}

export interface ResolveInterruptedOptions {
  sessionId: string;
  sessionFile: string;
  /** ids of recovery entries to re-queue */
  keep?: string[];
  /** ids of recovery entries to discard */
  discard?: string[];
  /** start the run immediately after recovery with "continue" */
  continueRun?: boolean;
  /** the continue prompt copy (passed from client i18n; the server falls back to a default) */
  continueText?: string;
  /** dismiss only, no recovery */
  dismiss?: boolean;
}

export interface ResolveInterruptedResult {
  ok: boolean;
  error?: string;
  kept?: number;
  failed?: string[];
}

/** Execute recovery/dismiss. Recovery = open the session + re-queue the selected entries + (optionally) prompt "continue". */
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
  // TOCTOU guard: between scan and recovery another instance may have just started running — check once more before executing
  const otherInstance = findOtherInstanceRunner(sessionFile);
  if (otherInstance) return { ok: false, error: `Session is currently running on another instance (${otherInstance})` };

  // dynamic import: avoid a hard startup dependency beyond rpc-manager → running-journal
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
      // no await: prompt would wait for the whole run to finish; errors are caught and logged
      // (the prompt_error event is broadcast to the frontend via the wrapper's internal path).
      void session.send({ type: "prompt", message: options.continueText || "Continue" }).catch((error) => {
        console.error("[pi-web] restart-recovery continue prompt failed:", error instanceof Error ? error.message : String(error));
      });
    }
    removeInterrupted(sessionFile);
    return { ok: true, kept, failed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
