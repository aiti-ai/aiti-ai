/**
 * piweb-job-provider — the app's launchable backends as subagent executors (external-job provider).
 *
 * Exposes all launchable agents of the app (pi RPC / claude-code ACP / qoder ACP / …) to the
 * fork's (@aiti-ai/pi-subagents) Agent tool: an agent md declares
 *   runner: { type: external-job, provider: pi-web-rpc, options: { backend: <agentKey> } }
 * and a delegation starts a real app session via this provider — persisted to disk, listed in the
 * session list, openable/attachable from the frontend, steer/abort-capable (session level); when
 * done, the fork gets the final output back.
 *
 * Unified execution path: SessionHandle (prompt/abort/subscribe + isRunning edge detection for
 * completion, no polling). backend=pi uses a local rpc session (fork empty session +
 * startRpcSession, same persistence semantics as lib/subagent.ts createSubagentSession); other
 * backends are routed via the session provider registry (findProvidersForAgent) to the matching
 * ACP/bridge backend.
 *
 * Boundaries (MVP):
 *   - the agent md's systemPrompt and other instructions are assembled into the full prompt by
 *     the fork (external-job contract);
 *   - the fork side has no stop channel for external-job — abort by opening the session in the
 *     frontend;
 *   - followUp: steer capability preferred, degrading to a queued prompt when absent.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ensurePlaceholder } from "@/lib/session/placeholder";
import { notifySessionCreated } from "@/lib/session-created-notify";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  findProvidersForAgent,
  createLocalHandle,
  createSessionHandle,
  type SessionHandle,
} from "@/lib/session";

/** Provider name (the agent md's runner.provider must match this). */
export const PIWEB_JOB_PROVIDER_NAME = "pi-web-rpc";

interface PiWebJob {
  id: string;
  backend: string;
  state: "queued" | "running" | "completed" | "failed" | "stopped";
  started: boolean;
  done: boolean;
  output?: string;
  error?: string;
  /** pi backend: persisted session file (used by the frontend to open/attach). */
  sessionFile?: string;
  handle?: SessionHandle;
  created: number;
  /** External backends: parent session file / agent name / task / runId / parent session id / real composite id after rebinding */
  parentFile?: string;
  agent?: string;
  prompt?: string;
  runId?: string;
  cwd?: string;
  parentSessionId?: string;
  realChildId?: string;
}

const jobs = new Map<string, PiWebJob>();
const MAX_JOBS = 200;

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const entries = [...jobs.entries()].sort((a, b) => a[1].created - b[1].created);
  while (entries.length > MAX_JOBS) {
    const [id] = entries.shift()!;
    if (jobs.get(id)?.done) jobs.delete(id);
  }
}

/** Last assistant text (returns undefined when the getMessages capability is absent). */
async function lastAssistantText(handle: SessionHandle): Promise<string | undefined> {
  try {
    if (!handle.getMessages) return undefined;
    const messages = (await handle.getMessages()) as Array<Record<string, unknown>>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      const content = m.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : ""))
          .join("");
        if (text) return text;
      }
    }
  } catch { /* capability unavailable → undefined */ }
  return undefined;
}

/** pi backend: fork empty session + rpc session + local handle. */
async function startPiBackend(cwd: string, parentSessionFile?: string): Promise<{ handle: SessionHandle; sessionFile: string }> {
  const sm = SessionManager.create(cwd, undefined, { id: randomUUID() });
  sm.newSession(parentSessionFile ? { parentSession: parentSessionFile } : undefined);
  // Unified creator-side notification: job provider sessions show up in the sidebar immediately (previously nothing was broadcast).
  notifySessionCreated(sm.getSessionId(), cwd, "job-provider");
  try {
    (sm as unknown as { _rewriteFile?: () => void })._rewriteFile?.();
    (sm as unknown as { flushed?: boolean }).flushed = true;
  } catch { /* lazy persistence is fine too */ }
  const sessionFile = sm.getSessionFile();
  if (!sessionFile) throw new Error("pi backend failed to start: no session file was generated");
  const { startRpcSession } = await import("@/lib/rpc-manager");
  const { session: wrapper } = await startRpcSession(`__subagent__${randomUUID()}`, sessionFile, cwd, {});
  return { handle: createLocalHandle(wrapper), sessionFile };
}

