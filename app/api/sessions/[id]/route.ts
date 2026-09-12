import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
  findBridgeSessionFileById,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { abortSubagent, getRpcSession, getRpcSessionInfos, getAliveRpcSessionIds, stopIdleRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged, handleModelToClient } from "@/lib/session";
import { normalizeRawMessages } from "@/lib/normalize";
import { listProviders } from "@/lib/session/providers";
import { resolvePlaceholderSession, removeHandle } from "@/lib/session";
import { getPlaceholder, removePlaceholderByUuid } from "@/lib/session/placeholder";
import { removeQueue } from "@/lib/queue-store";
import { trashFileSync } from "@/lib/session-trash";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { jsonResponse } from "@/lib/json-response";

/**
 * 外部复合 id → 规范 id：懒初始化占位（agent:new-*）解析出的真实复合 id。
 * 侧栏接管态的列表行以复合 id 为身份（session-manager 源），选中 id 必须与之一致，
 * 否则同一后端会话会钉出第二行（Draft 行）。无解析结果时原样返回。
 */
function canonicalExternalId(requested: string, handleSessionId?: string): string {
  return handleSessionId || requested;
}

/** 桥会话的固定响应（attach 判定以 socket/registry 为准，文件仅历史回放）。 */
function bridgedOk(id: string, bridged: { isAlive(): boolean; send(c: unknown): Promise<unknown>; cwd?: string; getModel?(): { id: string; provider: string } | undefined }) {
  return bridged.send({ type: "get_messages" }).catch(() => null)
    .then((r) => {
      // 桥端（TUI sessionManager）吐的是 SDK 原始形状（toolCall 用 id/name/arguments），
      // 与本地文件读取（session-reader entryToUiMessage）不同步归一化会导致
      // ToolCallBlock 名字/预览全空、结果无法配对（attach 会话「命令执行消息为空」根因）
      const messages = normalizeRawMessages(((r as { entries?: unknown[] } | null)?.entries ?? []) as unknown[]);
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
          firstMessage: "(bridged session)",
          transient: true,
          agent: "tui-bridge",
        },
        leafId: null,
        tree: [],
        // HandleModel 是 {id,…}，客户端契约是 {modelId,…}——不归一化则选择器当前名渲染为空
        context: { messages, entryIds: [], thinkingLevel: "off", model: handleModelToClient(bridged.getModel?.()) },
        totalActiveMs: 0,
      });
    });
}

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
        return await bridgedOk(id, bridged);
      }
    }

    // 站位文件（外部 agent 会话的 pi 持久锚点）：header 带 extId → 永不按本地会话
    // 打开，一律路由真实后端（openExternalSession），handle 双注册到站位 uuid 下。
    // 失败（后端扩展不在/外部源不可用）才落回本地路径，至少能看到站位元数据。
    if (fpEarly) {
      const ph = await resolvePlaceholderSession(id).catch(() => undefined);
      if (ph?.isAlive()) {
        let messages: unknown[] = [];
        try {
          const r = (await ph.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
          messages = normalizeRawMessages(r?.entries ?? []);
        } catch { /* get_messages 缺省 → 空 */ }
        const first = messages.find((m) => (m as { role?: string }).role === "user");
        const firstText = first
          ? (() => {
              const c = (first as { content?: unknown }).content;
              return typeof c === "string" ? c : "(backend session)";
            })()
          : "(backend session)";
        const phHeader = readSessionHeader(fpEarly) as unknown as { agent?: string; extId?: string } | null;
        // 站位真实标题（注册表 extId → name；open-live/回放时写入）
        const phName = phHeader?.extId ? getPlaceholder(phHeader.extId)?.name : undefined;
        // 站位 uuid 请求同样规范到真实复合 id：接管态列表行以复合 id 为身份，
        // 选中 uuid 会在 dock 里多钉一行 Draft（同一后端会话双行）。
        const cid = phHeader?.extId && phHeader.extId.includes(":") ? phHeader.extId : id;
        return NextResponse.json({
          sessionId: cid,
          filePath: "",
          info: {
            path: "",
            id: cid,
            cwd: ph.cwd ?? "",
            name: phName,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: messages.length,
            firstMessage: firstText.slice(0, 80) || "(backend session)",
            transient: true,
            agent: phHeader?.agent ?? undefined,
          },
          leafId: null,
          tree: [],
          context: { messages, entryIds: [], thinkingLevel: "off", model: handleModelToClient(ph.getModel?.()) },
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
          messages = normalizeRawMessages(r?.entries ?? []);
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
        const cid = canonicalExternalId(id, wrapped.sessionId);
        return NextResponse.json({
          sessionId: cid,
          filePath: "",
          info: {
            path: "",
            id: cid,
            cwd: wrapped.cwd ?? "",
            name: undefined,
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: messages.length,
            firstMessage: firstText.slice(0, 80) || "(backend session)",
            transient: true,
            // 站位真实标题（外部后端回放/接管时写入注册表）
            ...(getPlaceholder(wrapped.sessionId)?.name ? { name: getPlaceholder(wrapped.sessionId)?.name } : {}),
            // 后端/agent 标签（与 getHandleSessionInfos 同款投影）：前端 loadModels
            // 靠它走 list_models 取外部模型目录 —— 缺了会选择器静默落回本地清单。
            agent: wrapped.source.includes("/") ? wrapped.source.split("/")[1] : wrapped.source,
          },
          leafId: null,
          tree: [],
          context: { messages, entryIds: [], thinkingLevel: "off", model: handleModelToClient(wrapped.getModel?.()) },
          totalActiveMs: 0,
        });
      }
    }
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      // 空会话（文件惰性未落盘）也可能有 live bridge：attach 优先走 socket（registry），
      // 读文件只是历史回放——按 id 反查注册表拿 sessionFile 再 attach（不依赖文件存在）
      const bridgeFile = await findBridgeSessionFileById(id);
      if (bridgeFile) {
        try {
          const bridgedById = await attachIfBridged(bridgeFile).catch((e: { name?: string }) => {
            if (e?.name === "BridgeOccupiedError") throw e;
            return undefined;
          });
          if (bridgedById?.isAlive()) return await bridgedOk(id, bridgedById);
        } catch (e) {
          throw e;
        }
      }
      // 复合 id（"<agentKey>:<sid>"，多 agent 后端历史）——handle-store miss（如服务
      // 重启后）时按 id 经 openExternalSession 恢复（provider --resume），再走 wrapped
      // 分支返回；恢复失败才 404。本地 pi 会话 id 无 ":"，零开销跳过。
      if (id.includes(":")) {
        try {
          const { openExternalSession, resolveAnySession: resolveHandle } = await import("@/lib/session");
          const sid = id.slice(id.indexOf(":") + 1);
          const handle = await openExternalSession(id, { sessionId: sid || undefined }).catch(() => undefined);
          const wrappedAfterOpen = handle?.alive() ? resolveHandle(id) : undefined;
          if (handle && wrappedAfterOpen?.isAlive()) {
            const cid = canonicalExternalId(id, handle.id);
            let messages: unknown[] = [];
            try {
              const r = (await wrappedAfterOpen.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
              messages = normalizeRawMessages(r?.entries ?? []);
            } catch { /* get_messages 缺省 → 空 */ }
            return NextResponse.json({
              sessionId: cid,
              filePath: "",
              info: {
                path: "",
                id: cid,
                cwd: wrappedAfterOpen.cwd ?? "",
                ...(getPlaceholder(id)?.name ? { name: getPlaceholder(id)!.name } : {}),
                created: new Date().toISOString(),
                modified: new Date().toISOString(),
                messageCount: messages.length,
                firstMessage: "(backend session)",
                transient: true,
                // agent 标签（复合 id 前缀）：前端 loadModels 靠它走外部模型目录
                agent: id.slice(0, id.indexOf(":")) || undefined,
              },
              leafId: null,
              tree: [],
              context: { messages, entryIds: [], thinkingLevel: "off", model: handleModelToClient(wrappedAfterOpen.getModel?.()) },
              totalActiveMs: 0,
            });
          }
        } catch { /* 恢复失败 → 落回 404 */ }
      }
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
          const messages = normalizeRawMessages(r?.entries ?? []);
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
            context: { messages, entryIds: [], thinkingLevel: "off", model: handleModelToClient(bridged.getModel?.()) },
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

    return jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
      },
    );
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
    // 本进程 rpc 会话仍存活：运行中的拒绝；已结束（仅 handle 挂着）→ 用户显式删除，
    // 先释放 handle（shutdown flush 落盘、wrapper 退出 registry）再删文件，不再要求先关页面。
    if (getAliveRpcSessionIds().includes(id)) {
      const stopResult = await stopIdleRpcSession(id);
      if (stopResult === "running") {
        return NextResponse.json({ error: "Session is running — stop it before deleting" }, { status: 409 });
      }
      if (stopResult !== "stopped") {
        return NextResponse.json({ error: "Session is still open in this workspace — close it first" }, { status: 409 });
      }
    }

    // Read only the bounded header before deleting.
    let deleteHeader: { parentSession?: string; extId?: string } | null = null;
    try {
      deleteHeader = readSessionHeader(filePath) as unknown as { parentSession?: string; extId?: string } | null;
    } catch (error) {
      // Empty runtime sessions have a cached path before their first disk write (upstream #440).
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // 站位文件：只删锚点（文件 + 注册表项 + 存活 handle），外部原始数据（cursor store.db 等）
    // 永不动；也不会有子会话挂站位名下——跳过重挂 cascade。
    if (deleteHeader?.extId) {
      removePlaceholderByUuid(id); // 含站位文件 unlink
      removeHandle(id); // 存活 handle 退场（防僵尸瞬时行）
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    }
    const parentSessionPath = deleteHeader?.parentSession;
    let parentSessionId: string | undefined;
    if (parentSessionPath) {
      try {
        // The parent may have been deleted or moved already; treat it as absent.
        parentSessionId = readSessionHeader(parentSessionPath)?.id;
      } catch {
        parentSessionId = undefined;
      }
    }

    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    // Deleting a session also deletes every persisted or live subagent below it.
    const sessions = mergeSessionLists(
      await listAllSessions({ force: true }),
      getRpcSessionInfos({ includeTransient: true }),
    );
    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
      if (session.relation?.kind !== "subagent") continue;
      const children = childrenByParent.get(session.relation.parentSessionId) ?? [];
      children.push(session.id);
      childrenByParent.set(session.relation.parentSessionId, children);
    }
    const sessionPaths = new Map(sessions.map((session) => [session.id, session.path]));
    // Include local files even when the global catalogue is stale or incomplete.
    try {
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
        const childPath = join(dir, file);
        if (sessionPathKey(childPath) === targetPathKey) continue;
        try {
          const lines = readFileSync(childPath, "utf8").split("\n");
          const header = JSON.parse(lines[0]) as { type?: string; id?: string };
          if (header.type !== "session" || typeof header.id !== "string") continue;
          const entries = lines.slice(1).flatMap((line) => {
            try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
          });
          const subagent = readSubagentRun(entries, header.id, childPath);
          if (!subagent) continue;
          const children = childrenByParent.get(subagent.parentSessionId) ?? [];
          children.push(header.id);
          childrenByParent.set(subagent.parentSessionId, children);
          sessionPaths.set(header.id, childPath);
        } catch { /* skip malformed or concurrently removed sessions */ }
      }
    } catch { /* skip if dir unreadable */ }
    const deletedSessionIds = new Set<string>([id]);
    const pending = [id];
    while (pending.length > 0) {
      const parentId = pending.pop()!;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (deletedSessionIds.has(childId)) continue;
        deletedSessionIds.add(childId);
        pending.push(childId);
      }
    }
    const deletedPaths = new Map<string, string>([[id, filePath]]);
    for (const deletedId of deletedSessionIds) {
      const sessionPath = sessionPaths.get(deletedId);
      if (sessionPath) deletedPaths.set(deletedId, sessionPath);
    }
    for (const deletedId of deletedSessionIds) {
      if (deletedPaths.has(deletedId)) continue;
      const runtimePath = getRpcSession(deletedId)?.sessionFile;
      if (runtimePath) deletedPaths.set(deletedId, runtimePath);
      else {
        const resolvedPath = await resolveSessionPath(deletedId);
        if (resolvedPath) deletedPaths.set(deletedId, resolvedPath);
      }
    }
    const deletedPathKeys = new Set([...deletedPaths.values()].map((path) => sessionPathKey(path)));

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    try {
      const files = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);
        if (deletedPathKeys.has(sessionPathKey(childPath))) continue;
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

    for (const deletedId of [...deletedSessionIds].reverse()) {
      if (deletedId === id) continue;
      try { await abortSubagent(deletedId); } catch { /* idle or completed */ }
      await getRpcSession(deletedId)?.shutdown();
    }
    try { await abortSubagent(id); } catch { /* ordinary session */ }
    await getRpcSession(id)?.shutdown();
    for (const [deletedId, deletedPath] of deletedPaths) {
      // 会话文件进回收站（手滑可还原）；未落盘的 runtime 会话文件不存在时静默跳过（upstream #440）。
      trashFileSync(deletedPath);
      removeQueue(deletedPath);
      invalidateSessionPathCache(deletedId);
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
