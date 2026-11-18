/**
 * pi-secret-mask — session-level secret redaction for pi.
 *
 * Values the user pastes into prompts (tokens, API keys, credentials) are
 * replaced with opaque, credential-shaped placeholders (`rsec_<hash8>`) before
 * anything reaches the model, and placeholders the model echoes back inside
 * tool arguments are restored to the real values before the tool runs.
 *
 * Hooks (all shared with @aiti-ai/pi-secret-vault, which adds the vault：
 * persistence layer):
 *   context / context_with_system  send-boundary redaction (messages, system)
 *   before_agent_start             placeholder usage contract for the model
 *   tool_call                      unresolved-placeholder guard + restore
 *   tool_result                    reverse redaction of tool output
 *   message_end                    on-disk redaction (landing vault/ephemeral)
 *   session_before_compact/tree    summarizer input scrubbing
 *   user_bash                      `!` command gate (warn / strict block)
 *   before_provider_request        payload rewrite fallback + audit proof
 *
 * Landing modes: plain (default) and ephemeral; the `vault` landing belongs to
 * @aiti-ai/pi-secret-vault. Same-session coexistence with the vault package is
 * resolved by an events handshake (vault wins, mask self-disables).
 */

import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Registry,
  RulesSource,
  auditPayload,
  guardReason,
  legacyPersistExists,
  redactDeep,
  redactDeepInPlace,
  redactMessageDeep,
  redactMessages,
  redactOnDisk,
  redactSystemMessages,
  redactTextSpans,
  restoreDeepInPlace,
  unmountedInValue,
  MASK_LANDING_MODES,
  type CustomRule,
  type SecretState,
} from "./commands.ts";
import { appendAuditLog, handleSecretCommand } from "./commands.ts";
import { AUDIT_LOG_PATH, PERSIST_PATH, RULES_PATH } from "./mask.ts";

const SECTION_KEY = "secret_masking";
const SELF = "mask";
const PEER = "vault";
const HELLO_EVENT = "aiti-secret:hello";

const SECTION_TEXT = [
  "Some credentials in this conversation are replaced by opaque tokens like rsec_a1b2c3d4.",
  "Each token IS a working credential: the runtime substitutes the real secret when the token appears",
  "verbatim in tool arguments (bash/edit/write/MCP). Copy the token exactly. Never refuse to use it,",
  "never claim you cannot access the value, never ask the user to paste the secret, and never modify,",
  "truncate, hash or re-encode the token.",
].join("\n");

interface ExtensionState extends SecretState {
  sessionId: string;
  peerSeen: boolean;
  legacyNotified: boolean;
  peerNoticeShown: boolean;
  /** Established on session_start so the handshake can surface a notice. */
  notice?: (text: string, level?: "info" | "warning" | "error") => void;
}