/**
 * Parent pi session id (fork ExternalJobStartInput.sessionId) → session file path (the pi
 * backend's parentSession marker — the Fleet tree groups subagents under the parent session).
 * Returns empty when the reverse lookup fails (no marker). Only hits live sessions in the rpc
 * registry; historical parent sessions go through resolveSessionPath.
 */
async function parentFileOf(parentSessionId: string | undefined): Promise<string | undefined> {
  if (!parentSessionId) return undefined;
  try {
    const { getRpcSession } = await import("@/lib/rpc-manager");
    const wrapper = getRpcSession(parentSessionId);
    if (wrapper?.sessionFile) return wrapper.sessionFile;
  } catch { /* rpc layer unavailable */ }
  try {
    const { resolveSessionPath } = await import("@/lib/session-reader");
    return (await resolveSessionPath(parentSessionId)) ?? undefined;
  } catch { /* reverse lookup failed */ }
  return undefined;
}

/** agentKey → provider type (createSessionHandle needs providerType). */
function providerTypeFor(backend: string): string {
  const provider = findProvidersForAgent(backend)[0];
  if (!provider) throw new Error(`No session provider registered for backend="${backend}" (check that the corresponding extension is installed / the CLI is on PATH)`);
  return provider.type;
}

/** Install the provider (called at instrumentation startup; idempotent). */
export function installPiWebJobProvider(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__piWebJobProviderInstalled) return;
  g.__piWebJobProviderInstalled = true;

  void (async () => {
    try {
      // Load the fork package's source module directly via jiti (the Symbol.for registry is shared
      // across module copies — same store as the fork extension)
      const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
      const modPath = path.join(agentDir, "npm", "node_modules", "@aiti-ai", "pi-subagents", "src", "api", "external-job-provider.ts");
      if (!fs.existsSync(modPath)) {
        console.warn(`[piweb-job-provider] fork external-job-provider not found; skipping registration: ${modPath}`);
        return;
      }
      const { createJiti } = await import("jiti");
      const jiti = createJiti(import.meta.url);
      const mod = (await jiti.import(modPath)) as {
        registerExternalJobProvider: (provider: unknown) => unknown;
      };
      mod.registerExternalJobProvider({
        name: PIWEB_JOB_PROVIDER_NAME,

        start(input: { prompt: string; cwd: string; agent?: string; runId?: string; options?: { backend?: string }; sessionId?: string }) {
          const backend = String(input.options?.backend || "pi").trim() || "pi";
          const id = `pwj_${randomUUID()}`;
          const job: PiWebJob = { id, backend, state: "queued", started: false, done: false, created: Date.now() };
          job.agent = input.agent ? String(input.agent) : undefined;
          job.prompt = input.prompt ? String(input.prompt) : undefined;
          job.runId = input.runId ? String(input.runId) : undefined;
          job.cwd = input.cwd ? String(input.cwd) : undefined;
          job.parentSessionId = input.sessionId ? String(input.sessionId) : undefined;
          jobs.set(id, job);
          pruneJobs();

          void (async () => {
            try {
              job.parentFile = input.sessionId ? await parentFileOf(input.sessionId) : undefined;
              let handle: SessionHandle;
              if (backend === "pi") {
                const started = await startPiBackend(input.cwd || process.cwd(), await parentFileOf(input.sessionId));
                handle = started.handle;
                job.sessionFile = started.sessionFile; // fix: never assigned before → dead conversationUrl logic
              } else {
                handle = await createSessionHandle({
                  providerType: providerTypeFor(backend),
                  cwd: input.cwd || process.cwd(),
                });
              }
              job.handle = handle;
              // Non-pi backend handles are registered through the unified wrapper (putHandle +
              // session_backend_ready rebinding listener — cursor/claude's chatId only arrives
              // with the init frame; after rebinding, ?session=cursor:<chatId> survives restarts).
              // Completion detection: event-driven isRunning edge (no polling)
              handle.subscribe((event) => {
                // the real native id (e.g. cursor chatId) is only known after the backend's first message — record the rebind result for link persistence
                if (event && event.type === "session_backend_ready" && typeof (event as unknown as { id?: unknown }).id === "string") {
                  job.realChildId = String((event as unknown as { id: unknown }).id);
                }
                if (job.done || !job.started) return;
                if (!handle.isRunning()) void finalize(job, handle);
              });
              job.state = "running";
              job.started = true;
              await handle.prompt(input.prompt);
            } catch (e) {
              job.state = "failed";
              job.done = true;
              job.error = e instanceof Error ? e.message : String(e);
            }
          })();

          return { providerJobId: id, state: "queued" as const };
        },

        followUp(input: { parentProviderJobId: string; prompt?: string; requestId?: string }) {
          const job = jobs.get(input.parentProviderJobId);
          if (!job?.handle) return { providerJobId: input.parentProviderJobId, state: job?.state ?? "failed", failureCode: "unknown-job" };
          void (async () => {
            try {
              if (job.handle!.steer) await job.handle!.steer(input.prompt ?? "");
              else await job.handle!.prompt(input.prompt ?? "");
            } catch (e) {
              job.error = e instanceof Error ? e.message : String(e);
            }
          })();
          return { providerJobId: input.parentProviderJobId, state: job.done ? "completed" : "running" };
        },

        status: (providerJobId: string) => statusJob(providerJobId),

        result(providerJobId: string) {
          const job = jobs.get(providerJobId);
          if (!job) return { providerJobId, state: "failed" as const, failureCode: "unknown-job" };
          return {
            providerJobId,
            state: job.state,
            ...(job.output ? { output: job.output } : {}),
            ...(job.error ? { failureMessage: job.error } : {}),
            ...(job.sessionFile ? { conversationUrl: `pi-web-session:${job.sessionFile}` } : {}),
          };
        },

        reattach: (providerJobId: string) => statusJob(providerJobId),
      });
      console.log(`[piweb-job-provider] registered "${PIWEB_JOB_PROVIDER_NAME}" — pi-web backends available as subagent executors`);
    } catch (e) {
      console.warn("[piweb-job-provider] registration failed (fork not installed or load error):", e instanceof Error ? e.message : e);
    }

  function statusJob(providerJobId: string) {
    const job = jobs.get(providerJobId);
    if (!job) return { providerJobId, state: "failed" as const, failureCode: "unknown-job", failureMessage: "job not found (historical jobs are not queryable after a process restart)" };
    if (!job.done && job.started && job.handle && !job.handle.isRunning()) {
      void finalize(job, job.handle); // conservative convergence when the event is missing (driven by the fork's active queries, not polling)
    }
    const state = job.done ? job.state : job.state === "queued" ? ("queued" as const) : ("running" as const);
    return { providerJobId, state, ...(job.error ? { failureMessage: job.error } : {}) };
  }
  })();
}

