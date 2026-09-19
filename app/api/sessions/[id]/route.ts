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
import { resolveAnySession, attachIfBridged, handleModelToClient, extractFirstUserText } from "@/lib/session";
import { normalizeRawMessages } from "@/lib/normalize";
import { buildExternalPagedContext, clampTailParam } from "@/lib/external-session-paging";
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
 * External composite id → canonical id: the real composite id resolved from a lazy-init
 * placeholder (agent:new-*). In sidebar takeover mode, list rows are identified by the
 * composite id (the session-manager source), so the selected id must match it — otherwise the
 * same backend session gets pinned as a second row (a Draft row). Returns the input unchanged
 * when there is no resolution.
 */
function canonicalExternalId(requested: string, handleSessionId?: string): string {
  return handleSessionId || requested;
}

/** Fixed response for bridged sessions (attach detection goes by socket/registry; the file is only for history replay). */
function bridgedOk(
  id: string,
  bridged: { isAlive(): boolean; send(c: unknown): Promise<unknown>; cwd?: string; getModel?(): { id: string; provider: string } | undefined },
  page: { tail: number; before?: string | null } = { tail: 0 },
) {
  return bridged.send({ type: "get_messages" }).catch(() => null)
    .then((r) => {
      // The bridge side (TUI sessionManager) emits the raw SDK shape (toolCall uses id/name/
      // arguments); without normalizing it to match the local file reader (session-reader
      // entryToUiMessage), ToolCallBlock names/previews come out empty and results can't be
      // paired (root cause of "command execution messages are empty" on attached sessions)
      const paged = buildExternalPagedContext(((r as { entries?: unknown[] } | null)?.entries ?? []) as unknown[], page.tail > 0 ? page : undefined);
      const messages = paged.messages as unknown[];
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
          messageCount: paged.totalCount,
          firstMessage: "(bridged session)",
          transient: true,
          agent: "tui-bridge",
        },
        leafId: null,
        tree: [],
        // HandleModel is {id,…} while the client contract is {modelId,…} — without normalization the selector renders an empty current name
        context: { messages, entryIds: paged.entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(bridged.getModel?.()) },
        totalActiveMs: 0,
      });
    });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const fresh = new URL(req.url).searchParams.has("fresh");
  // paging params for external backend/bridged sessions (same semantics as local pi sessions; omitted = start from the tail 50)
  const extParams = new URL(req.url).searchParams;
  const extTail = clampTailParam(extParams.get("tail"));
  const extBefore = extParams.get("before");
  try {
    // bridge-occupancy detection comes first (the TUI owns the file; even a stale local wrapper yields)
    const fpEarly = await resolveSessionPath(id);
    if (fpEarly) {
      const bridged = await attachIfBridged(fpEarly);
      if (bridged?.isAlive()) {
        return await bridgedOk(id, bridged, { tail: extTail, before: extBefore });
      }
    }

    // Placeholder file (the pi persistence anchor for external agent sessions): a header with
    // extId → never opened as a local session, always routed to the real backend
    // (openExternalSession), with the handle dual-registered under the placeholder uuid.
    // Only on failure (backend extension absent / external source unavailable) fall back to the
    // local path so at least the placeholder metadata is visible.
    if (fpEarly) {
      const ph = await resolvePlaceholderSession(id).catch(() => undefined);
      if (ph?.isAlive()) {
        let paged = { messages: [] as unknown[], entryIds: [] as string[], oldestEntryId: null as string | null, hasMore: false, totalCount: 0 };
        try {
          const r = (await ph.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
          paged = buildExternalPagedContext(r?.entries ?? [], { tail: extTail, before: extBefore });
        } catch { /* get_messages unavailable → empty */ }
        const { messages } = paged;
        const firstText = extractFirstUserText(messages) || "(backend session)";
        const phHeader = readSessionHeader(fpEarly) as unknown as { agent?: string; extId?: string } | null;
        // real placeholder title (registry extId → name; written at open-live/replay)
        const phName = phHeader?.extId ? getPlaceholder(phHeader.extId)?.name : undefined;
        // placeholder-uuid requests are canonicalized to the real composite id too: in takeover
        // mode, list rows are identified by the composite id, and selecting the uuid would pin an
        // extra Draft row in the dock (the same backend session appearing twice).
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
            messageCount: paged.totalCount,
            firstMessage: firstText.slice(0, 80) || "(backend session)",
            transient: true,
            agent: phHeader?.agent ?? undefined,
          },
          leafId: null,
          tree: [],
          context: { messages, entryIds: paged.entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(ph.getModel?.()) },
          totalActiveMs: 0,
        });
      }
    }

    // Explicit user refresh (?fresh=1, 2026-09-15): reclaim this process's "alive but idle" rpc
    // wrapper so the flow naturally falls through to the disk branch and re-reads. Scenario: the
    // session was continued by a client outside this instance (another app instance / the zcode
    // desktop app / CLI) while the idle wrapper still holds the old in-memory SessionManager —
    // re-issuing GET would keep returning stale history from memory, making "refresh" a no-op;
    // and subsequent sends would append on the old leaf (diverging from disk). Running sessions
    // are untouched (the in-memory state of a running session is authoritative).
    if (fresh) {
      const staleRpc = getRpcSession(id);
      if (staleRpc?.isAlive() && !staleRpc.isRunning()) {
        await stopIdleRpcSession(id);
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
        let paged = { messages: [] as unknown[], entryIds: [] as string[], oldestEntryId: null as string | null, hasMore: false, totalCount: 0 };
        try {
          const r = (await wrapped.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
          paged = buildExternalPagedContext(r?.entries ?? [], { tail: extTail, before: extBefore });
        } catch (e) {
          console.error("[sessions/[id]] backend get_messages failed:", e instanceof Error ? e.message : e);
        }
        const { messages } = paged;
        const firstText = extractFirstUserText(messages) || "(backend session)";
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
            messageCount: paged.totalCount,
            firstMessage: firstText.slice(0, 80) || "(backend session)",
            transient: true,
            // real placeholder title (written to the registry on external backend replay/takeover)
            ...(getPlaceholder(wrapped.sessionId)?.name ? { name: getPlaceholder(wrapped.sessionId)?.name } : {}),
            // backend/agent tag (same projection as getHandleSessionInfos): the frontend
            // loadModels relies on it to fetch the external model catalog via list_models —
            // without it the selector silently falls back to the local list.
            agent: wrapped.source.includes("/") ? wrapped.source.split("/")[1] : wrapped.source,
          },
          leafId: null,
          tree: [],
          context: { messages, entryIds: paged.entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(wrapped.getModel?.()) },
          totalActiveMs: 0,
        });
      }
    }
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends the app itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      // An empty session (file lazily not yet written) may still have a live bridge: attach
      // prefers the socket (registry) — reading the file is only history replay. Reverse-look-up
      // the registry by id to get the sessionFile, then attach (independent of file existence)
      const bridgeFile = await findBridgeSessionFileById(id);
      if (bridgeFile) {
        try {
          const bridgedById = await attachIfBridged(bridgeFile).catch((e: { name?: string }) => {
            if (e?.name === "BridgeOccupiedError") throw e;
            return undefined;
          });
          if (bridgedById?.isAlive()) return await bridgedOk(id, bridgedById, { tail: extTail, before: extBefore });
        } catch (e) {
          throw e;
        }
      }
      // Composite id ("<agentKey>:<sid>", multi-agent backend history) — on handle-store miss
      // (e.g. after a service restart) recover via openExternalSession by id (provider --resume),
      // then return through the wrapped branch; only a failed recovery 404s. Local pi session ids
      // have no ":", so this is skipped at zero cost.
      if (id.includes(":")) {
        try {
          const { openExternalSession, resolveAnySession: resolveHandle } = await import("@/lib/session");
          const sid = id.slice(id.indexOf(":") + 1);
          const handle = await openExternalSession(id, { sessionId: sid || undefined }).catch(() => undefined);
          const wrappedAfterOpen = handle?.alive() ? resolveHandle(id) : undefined;
          if (handle && wrappedAfterOpen?.isAlive()) {
            const cid = canonicalExternalId(id, handle.id);
            let paged = { messages: [] as unknown[], entryIds: [] as string[], oldestEntryId: null as string | null, hasMore: false, totalCount: 0 };
            try {
              const r = (await wrappedAfterOpen.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
              paged = buildExternalPagedContext(r?.entries ?? [], { tail: extTail, before: extBefore });
            } catch { /* get_messages unavailable → empty */ }
            const { messages } = paged;
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
                messageCount: paged.totalCount,
                firstMessage: "(backend session)",
                transient: true,
                // agent tag (composite id prefix): the frontend loadModels relies on it to reach the external model catalog
                agent: id.slice(0, id.indexOf(":")) || undefined,
              },
              leafId: null,
              tree: [],
              context: { messages, entryIds: paged.entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(wrappedAfterOpen.getModel?.()) },
              totalActiveMs: 0,
            });
          }
        } catch { /* recovery failed → fall through to 404 */ }
      }
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // bridge-occupancy detection: the file is held by a TUI bridge → history comes back via the bridge's get_messages (no local open)
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
    // Display-consistency overlay: while the wrapper is alive, model/thinkingLevel come from the
    // real in-process state. Reason: a mid-run set_model appends model_change to whatever message
    // was in flight at the time; a later abort + resend opens a new branch, leaving those entries
    // on an abandoned branch — resolving along the leaf path then falls back to a very old value,
    // so the page would display a model different from the one actually running. Live state is
    // the authoritative value.
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
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
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
    // single-writer red line: when a TUI bridge holds the file, refuse local rewrites (rename from the TUI instead)
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
    // single-writer red line: sessions held by a TUI bridge must not be deleted from the web (it would blow up the TUI mid-write)
    for (const p of listProviders()) {
      if (!p.ownsFile) continue;
      try {
        if (await p.ownsFile(filePath)) {
          return NextResponse.json({ error: "Session is owned by a running agent bridge; close it there first" }, { status: 409 });
        }
      } catch { /* probe failure → treat as not-owned */ }
    }
    // A still-alive rpc session in this process: refuse while running; already finished (only the
    // handle lingers) → explicit user delete releases the handle first (shutdown flushes to disk,
    // wrapper leaves the registry) before deleting the file — no longer requires closing the page
    // first.
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
    // Placeholder file: delete only the anchor (file + registry entry + live handle); the external
    // raw data (cursor store.db etc.) is never touched; no child sessions hang off a placeholder —
    // skip the re-parent cascade.
    if (deleteHeader?.extId) {
      removePlaceholderByUuid(id); // includes unlinking the placeholder file
      removeHandle(id); // retire the live handle (prevents a zombie transient row)
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
      // session files go to the trash (recoverable after a slip); runtime session files that were never flushed (and thus don't exist) are silently skipped (upstream #440).
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
