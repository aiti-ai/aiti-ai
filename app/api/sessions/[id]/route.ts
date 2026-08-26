import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";
import { listProviders } from "@/lib/session/providers";
import { removeQueue } from "@/lib/queue-store";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // 桥占用识别最先（TUI 是文件所有者；即使有陈旧本地 wrapper 也让位）
    const fpEarly = await resolveSessionPath(id);
      if (fpEarly) {
      const bridged = await attachIfBridged(fpEarly);
      if (bridged?.isAlive()) {
        const r = (await bridged.send({ type: "get_messages" }).catch(() => null)) as { entries?: unknown[] } | null;
        const messages = r?.entries ?? [];
        return NextResponse.json({
            sessionId: id,
            filePath: "",
            info: {
            path: "", id, cwd: (bridged as { cwd?: string }).cwd ?? "",
            name: undefined,
            created: new Date().toISOString(), modified: new Date().toISOString(),
            messageCount: messages.length,
            firstMessage: "(bridged session)",
            transient: true,
            agent: "tui-bridge",
            },
          leafId: null,
          tree: [],
          context: { messages, entryIds: [], thinkingLevel: "off", model: null },
          totalActiveMs: 0,
          });
        }
      }

    // Backend (provider-handle) sessions: no local file exists — serve a
    // minimal SessionData so the chat view loads instead of bouncing off a
    // 404. History replay depends on the backend's getMessages capability.
    const rpc = getRpcSession(id);
    if (!(rpc?.isAlive())) {
      const wrapped = resolveAnySession(id);
      if (wrapped?.isAlive()) {
        // History replay: pull entries through the handle's get_messages
        // (capability-gated; backends without it serve an empty context and
        // the live SSE stream covers new turns).
        let messages: unknown[] = [];
        try {
          const r = (await wrapped.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
          messages = r?.entries ?? [];
        } catch (e) {
          console.error("[sessions/[id]] backend get_messages failed:", e instanceof Error ? e.message : e);
        }
        const first = messages.find((m) => (m as { role?: string }).role === "user");
        const firstText = first
          ? (() => {
              const c = (first as { content?: unknown }).content;
              return typeof c === "string" ? c : "(backend session)";
            })()
          : "(backend session)";
        return NextResponse.json({
          sessionId: id,
          filePath: "",
          info: {
            path: "",
            id,
            cwd: wrapped.cwd ?? "",
            name: undefined,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: messages.length,
            firstMessage: firstText.slice(0, 80) || "(backend session)",
            transient: true,
          },
          leafId: null,
          tree: [],
          context: { messages, entryIds: [], thinkingLevel: "off", model: null },
          totalActiveMs: 0,
        });
      }
    }
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // 桥占用识别：文件被 TUI 桥持有 → 历史经桥 get_messages 返回（不本地打开）
    if (!liveRpc && resolvedPath) {
      try {
        const bridged = await attachIfBridged(resolvedPath).catch((e: { name?: string }) => {
          if (e?.name === "BridgeOccupiedError") throw e;
          return undefined;
        });
        if (bridged?.isAlive()) {
          const r = (await bridged.send({ type: "get_messages" }).catch(() => null)) as { entries?: unknown[] } | null;
          const messages = r?.entries ?? [];
          const firstUser = messages.find((m) => (m as { role?: string }).role === "user");
          return NextResponse.json({
            sessionId: id,
            filePath: "",
            info: {
              path: "",
              id,
              cwd: bridged.cwd ?? "",
              name: undefined,
              created: new Date().toISOString(),
              modified: new Date().toISOString(),
              messageCount: messages.length,
              firstMessage: firstUser ? "(bridged session)" : "(bridged session)",
              transient: true,
              agent: "tui-bridge",
            },
            leafId: null,
            tree: [],
            context: { messages, entryIds: [], thinkingLevel: "off", model: null },
            totalActiveMs: 0,
          });
        }
      } catch { /* fall through to local */ }
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    // 显示一致性 overlay：wrapper 存活时，model/thinkingLevel 以进程内真实状态为准。
    // 原因：运行中（mid-run）的 set_model 会把 model_change 追加到当时 in-flight 的
    // 消息上；之后 abort + 重发开新分支，这些条目就落在废弃分支上，沿 leaf 路径解析
    // 会回退到很老的值——页面显示与实际执行的模型不一致。live 状态是权威值。
    if (liveRpc) {
      const liveModel = liveRpc.inner.model;
      if (liveModel && liveModel.provider && liveModel.id) {
        context.model = { provider: liveModel.provider, modelId: liveModel.id };
      }
      const liveThinking = (liveRpc.inner.agent?.state as { thinkingLevel?: string } | undefined)?.thinkingLevel;
      if (liveThinking) context.thinkingLevel = liveThinking;
    }
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      stats,
      totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
  } catch (error) {
    if ((error as { name?: string }).name === "BridgeOccupiedError") {
      return NextResponse.json({ error: String(error), code: "session_bridged_unreachable" }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // 单写者红线：TUI 桥持有该文件时拒绝本地改写（重命名请回 TUI 操作）
    {
      const bridged = await attachIfBridged(filePath);
      if (bridged?.isAlive()) {
        const r = (await bridged.send({ type: "set_session_name", name: name.trim() }).catch(() => null)) as { success?: boolean } | null;
        if (r?.success) return NextResponse.json({ ok: true, via: "bridge" });
        return NextResponse.json({ error: "Session is owned by a TUI bridge; rename not supported by its backend" }, { status: 409 });
      }
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // 单写者红线：TUI 桥持有的会话不允许从 Web 删文件（会炸掉正在写的 TUI）
    for (const p of listProviders()) {
      if (!p.ownsFile) continue;
      try {
        if (await p.ownsFile(filePath)) {
          return NextResponse.json({ error: "Session is owned by a running agent bridge; close it there first" }, { status: 409 });
        }
      } catch { /* probe failure → treat as not-owned */ }
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;
    const parentSessionId = parentSessionPath
      ? readSessionHeader(parentSessionPath)?.id
      : undefined;

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        try {
          const content = readFileSync(childPath, "utf8");
          const lines = content.split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
          if (
            header.type === "session" &&
            header.parentSession &&
            sessionPathKey(header.parentSession) === targetPathKey
          ) {
            // Rewrite header with new parentSession
            header.parentSession = parentSessionPath;
            lines[0] = JSON.stringify(header);
            if (parentSessionPath && parentSessionId) {
              for (let index = 1; index < lines.length; index += 1) {
                let entry: { type?: string; customType?: string; data?: unknown };
                try {
                  entry = JSON.parse(lines[index]);
                } catch {
                  continue;
                }
                if (
                  entry.type !== "custom"
                  || entry.customType !== SUBAGENT_META_TYPE
                  || typeof entry.data !== "object"
                  || entry.data === null
                  || Array.isArray(entry.data)
                ) continue;
                entry.data = {
                  ...entry.data,
                  parentSessionId,
                  parentSessionPath,
                };
                lines[index] = JSON.stringify(entry);
                break;
              }
            }
            writeFileSync(childPath, lines.join("\n"));
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip if dir unreadable */ }

    await getRpcSession(id)?.shutdown();
    unlinkSync(filePath);
    removeQueue(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