/** Finalize: capture the last assistant output + mark the state. */
async function finalize(job: PiWebJob, handle: SessionHandle): Promise<void> {
  if (job.done) return;
  job.done = true;
  try {
    job.output = (await lastAssistantText(handle)) ?? "";
    job.state = "completed";
  } catch (e) {
    job.state = "failed";
    job.error = e instanceof Error ? e.message : String(e);
  }
  // External backends: backfill the child session placeholder's parent link
  // (header.parentSession = parent session file) — the placeholder itself was already persisted
  // by createSessionHandle's wireExternalPlaceholder; this step wires up the 🤖 subagent
  // badge/parent-child tree (session-reader computes the relation from header.parentSession);
  // opening still routes to the real backend (history messages untouched).
  if (job.backend !== "pi") linkExternalSubagentPlaceholder(job, handle);
}

/** Backfill the external subagent placeholder's parent link: childId (real composite id after rebinding, falling back to the original handle id) → parent session file. */
function linkExternalSubagentPlaceholder(job: PiWebJob, handle: SessionHandle): void {
  try {
    const childId = job.realChildId || handle.id;
    if (!childId || !childId.includes(":")) return;
    if (!job.parentFile && !job.parentSessionId) return;
    ensurePlaceholder({
      extId: childId,
      agent: job.agent || childId.slice(0, childId.indexOf(":")),
      ...(handle.cwd ? { cwd: handle.cwd } : {}),
      ...(job.parentFile ? { parentSessionFile: job.parentFile } : {}),
    });
  } catch { /* placeholder parent-link failure does not affect the delegation main flow */ }
}
