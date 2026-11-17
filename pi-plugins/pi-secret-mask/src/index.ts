/**
 * pi-secret-mask — session-level secret redaction for pi.
 *
 * Values the user pastes into prompts (tokens, API keys, credentials) are
 * replaced with stable placeholders like `[REDACTED:github-token]` before
 * anything is sent to the model, and placeholders the model echoes back
 * inside tool arguments are restored to the real values before the tool runs.
 * Session transcript stays untouched (the `context` hook is non-destructive);
 * only the model/provider boundary sees placeholders.
 *
 * Registered values also get redacted from tool results, so a value that is
 * echoed back by a command does not re-enter the context in the clear.
 *
 * Surfacing: /secret command. Coexistence: safe alongside keyshroud and any
 * other tool_result/context-redacting extension (hook chains compose, and
 * exact-match replacement sets are disjoint).
 */

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Registry, restoreDeepInPlace, redactDeep, auditPayload, type SecretState } from "@aiti-ai/secret-mask-core";
import { redactMessages } from "./messages.ts";
import { appendAuditLog, loadPersist, AUDIT_LOG_PATH, PERSIST_PATH } from "./commands.ts";

const SECTION_KEY = "secret_masking";

const SECTION_TEXT = [
  "Some credential values in this conversation are hidden behind placeholders like",
  "[REDACTED:alias] or [REDACTED:LABEL#ab12cd34]. Each placeholder stands for one real",
  "secret value that the user knows; it is restored automatically when passed verbatim in",
  "tool arguments. Rules: never guess, shorten, transform or invent the underlying value;",
  "copy the placeholder exactly as shown whenever you need to reference the credential",
  "(file edits, commands, config); do not ask the user to paste the value into chat.",
].join("\n");

interface ExtensionState extends SecretState {
  sessionLoaded: boolean;
  sessionId: string;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const state: ExtensionState = {
    registry: new Registry(),
    enabled: true,
    salt: randomBytes(4).toString("hex"),
    cwd: process.cwd(),
    persisted: false,
    audit: false,
    persistPath: PERSIST_PATH,
    auditPath: AUDIT_LOG_PATH,
    sessionLoaded: false,
    sessionId: "",
  };

  pi.on("session_start", (_event, ctx) => {
    state.salt = randomBytes(4).toString("hex");
    state.cwd = ctx.cwd || process.cwd();
    try { state.sessionId = ctx.sessionManager?.getSessionId?.() ?? ""; } catch { state.sessionId = ""; }
    if (!state.sessionLoaded) {
      loadPersist(state, PERSIST_PATH);
      state.sessionLoaded = true;
    }
  });

  // Send-boundary redaction. The event carries a deep copy: edits here never
  // reach the session transcript, only the provider payload.
  pi.on("context", (event) => {
    if (!state.enabled) return undefined;
    const res = redactMessages(event.messages as unknown[], state.registry, state.salt, {});
    return res.changed ? { messages: event.messages } : undefined;
  });

  // Tell the model what the placeholders mean (idempotent keyed section).
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (!sections) return undefined;
    if (state.enabled && state.registry.size > 0) sections[SECTION_KEY] = SECTION_TEXT;
    else if (SECTION_KEY in sections) delete sections[SECTION_KEY];
    return undefined;
  });

  // Restore placeholders the model echoed back, before the tool executes with
  // the real values. Restoring into Bash is intentional (the primary use case
  // is "use this key in a command"); tools can be tightened via /secret off.
  pi.on("tool_call", (event) => {
    if (!state.enabled || state.registry.size === 0) return undefined;
    const count = restoreDeepInPlace(event.input, state.registry);
    void count;
    return undefined;
  });

  // Send-audit (proof layer): scan the FINAL wire payload after every earlier
  // hook chain, count placeholders and — the actual proof — any registered raw
  // value that is about to leave the machine. Leaks raise an immediate alarm.
  pi.on("before_provider_request", (event, ctx) => {
    if (!state.enabled || !state.audit || state.registry.size === 0) return undefined;
    const a = auditPayload(event.payload, state.registry);
    const result: AuditResult = {
      time: new Date().toISOString(),
      sessionId: state.sessionId || ctx.sessionManager?.getSessionId?.() || "",
      strings: a.strings,
      placeholders: a.placeholders,
      leaks: a.leaks,
      leakedLabels: a.leakedLabels,
    };
    state.lastAudit = `${a.leaks} leak(s), ${a.placeholders} placeholder(s)`;
    appendAuditLog(result, AUDIT_LOG_PATH);
    if (a.leaks > 0) {
      try { ctx.ui.notify(`secret-mask LEAK: ${a.leaks} registered value(s) found in the outgoing payload (${a.leakedLabels.join(", ")}) — check /secret audit show`, "error"); } catch {}
    }
    return undefined;
  });

  // Keep registered values out of tool output that is about to enter the
  // context (and the session record). Also scrubs details/structured data.
  pi.on("tool_result", (event) => {
    if (!state.enabled || state.registry.size === 0) return undefined;
    let changed = false;
    const content = Array.isArray(event.content)
      ? event.content.map((part) => {
          const p = part as { type?: string; text?: string };
          if (p && p.type === "text" && typeof p.text === "string") {
            const res = state.registry.redact(p.text);
            if (res.count > 0) {
              changed = true;
              return { ...p, text: res.text };
            }
          }
          return part;
        })
      : event.content;
    const eventAny = event as { details?: unknown; structuredContent?: unknown };
    let details: { value: unknown; count: number } | undefined;
    let structured: { value: unknown; count: number } | undefined;
    if (eventAny.details !== undefined && eventAny.details !== null) {
      details = redactDeep(eventAny.details, state.registry);
      if (details.count > 0) changed = true;
      else details = undefined;
    }
    if (eventAny.structuredContent !== undefined && eventAny.structuredContent !== null) {
      structured = redactDeep(eventAny.structuredContent, state.registry);
      if (structured.count > 0) changed = true;
      else structured = undefined;
    }
    if (!changed) return undefined;
    // Replacing content drops structured content unless it is returned with it.
    return {
      ...(Array.isArray(event.content) && changed ? { content } : {}),
      ...(details ? { details: details.value } : {}),
      ...(structured
        ? { structuredContent: structured.value }
        : Array.isArray(event.content) && eventAny.structuredContent !== undefined
          ? { structuredContent: eventAny.structuredContent }
          : {}),
    } as never;
  });

  pi.registerCommand("secret", {
    description: "Register/redact secrets: add [as alias], list, remove, clear, on/off, status, save/unload",
    handler: async (args: string, ctx: ExtensionContext) => {
      const outcome = await handleSecretCommand(state, args ?? "", {
        input: (title: string) => ctx.ui.input(title, "Value never reaches the model"),
      });
      ctx.ui.notify(outcome.text, outcome.ok ? "info" : "warning");
    },
  });
}
