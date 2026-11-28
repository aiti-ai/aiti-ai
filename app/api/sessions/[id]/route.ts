import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import {
  attachSessionProjectInfo,
  openSessionManager,
  preferDiskHistory,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  buildSessionContext,
  readSessionHeader,
  findBridgeSessionFileById,
  invalidateSessionPathCache,
} from "@/lib/session-reader";
import { getLiveRpcSession, getRpcSession, getAliveRpcSessionIds, renameRpcSession, stopIdleRpcSession, subagentDisplayStatus } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged, handleModelToClient, extractFirstUserText } from "@/lib/session";
import { normalizeRawMessages } from "@/lib/normalize";
import { buildExternalPagedContext, clampTailParam } from "@/lib/external-session-paging";
import { listProviders } from "@/lib/session/providers";
import { resolvePlaceholderSession, removeHandle, stopDetachedSession } from "@/lib/session";
import { getPlaceholder, removePlaceholderByUuid } from "@/lib/session/placeholder";
import { projectTreeForResponse, toSummaryTree } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { startServerPerf } from "@/lib/perf";
import { computeSessionRevision } from "@/lib/session-revision";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSideRelation, sideOwnEntries } from "@/lib/side-session";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { deleteSessions } from "@/lib/session-delete";
import { waitForHostingSwitch } from "@/lib/session/hosting-lock";
import { waitSessionReady } from "@/lib/session/ready";
import { cachedSessionHistory } from "@/lib/session/history-cache";
import { attachTranscriptNotices, readSessionTranscriptNotices } from "@/lib/transcript-notices-server";

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

/**
 * Agent tag for a bridged/attached handle, derived from its provider source.
 *
 * `attachIfBridged` answers with two very different things: a TUI bridge attachment
 * (aiti-attach-agent — the file is owned by a pi TUI) and a handle adapter for a backend
 * that owns its own file (pi spawn via the agent-starter wrapper, or any provider whose
 * ownsFile claimed it). Labelling every attachment "tui-bridge" mislabelled spawn sessions
 * — the frontend reads this tag for the agent badge and for the model catalog.
 */
function handleAgentLabel(source: string | undefined): string {
  const s = source ?? "";
  if (s.includes("attach-agent")) return "tui-bridge";
  if (s.includes("pi-agent")) return "pi";
  return s.includes("/") ? s.split("/").pop()! : "tui-bridge";
}

/**
 * Placeholder title for an attached handle with no user text yet.
 */
function bridgedFirstMessageFor(agent: string): string {
  return agent === "tui-bridge" ? "(bridged session)" : "(backend session)";
}

