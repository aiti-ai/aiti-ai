/**
 * session-auto-name — the provider-owned auto-name path.
 *
 * Background (see aiti-pi-agent): sessions spawned by provider backends (e.g.
 * aiti-pi-agent's `pi --mode rpc` subprocess) are single-writer claimed via
 * `SessionProvider.ownsFile`, so the core must never open them in a local
 * runtime. The auto-name route's historical path (startRpcSession →
 * generateSessionTitle) therefore always failed for them with 409
 * "session bridged; auto-name skipped".
 *
 * This module names such sessions WITHOUT a runtime:
 *
 *   - transcript: live handle get_messages (normalized) or a file read
 *   - model: live handle getModel() or the file's last model_change entry;
 *     unknown/missing → invokeAI's default (cheapest non-reasoning model)
 *   - generation: a one-shot model call through lib/ai-invoke (invokeAI),
 *     independent of AgentSession — see generateSessionTitleFromTranscript
 *   - write: live handle → set_session_name RPC (the backend owns the file);
 *     cold file → appendSessionInfo on a mutable SessionManager
 *     (last-writer-wins, same precedent as PATCH rename)
 *
 * TUI-bridged sessions are handled by the route BEFORE this module (they keep
 * their 409 and the frontend's manual-rename downgrade).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  entryToUiMessage,
  getLatestModelChange,
  getSessionEntries,
  invalidateSessionListCache,
  invalidateSessionManagerCache,
  openSessionManager,
} from "./session-reader";
import { resolveAnySession, resolveAttachBySessionId } from "./session";
import { listProviders, type SessionProvider } from "./session/providers";
import {
  buildTitleTranscript,
  generateSessionTitleFromTranscript,
  TITLE_MAX_TOKENS,
  type GeneratedSessionTitle,
  type TitleInvocator,
} from "./session-title";
import { invokeAI } from "./ai-invoke";

/** Find the provider that single-writer claims this session file (probe failures = not owned). */
export async function findSessionFileOwner(filePath: string): Promise<SessionProvider | undefined> {
  for (const p of listProviders()) {
    if (!p.ownsFile) continue;
    try {
      if (await p.ownsFile(filePath)) return p;
    } catch (e) {
      console.error(`[auto-name] ${p.type}.ownsFile failed:`, e instanceof Error ? e.message : e);
    }
  }
  return undefined;
}

/** invokeAI usage shape → GeneratedSessionTitle.usage shape (total is derived). */
function toTitleUsage(u: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined) {
  if (!u) return undefined;
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total: u.input + u.output + u.cacheRead + u.cacheWrite };
}

/** One-shot title model call. A session model that the core's registry does not
 *  know (e.g. the spawn child used another models.json) falls back to invokeAI's
 *  default — the cheapest non-reasoning model. */
async function invokeTitleModel(
  model: { provider: string; id: string } | undefined,
  sessionId: string,
  system: string,
  userText: string,
): Promise<{ text: string; usage?: GeneratedSessionTitle["usage"] }> {
  const base = {
    system,
    messages: [{ role: "user" as const, content: userText }],
    maxTokens: TITLE_MAX_TOKENS,
    reasoning: "off",
    sessionId,
    caller: "core-auto-name",
  };
  if (!model) {
    const r = await invokeAI(base);
    return { text: r.text, usage: toTitleUsage(r.usage) };
  }
  try {
    const r = await invokeAI({ ...base, provider: model.provider, modelId: model.id });
    if (!r.text?.trim()) console.error(`[auto-name] invokeAI returned empty text for ${model.provider}/${model.id}: ${JSON.stringify(r.usage ?? {})}`);
    return { text: r.text, usage: toTitleUsage(r.usage) };
  } catch (e) {
    console.error(`[auto-name] invokeAI failed for ${model.provider}/${model.id}:`, e instanceof Error ? e.message : e);
    if (e instanceof Error && e.message.startsWith("model-not-found:")) {
      const r = await invokeAI(base);
      return { text: r.text, usage: toTitleUsage(r.usage) };
    }
    throw e;
  }
}

/**
 * Generate and persist a title for a provider-owned session file.
 *
 * @param id     pi-web session id (handle-store / list key).
 * @param filePath  session file on disk (the claimed file).
 * @param invoke    optional invocator override (tests); defaults to the invokeAI adapter.
 */
export async function autoNameProviderOwned(
  id: string,
  filePath: string,
  invoke?: TitleInvocator,
): Promise<GeneratedSessionTitle> {
  // ── transcript + model ──
  // Live-handle resolution: handle store first, then the detached wrapper
  // registry — a wrapper-hosted subprocess owns the file even when no handle
  // is attached yet, so naming must go through its RPC, never a disk append.
  const live = resolveAnySession(id) ?? (await resolveAttachBySessionId(id).catch(() => undefined));
  let messages: AgentMessage[] | null = null;
  let model: { provider: string; id: string } | undefined;
  if (live?.isAlive()) {
    try {
      const r = (await live.send({ type: "get_messages" })) as { entries?: unknown[] } | null;
      if (Array.isArray(r?.entries)) messages = r.entries as unknown as AgentMessage[];
    } catch (e) {
      console.error(`[auto-name] live get_messages failed (falling back to disk):`, e instanceof Error ? e.message : e);
    }
    model = live.getModel?.();
  }
  if (!messages) {
    const entries = getSessionEntries(filePath);
    messages = entries
      .map((entry) => entryToUiMessage(entry, {}))
      .filter((m) => m !== null) as unknown as AgentMessage[];
    if (!model) {
      const latest = getLatestModelChange(entries);
      if (latest) model = { provider: latest.provider, id: latest.modelId };
    }
  }

  // ── generate (one-shot, no runtime) ──
  const transcript = buildTitleTranscript(messages);
  const result = await generateSessionTitleFromTranscript(
    transcript,
    invoke ?? ((system, userText) => invokeTitleModel(model, id, system, userText)),
  );

  // ── write ──
  // Double-check the handle AFTER generation: the session may have been started
  // while the title model ran. A live backend owns the file — rename through it
  // (set_session_name RPC), never on disk behind its back.
  const handle = resolveAnySession(id) ?? (await resolveAttachBySessionId(id).catch(() => undefined));
  if (handle?.isAlive()) {
    await handle.send({ type: "set_session_name", name: result.title });
  } else {
    const sm = openSessionManager(filePath, { mutable: true });
    sm.appendSessionInfo(result.title);
    invalidateSessionManagerCache(filePath);
  }
  invalidateSessionListCache();
  return result;
}