function active(state: ExtensionState): boolean {
  return state.enabled && !state.disabledBy;
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
    landing: "plain",
    landingModes: MASK_LANDING_MODES,
    guard: true,
    strict: false,
    rulesPath: RULES_PATH,
    rules: [],
    sessionId: "",
    peerSeen: false,
    legacyNotified: false,
    peerNoticeShown: false,
  };
  state.registry.salt = state.salt;
  const rules = new RulesSource(RULES_PATH, state.cwd);

  const reloadRules = (): void => {
    state.rules = rules.reload();
    state.rulesError = rules.errors.length ? rules.errors.join("; ") : undefined;
  };
  const currentRules = (): CustomRule[] => {
    state.rules = rules.rules();
    state.rulesError = rules.errors.length ? rules.errors.join("; ") : undefined;
    return state.rules;
  };

  // --- cross-extension handshake (vault is the superset; mask yields) ------
  pi.events.on(HELLO_EVENT, (data: unknown) => {
    const msg = data as { ext?: string; active?: boolean } | null;
    if (!msg || msg.ext !== PEER) return;
    state.peerSeen = true;
    if (state.disabledBy) return;
    state.disabledBy = "pi-secret-vault";
    try {
      state.notice?.("pi-secret-vault detected (functional superset) — pi-secret-mask is disabled for this session.", "warning");
    } catch {
      // notification is best-effort; the handshake itself must not fail
    }
    pi.events.emit(HELLO_EVENT, { ext: SELF, active: false });
  });

  pi.on("session_start", (_event, ctx) => {
    state.salt = randomBytes(4).toString("hex");
    state.registry.salt = state.salt;
    state.cwd = ctx.cwd || process.cwd();
    state.notice = (text, level) => {
      try {
        ctx.ui.notify(text, level ?? "info");
      } catch {}
    };
    rules.setScope(state.cwd);
    reloadRules();
    try {
      state.sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    } catch {
      state.sessionId = "";
    }
    if (state.disabledBy && !state.peerNoticeShown) {
      state.peerNoticeShown = true;
      state.notice?.("pi-secret-vault detected (functional superset) — pi-secret-mask is disabled for this session.", "warning");
    }
    if (!state.legacyNotified && legacyPersistExists(PERSIST_PATH)) {
      state.legacyNotified = true;
      try {
        ctx.ui.notify(
          "pi-secret-mask: implicit persistence is retired — use /secret load <file> to restore an old snapshot, or /vault add for the encrypted library.",
          "info",
        );
      } catch {}
    }
    pi.events.emit(HELLO_EVENT, { ext: SELF, active: active(state) });
  });

  // Input boundary: in vault/ephemeral landing the user's own message must be
  // redacted BEFORE it becomes a session entry (message_end alone fires after
  // the raw prompt would already be persisted).
  pi.on("input", (event) => {
    if (!active(state) || !redactOnDisk(state.landing)) return { action: "continue" as const };
    if ((event as { source?: string }).source === "extension") return { action: "continue" as const };
    const rules = currentRules();
    let text = event.text ?? "";
    const res = redactTextSpans([{ get: () => text, set: (t) => { text = t; } }], state.registry, state.salt, {
      autoDetect: true,
      rules,
    });
    return res.changed ? { action: "transform" as const, text } : { action: "continue" as const };
  });

  // Send-boundary redaction. The event carries a deep copy: edits here never
  // reach the session transcript, only the provider payload.
  pi.on("context", (event) => {
    if (!active(state)) return undefined;
    const res = redactMessages(event.messages as unknown[], state.registry, state.salt, { rules: currentRules() });
    return res.changed ? { messages: event.messages } : undefined;
  });

  // System prompt / AGENTS.md values ride the system segment, which the
  // `context` hook does not expose. Redact system messages only here (the
  // conversation part was already handled above).
  pi.on("context_with_system", (event) => {
    if (!active(state)) return undefined;
    const rules = currentRules();
    if (state.registry.size === 0 && rules.length === 0) return undefined;
    const res = redactSystemMessages(event.messages as unknown[], state.registry, { rules });
    return res.changed ? { messages: event.messages } : undefined;
  });

  // Tell the model what the tokens mean (idempotent keyed section).
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (!sections) return undefined;
    if (active(state) && state.registry.size > 0) sections[SECTION_KEY] = SECTION_TEXT;
    else if (SECTION_KEY in sections) delete sections[SECTION_KEY];
    return undefined;
  });

  // Guard unresolved placeholders, then restore real values right before the
  // tool executes (any tool, any argument position).
  pi.on("tool_call", (event) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    if (state.guard) {
      const missing = unmountedInValue(event.input, state.registry);
      if (missing.length > 0) return { block: true, reason: guardReason(missing, { landing: state.landing }) };
    }
    restoreDeepInPlace(event.input, state.registry);
    return undefined;
  });

  // Keep registered values out of tool output that is about to enter the
  // context (and the session record). Also scrubs details/structured data.
  pi.on("tool_result", (event) => {
    if (!active(state) || state.registry.size === 0) return undefined;
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

  // Landing policy: in vault/ephemeral modes the persisted message is the
  // redacted copy (role preserved); plain keeps today's behaviour.
  pi.on("message_end", (event) => {
    if (!active(state) || !redactOnDisk(state.landing)) return undefined;
    const rules = currentRules();
    if (state.registry.size === 0 && rules.length === 0) return undefined;
    const res = redactMessageDeep(event.message, state.registry, { rules });
    return res.count > 0 ? { message: res.message } : undefined;
  });

  // Compaction summarizer / branch tree summarizer must never see raw values.
  pi.on("session_before_compact", (event) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    redactDeepInPlace(event.preparation as unknown, state.registry);
    return undefined;
  });

  pi.on("session_before_tree", (event) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    redactDeepInPlace((event as { preparation?: unknown }).preparation, state.registry);
    return undefined;
  });

  // `!` commands: values typed there are the user's own command. Warn by
  // default, fail closed in strict mode (the command would otherwise be
  // persisted verbatim).
  pi.on("user_bash", (event, ctx) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    const hits = state.registry.redact(event.command).count;
    if (hits === 0) return undefined;
    if (state.strict) {
      try {
        ctx.ui.notify("secret-mask (strict): `!` command contains a registered secret — blocked.", "error");
      } catch {}
      return {
        result: {
          output: "secret-mask (strict): the command contains a registered secret value; use a tool call with the placeholder instead.",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    try {
      ctx.ui.notify("secret-mask: this `!` command contains a registered secret; it will be stored in the session file (use /secret strict on to block).", "warning");
    } catch {}
    return undefined;
  });

  // Safety net + proof layer: rewrite any raw value that survived every other
  // hook, then audit the FINAL payload. Zero cost when nothing is registered.
  pi.on("before_provider_request", (event, ctx) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    const rewritten = redactDeepInPlace(event.payload, state.registry);
    if (state.audit) {
      const a = auditPayload(event.payload, state.registry);
      const result = {
        time: new Date().toISOString(),
        sessionId: state.sessionId || ctx.sessionManager?.getSessionId?.() || "",
        strings: a.strings,
        placeholders: a.placeholders,
        leaks: a.leaks,
        leakedLabels: a.leakedLabels,
      };
      state.lastAudit = `${a.leaks} leak(s), ${a.placeholders} placeholder(s)`;
      appendAuditLog(result, state.auditPath);
      if (a.leaks > 0) {
        try {
          ctx.ui.notify(
            `secret-mask LEAK: ${a.leaks} registered value(s) found in the outgoing payload (${a.leakedLabels.join(", ")}) — check /secret audit show`,
            "error",
          );
        } catch {}
      }
    }
    return rewritten > 0 ? event.payload : undefined;
  });

  pi.registerCommand("secret", {
    description:
      "Secrets: add/list/remove, on/off, landing plain|ephemeral, guard, strict, rules, save|load <file>, audit, status",
    handler: async (args: string, ctx: ExtensionContext) => {
      const outcome = await handleSecretCommand(state, args ?? "", {
        input: (title: string) => ctx.ui.input(title, "Value never reaches the model"),
        reloadRules,
      });
      ctx.ui.notify(outcome.text, outcome.ok ? "info" : "warning");
    },
  });
}