/** Fixed response for bridged sessions (attach detection goes by socket/registry; the file is only for history replay). */
function bridgedOk(
  id: string,
  bridged: { isAlive(): boolean; send(c: unknown): Promise<unknown>; cwd?: string; source?: string; getModel?(): { id: string; provider: string } | undefined },
  page: { tail: number; before?: string | null } = { tail: 0 },
) {
  const agent = handleAgentLabel(bridged.source);
  const bridgedFirstMessage = bridgedFirstMessageFor(agent);
  return bridged.send({ type: "get_messages" }).catch(() => null)
    .then((r) => {
      // A dead/rebooting handle can fail this read right after an attach. Returning an empty
      // transcript would shadow the file (real history on disk) — answer null so the caller
      // falls through to the disk branch (2026-11-23: session showed blank while its jsonl
      // held the whole conversation).
      if (r === null) return null;
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
          firstMessage: extractFirstUserText(paged.messages as unknown[]) || bridgedFirstMessage,
          transient: true,
          agent,
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
  // A hosting switch stops the old process before starting the new one; wait
  // for it instead of answering from the half-switched window (404).
  await waitForHostingSwitch(id);
  const perf = startServerPerf("GET /api/sessions/[id]");
  const fresh = new URL(req.url).searchParams.has("fresh");
  // paging params for external backend/bridged sessions (same semantics as local pi sessions; omitted = start from the tail 50)
  const extParams = new URL(req.url).searchParams;
  const extTail = clampTailParam(extParams.get("tail"));
  const extBefore = extParams.get("before");
  // Read-path attach. A detached (single-client) wrapper can be held by another web instance;
  // our adoption then dies mid-handshake ("pi started and exited at once: superseded") and used to answer
  // 409. That is occupancy, not a fault: the on-disk copy is always safe to READ, so this
  // route serves it instead of putting a console error in front of readable history. Write
  // paths (POST /api/agent, /events) keep failing loud — two agents must never drive one file.
  // One refusal per request: the later attach points skip the retry (a second adoption would
  // just lose the same race and burn its handshake timeout).
  let readAttachBlocked = false;
  const attachForRead = async (sessionFile: string): Promise<Awaited<ReturnType<typeof attachIfBridged>>> => {
    if (readAttachBlocked) return undefined;
    try {
      return await attachIfBridged(sessionFile, { create: false });
    } catch (e) {
      if ((e as { name?: string }).name !== "BridgeOccupiedError") throw e;
      readAttachBlocked = true;
      console.warn(`[sessions] ${sessionFile}: ${(e as Error).message} — serving the disk view`);
      return undefined;
    }
  };
  try {
    perf?.span("resolve");
    // bridge-occupancy detection comes first (the TUI owns the file; even a stale local wrapper yields)
    const fpEarly = await resolveSessionPath(id);
    if (fpEarly) {
      const bridged = await attachForRead(fpEarly);
      // Oversized local file: a get_messages full dump would be a single JSONL line sized
      // like the whole session (>8MB kills the wrapper client / wire reader — blank
      // history + handle death + attach-race noise). The disk branch below serves paged
      // history instead; the attached handle (if any) stays in the store for SSE/sends.
      if (bridged?.isAlive() && !preferDiskHistory(fpEarly)) {
        const handled = await bridgedOk(id, bridged, { tail: extTail, before: extBefore });
        if (handled) return handled;
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
        await waitSessionReady(ph);
        let paged = { messages: [] as unknown[], entryIds: [] as string[], oldestEntryId: null as string | null, hasMore: false, totalCount: 0 };
        try {
          const r = (await ph.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
          paged = buildExternalPagedContext(r?.entries ?? [], { tail: extTail, before: extBefore });
        } catch { /* get_messages unavailable → empty */ }
        let { messages } = paged;
        let entryIds = paged.entryIds;
        const phHeader = readSessionHeader(fpEarly) as unknown as { agent?: string; extId?: string } | null;
        const cached = cachedSessionHistory([id, phHeader?.extId ?? "", phHeader?.extId?.split(":")[1] ?? ""]);
        if (cached && cached.length > messages.length) {
          messages = cached as typeof messages;
          entryIds = cached.map((_, index) => `cached-${index}`);
        }
        const firstText = extractFirstUserText(messages) || "(backend session)";
        // real placeholder title (registry extId → name; written at open-live/replay)
        const phName = phHeader?.extId ? getPlaceholder(phHeader.extId)?.name : undefined;
        // cwd fallback (2026-11-09): a freshly-attached handle may still carry its
        // constructor-default cwd ("" — start() not yet run / ACP spawn race), which
        // poisoned the selected-session identity (workspaceKeyOf("") → teardown to the
        // welcome composer on takeover/URL-restore). The placeholder registry always
        // knows the session's workspace (written at open-live/wireExternalPlaceholder).
        const phMeta = phHeader?.extId ? getPlaceholder(phHeader.extId) : undefined;
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
            cwd: ph.cwd || phMeta?.cwd || "",
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
          context: { messages, entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(ph.getModel?.()) },
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
    // (Oversized local files skip this too — same RPC-dump limit as the early
    // branch above; their history comes from the disk branch below.)
    const rpc = getRpcSession(id);
    if (!(rpc?.isAlive()) && !(fpEarly && preferDiskHistory(fpEarly))) {
      const wrapped = resolveAnySession(id);
      if (wrapped?.isAlive()) {
        await waitSessionReady(wrapped);
        // History replay: pull entries through the handle's get_messages
        // (capability-gated; backends without it serve an empty context and
        // the live SSE stream covers new turns).
        let paged = { messages: [] as unknown[], entryIds: [] as string[], oldestEntryId: null as string | null, hasMore: false, totalCount: 0 };
        let readFailed = false;
        try {
          const r = (await wrapped.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
          paged = buildExternalPagedContext(r?.entries ?? [], { tail: extTail, before: extBefore });
        } catch (e) {
          readFailed = true;
          console.error("[sessions/[id]] backend get_messages failed:", e instanceof Error ? e.message : e);
        }
        // A dead child still reports isAlive() true for a moment (stdin closed, no exit
        // event yet). The handle then cannot answer — but the session file can: fall through
        // to the disk branch instead of returning an empty transient row, which made a forked
        // session look "unopenable" while its jsonl held the whole conversation (2026-11-23).
        if (readFailed && fpEarly) {
          // intentionally empty: the disk branch below serves the history
        } else {
        let { messages } = paged;
        let entryIds = paged.entryIds;
        const cid = canonicalExternalId(id, wrapped.sessionId);
        const cached = cachedSessionHistory([id, cid, wrapped.sessionId]);
        if (cached && cached.length > messages.length) {
          messages = cached as typeof messages;
          entryIds = cached.map((_, index) => `cached-${index}`);
        }
        const firstText = extractFirstUserText(messages) || "(backend session)";
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
          context: { messages, entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(wrapped.getModel?.()) },
          totalActiveMs: 0,
        });
        }
      }
    }
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends the app itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = getLiveRpcSession(id);
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
          const bridgedById = await attachIfBridged(bridgeFile, { create: false }).catch((e: { name?: string }) => {
            if (e?.name === "BridgeOccupiedError") throw e;
            return undefined;
          });
          if (bridgedById?.isAlive()) {
            const handled = await bridgedOk(id, bridgedById, { tail: extTail, before: extBefore });
            if (handled) return handled;
          }
        } catch (e) {
          throw e;
        }
      }
      // Composite id ("<agentKey>:<sid>", multi-agent backend history) — on handle-store miss
      // (e.g. after a service restart) recover via openExternalSession by id (provider --resume),
      // then return through the wrapped branch; only a failed recovery 404s. Local pi session ids
      // have no ":", so this is skipped at zero cost.
      let externalOpenError = "";
      if (id.includes(":")) {
        try {
          const { openExternalSession, resolveAnySession: resolveHandle } = await import("@/lib/session");
          const sid = id.slice(id.indexOf(":") + 1);
          const handle = await openExternalSession(id, { sessionId: sid || undefined }).catch((e: unknown) => {
            externalOpenError = e instanceof Error ? e.message : String(e);
            return undefined;
          });
          const wrappedAfterOpen = handle?.alive() ? resolveHandle(id) : undefined;
          if (handle && wrappedAfterOpen?.isAlive()) {
            await waitSessionReady(wrappedAfterOpen);
            const cid = canonicalExternalId(id, handle.id);
            let paged = { messages: [] as unknown[], entryIds: [] as string[], oldestEntryId: null as string | null, hasMore: false, totalCount: 0 };
            try {
              const r = (await wrappedAfterOpen.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
              paged = buildExternalPagedContext(r?.entries ?? [], { tail: extTail, before: extBefore });
            } catch { /* get_messages unavailable → empty */ }
            let { messages } = paged;
            let entryIds = paged.entryIds;
            const cached = cachedSessionHistory([id, cid, sid]);
            if (cached && cached.length > messages.length) {
              messages = cached as typeof messages;
              entryIds = cached.map((_, index) => `cached-${index}`);
            }
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
              context: { messages, entryIds, oldestEntryId: paged.oldestEntryId, hasMore: paged.hasMore, thinkingLevel: "off", model: handleModelToClient(wrappedAfterOpen.getModel?.()) },
              totalActiveMs: 0,
            });
          }
          externalOpenError ||= handle
            ? (handle.alive() ? "handle not registered after open" : "backend process exited while resuming")
            : "no provider for this agentKey";
        } catch (e) {
          externalOpenError = e instanceof Error ? e.message : String(e);
        }
        if (externalOpenError) console.warn(`[sessions] external takeover failed for "${id}": ${externalOpenError}`);
      }
      return NextResponse.json(
        { error: "Session not found", ...(externalOpenError ? { reason: externalOpenError } : {}) },
        { status: 404 },
      );
    }
    // bridge-occupancy detection: the file is held by a TUI bridge → history comes back via the bridge's get_messages (no local open)
    // (Oversized local files are excluded — same RPC-dump limit; disk branch serves them.)
    if (!liveRpc && resolvedPath && !preferDiskHistory(resolvedPath)) {
      try {
        const bridged = await attachForRead(resolvedPath);
        if (bridged?.isAlive()) {
          const r = (await bridged.send({ type: "get_messages" }).catch(() => null)) as { entries?: unknown[] } | null;
          const messages = normalizeRawMessages(r?.entries ?? []);
          // Same tag derivation as bridgedOk(): a spawn handle attached here is not a TUI bridge.
          const agent = handleAgentLabel(bridged.source);
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
              firstMessage: extractFirstUserText(messages) || bridgedFirstMessageFor(agent),
              transient: true,
              agent,
            },
            leafId: null,
            tree: [],
            context: { messages, entryIds: [], thinkingLevel: "off", model: handleModelToClient(bridged.getModel?.()) },
            totalActiveMs: 0,
          });
        }
      } catch { /* fall through to local */ }
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
    perf?.span("open");
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const summaryTree = searchParams.get("tree") === "summary";
    const tree = summaryTree
      ? toSummaryTree(projectTreeForResponse(sm.getTree()))
      : projectTreeForResponse(sm.getTree());
    perf?.span("tree");
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    // pi's notices.* (#1265): cache, cost and provider notices on the messages they follow.
    const transcriptNotices = readSessionTranscriptNotices({
      entries: entries as unknown as SessionEntry[],
      cwd: sm.getHeader()?.cwd ?? "",
      leafId: leafId,
      models: liveRpc?.inner.modelRuntime,
    });
    const context = attachTranscriptNotices(buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    }), transcriptNotices);
    perf?.span("context");
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
    const ownEntries = sideOwnEntries(entries) as typeof entries;
    const totalActiveMs = computeSessionTotalActiveMs(ownEntries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(ownEntries as unknown as SessionEntry[]);
    perf?.span("stats");
    // Opaque freshness token for the session view cache. Derived from the
    // disk fingerprint and the actual read source; null tells the client the
    // snapshot is unstable and must not be cached as fresh.
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      // The notices switch changes the messages without touching the file.
      sourceId: `${liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : "disk"}${transcriptNotices ? "+notices" : ""}`,
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
      leafId: leafId ?? null,
    });
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
    const side = !subagent && header ? readSideRelation(entries as never) : null;
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
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: subagentDisplayStatus(header.id, subagent.status) } }
        : side
          ? { relation: { kind: "side" as const, ...side } }
          : header.parentSession
            ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
            : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return perf?.attach(NextResponse.json(
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
      },
    )) ?? NextResponse.json(
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
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
    const trimmed = name.trim();
    // single-writer red line: when a TUI bridge holds the file, it renames through the bridge
    // (set_session_name), never on disk behind the TUI's back.
    if (filePath) {
      // Read-only metadata operation: never spawn an agent just to rename.
      const bridged = await attachIfBridged(filePath, { create: false });
      if (bridged?.isAlive()) {
        const r = (await bridged.send({ type: "set_session_name", name: trimmed }).catch(() => null)) as { success?: boolean } | null;
        if (r?.success) return NextResponse.json({ ok: true, via: "bridge" });
        return NextResponse.json({ error: "Session is owned by a TUI bridge; rename not supported by its backend" }, { status: 409 });
      }
    }
    // A session a wrapper holds is renamed in it, never on disk behind its back (#1388).
    const renamed = await renameRpcSession(id, trimmed, () => {
      if (!filePath) return false;
      // No wrapper: appendSessionInfo on a fresh manager, bypassing the cache.
      const sm = openSessionManager(filePath, { mutable: true });
      sm.appendSessionInfo(trimmed);
      invalidateSessionManagerCache(filePath);
      invalidateSessionListCache();
      return true;
    });
    if (!renamed) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id] - the session and the subagent sessions below it (lib/session-delete.ts).
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // Local guards before the shared delete engine (lib/session-delete.ts):
    // single-writer red line (a TUI bridge owns the file -- deleting from the web
    // would blow up the TUI mid-write), idle-wrapper release, and the placeholder
    // anchor short-circuit.
    const deleteTargetPath = await resolveSessionPath(id);
    if (deleteTargetPath) {
      for (const p of listProviders()) {
        if (!p.ownsFile) continue;
        try {
          if (await p.ownsFile(deleteTargetPath)) {
            return NextResponse.json({ error: "Session is owned by a running agent bridge; close it there first" }, { status: 409 });
          }
        } catch { /* probe failure → treat as not-owned */ }
      }
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
    // Placeholder file: delete only the anchor (file + registry entry + live handle); the external
    // raw data (cursor store.db etc.) is never touched; no child sessions hang off a placeholder —
    // skip the shared cascade engine.
    let deleteHeader: { extId?: string } | null = null;
    if (deleteTargetPath) {
      try {
        deleteHeader = readSessionHeader(deleteTargetPath) as unknown as { extId?: string } | null;
      } catch (error) {
        // Empty runtime sessions have a cached path before their first disk write (upstream #440).
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (deleteHeader?.extId) {
      // External sessions can be hosted by a detached wrapper (agent-starter): stop
      // that process here — this branch bypasses the shared cascade engine, which is
      // where the ordinary delete stops wrapper-hosted agents.
      const sid = deleteHeader.extId.includes(":") ? deleteHeader.extId.slice(deleteHeader.extId.indexOf(":") + 1) : "";
      if (sid) await stopDetachedSession(sid).catch(() => false);
      removePlaceholderByUuid(id); // includes unlinking the placeholder file
      removeHandle(id); // retire the live handle (prevents a zombie transient row)
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    }
    const { missing, preserved } = await deleteSessions([id]);
    if (missing.length > 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    // A file written after its agent was stopped is kept (never lose data):
    // report it so the caller does not believe the row is gone.
    return NextResponse.json(preserved && preserved.length > 0 ? { ok: true, preserved } : { ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
