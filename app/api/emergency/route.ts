import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { randomUUID } from "crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Fallback temp working directory: when no cwd is given, create ~/aiti-<YYYYMMDD>
// (isolated, never touches the home directory directly, one per day) so the rescue AI
// gets a clean starting point (it can still reach real directories like the web app /
// ~/.pi/web via absolute paths).
async function createTempCwd(): Promise<string> {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const dir = path.join(os.homedir(), "aiti-" + ts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/emergency { message, cwd, sessionId? }
// Minimal rescue AI (crash-rescue §5.2) — streaming: subscribes to session.onEvent
// (raw events, with partials) and pushes the AI output through verbatim (assistant
// text deltas + tool call markers) until agent_settled. The client fetch+reader keeps
// appending and displays everything without waiting for completion. No chat UI, no
// SSE event parsing, no text formatting. Multi-turn: reuse the same session via the
// x-session-id of the first response.
//
// Sessions: normal sessions (not noExtensions); collectAgentTools is try/catch-tolerant
// per extension. Before creating a new session, temporarily enable the config-backup
// extension's agentTools.enabled (off by default) → injects the aiti_configs_* tools,
// satisfying "the rescue AI may use the config extension's tools".
export async function POST(req: Request) {
  let body: { message?: unknown; cwd?: unknown; sessionId?: unknown; model?: unknown; errors?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message : "";
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const prevId = typeof body.sessionId === "string" ? body.sessionId : "";
  // Errors collected by the frontend (indicator registry / global-error page errors)
  // are spliced into the AI message when creating a new session — a rescue AI that
  // doesn't know what broke can't rescue anything.
  const errors = Array.isArray(body.errors)
    ? body.errors
        .filter((e): e is { message?: unknown; stack?: unknown; extId?: unknown; slot?: unknown; itemId?: unknown } => !!e && typeof e === "object")
        .map((e) => ({ message: String(e.message ?? ""), stack: String(e.stack ?? ""), extId: String(e.extId ?? ""), slot: String(e.slot ?? ""), itemId: String(e.itemId ?? "") }))
    : [];
  // Optional model switch (when the default model is rate-limited/unavailable): { provider, modelId }
  const model =
    body.model && typeof body.model === "object"
      ? {
          provider: typeof (body.model as { provider?: unknown }).provider === "string" ? (body.model as { provider: string }).provider : "",
          modelId: typeof (body.model as { modelId?: unknown }).modelId === "string" ? (body.model as { modelId: string }).modelId : "",
        }
      : null;
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  // The wrapper type is cross-file; used structurally (send always present; onEvent/inner
  // optional) — no any, keeping eslint happy.
  // send returns Promise<unknown> (wrapper generic erasure); callers only attach catch
  // and never consume the value.
  let session: {
    send: (cmd: { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }) => Promise<unknown>;
    onEvent?: (handler: (ev: { type?: string; assistantMessageEvent?: { partial?: { content?: unknown[] } } }) => void) => () => void;
    inner?: { getLastAssistantText?: () => string | undefined };
  } | null = null;
  let realId: string | undefined = prevId || undefined;
  try {
    if (prevId) {
      const ex = getRpcSession(prevId);
      if (ex?.isAlive()) {
        session = ex;
      } else {
        const fp = await resolveSessionPath(prevId);
        if (fp) ({ session } = await startRpcSession(prevId, fp, undefined));
      }
    }
    if (!session) {
      // Without cwd, fall back to the home directory server-side — the whole point of
      // the rescue entry is that the normal flow is broken (no session / crashed page),
      // so it must not refuse for a missing cwd. The aiti_configs_* tools work with
      // absolute paths, and so does bash.
      const useCwd = cwd || (await createTempCwd());
      // Enable the config-backup extension's agentTools (off by default) → collectAgentTools
      // injects the aiti_configs_* tools. Timing-safe: startRpcSession runs collectAgentTools
      // synchronously before returning, so restoring the flag cannot affect tools already
      // injected into this session.
      const ext = (globalThis as Record<string, unknown> & { __piWebExt?: { setFeatureFlag?: (id: string, f: string, v: boolean) => void; featureEnabled?: (id: string, f: string) => boolean } }).__piWebExt;
      const prevCfg = ext?.featureEnabled?.("aiti-configs", "agentTools.enabled") ?? false;
      if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", true);
      try {
        const r = await startRpcSession(`__emg__${randomUUID()}`, "", useCwd, model ? { initialModel: model } : {});
        session = r.session;
        realId = r.realSessionId;
      } finally {
        if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", prevCfg);
      }
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  if (!session) return Response.json({ error: "session unavailable" }, { status: 503 });
  const s = session; // const narrowing: directly usable inside the start(controller)/onEvent closures (let loses narrowing across closures)

  const encoder = new TextEncoder();
  let closed = false;
  let lastText = "";
  const emittedTools = new Set<string>();
  const flushTimers: ReturnType<typeof setTimeout>[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (s: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(s)); } catch { /* stream closed */ }
      };
      let lastEventAt = Date.now();

      const off = s.onEvent?.((ev: { type?: string; assistantMessageEvent?: { partial?: { content?: unknown[] } } }) => {
        const t = ev.type;
        lastEventAt = Date.now();
        // assistant text deltas (raw partial.content carrying text blocks)
        if (t === "message_update" && ev.assistantMessageEvent?.partial?.content && Array.isArray(ev.assistantMessageEvent.partial.content)) {
          const content = ev.assistantMessageEvent.partial.content as Array<{ type?: string; text?: string; name?: string; toolName?: string; id?: string; toolCallId?: string }>;
          // text deltas
          const full = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
          if (full.length > lastText.length) {
            enqueue(full.slice(lastText.length));
            lastText = full;
          }
          // tool call markers (new toolCall blocks)
          for (const b of content) {
            if (b && b.type === "toolCall") {
              const id = b.id || b.toolCallId || b.name || b.toolName || "";
              const name = b.name || b.toolName || "?";
              if (id && !emittedTools.has(id)) {
                emittedTools.add(id);
                enqueue(`\n→ Calling tool: ${name}\n`);
              }
            }
          }
        } else if (t === "agent_settled") {
          // Turn finished: if partials produced no text (some models only emit the full
          // text at settled), fall back to getLastAssistantText() and flush it verbatim;
          // close the stream after a short delay (to flush trailing events).
          if (!lastText) {
            try {
              const fin = (s.inner?.getLastAssistantText?.() ?? "") as string;
              if (fin) { enqueue(fin); lastText = fin; }
            } catch { /* ignore */ }
          }
          if (!lastText) enqueue("\n[rescue] AI returned no text (the model may be rate-limited or erroring; retry or switch models)");
          const tm = setTimeout(() => {
            if (closed) return;
            closed = true;
            try { off?.(); } catch { /* ignore */ }
            try { controller.close(); } catch { /* stream closed */ }
          }, 400);
          flushTimers.push(tm);
        }
      });

      // Hard timeout at 240s (a rescue run can take a long time)
      const timeout = setTimeout(() => {
        if (closed) return;
        enqueue("\n[rescue] Timed out after 240s, stream closed");
        closed = true;
        try { off?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* stream closed */ }
      }, 240000);
      flushTimers.push(timeout);

      // Inactivity fallback: only close the stream after 150s with no events at all
      // (the AI may run bash etc. for read-only investigation with 30-60s+ without new
      // events; 30s would be too aggressive and kill it mid-work; 150s only fires on a
      // real hang; the 240s hard timeout remains the ceiling)
      const actTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastEventAt > 150000) {
          enqueue("\n[rescue] No activity for 150s, stream closed");
          closed = true;
          try { off?.(); } catch { /* ignore */ }
          try { controller.close(); } catch { /* stream closed */ }
        }
      }, 5000);
      flushTimers.push(actTimer as unknown as ReturnType<typeof setTimeout>);

      // Client disconnected
      req.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        try { off?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* stream closed */ }
      });

      // When creating a new session (no sessionId), splice the frontend-collected errors
      // plus available backend context into the AI message so the rescue AI knows where
      // the problem is; when reusing a session the history already contains it, so don't
      // repeat it.
      let aiMessage = message;
      if (!prevId) {
        const ctx: string[] = [];
        // Rescue operating rules: back up before changing, ensure recoverability, avoid
        // data loss (prompt tuning)
        ctx.push(
          "[Rescue operating rules — must be followed before changing anything]",
          "1. Before touching any file/config/data, first make a rollback-safe backup with a unique, timestamped name/identifier: before editing a file, cp it to `<filename>.<YYYYMMDD-HHMMSS>.bak` (full date+time, e.g. 20260831-143052, to avoid mixing with or overwriting older .bak files); or git stash under a timestamped named stash (name includes YYYYMMDD-HHMMSS). Before changing config/state, take a snapshot (e.g. aiti_configs_status / git status) and note the point in time.",
          "2. Every modification must come with one clear, executable-after-the-fact recovery path (a concrete recovery command or set of steps), and the reply must tell the user how to restore.",
          "3. Avoid recovery that loses data: never delete content that has no backup; back up before overwriting; before editing committed files, confirm there are no uncommitted changes from others; when unsure of the blast radius, investigate read-only first before acting.",
          "4. If the problem is complex or the fix is unclear, investigate read-only first (read files / check state / run read-only commands), propose a plan, and only change things after the user confirms.",
          ""
        );
        if (errors.length) {
          ctx.push("[Errors collected from the frontend] (" + errors.length + " total)");
          errors.forEach((e, i) => {
            ctx.push(`${i + 1}. [${e.extId || "?"}] ${e.slot || ""}${e.itemId ? "/" + e.itemId : ""} ${e.message}`);
            if (e.stack) ctx.push("  Stack: " + e.stack);
          });
          ctx.push("");
        }
        aiMessage = (ctx.length ? ctx.join("\n") + "\n\n" : "") + message;
      }
      // When reusing a session, the agent may still be streaming the previous message —
      // without streamingBehavior this throws "Agent is already processing. Specify
      // streamingBehavior ('steer' or 'followUp') to queue the message." and retries
      // would hang forever. Passing steer: if streaming, interrupt/take over (queued
      // steering); if not streaming, run normally — so a retry after the first network
      // error takes over immediately instead of freezing with an error.
      s.send({ type: "prompt", message: aiMessage, streamingBehavior: "steer" }).catch((e: unknown) => {
        enqueue(`\n[send error] ${e instanceof Error ? e.message : String(e)}`);
        if (!closed) { closed = true; try { off?.(); } catch { /* ignore */ } try { controller.close(); } catch { /* stream closed */ } }
      });
    },
    cancel() {
      closed = true;
      for (const tm of flushTimers) clearTimeout(tm);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-session-id": realId || "",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
