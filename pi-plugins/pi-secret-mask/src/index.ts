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
  registerExtractedSecrets,
  registerMessageToolSecrets,
  registerValueSecrets,
  restoreDeepInPlace,
  sensitiveReadTargets,
  unmountedInValue,
  inspectToolTargets,
  fnv1a,
  MASK_LANDING_MODES,
  type CustomRule,
  type SecretState,
  type WeakCandidate,
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
  "Never present a token to the user as if it were the secret value: it only resolves inside tool",
  "arguments, so a user cannot type it into a login prompt. When the user asks what the value is, say",
  "it is masked and point to where the real one lives (the value they supplied, or the secret vault).",
].join("\n");

interface ExtensionState extends SecretState {
  sessionId: string;
  peerSeen: boolean;
  legacyNotified: boolean;
  peerNoticeShown: boolean;
  weakNotified: Set<string>;
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
    weakNotified: new Set(),
    extract: true,
    filePolicy: "learn",
    weakMode: "notify",
    lastToolOutput: "",
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
      state.notice?.("pi-secret-vault is active (functional superset) — pi-secret-mask is disabled for this session.", "info");
    } catch {
      // notification is best-effort; the handshake itself must not fail
    }
    pi.events.emit(HELLO_EVENT, { ext: SELF, active: false });
  });

  const notifyWeak = (ctx: { ui: { notify: (text: string, level?: string) => void } }, candidate: WeakCandidate): void => {
    if (state.weakMode !== "notify") return;
    const hash = fnv1a(candidate.value);
    if (state.weakNotified.has(hash)) return;
    state.weakNotified.add(hash);
    try {
      const text = candidate.registered
        ? "secret-mask: detected a known weak password — masked automatically; consider changing it (value hidden)."
        : "secret-mask: detected a possible weak password in your message — /secret add to register it (the value is hidden; /secret weak auto to auto-register).";
      (ctx.ui.notify as (text: string, level?: "info" | "warning" | "error") => void)(text, "warning");
    } catch {
      // notification is best effort
    }
  };
  const weakOptions = (ctx: { ui: { notify: (text: string, level?: string) => void } }) =>
    state.weakMode === "off" ? undefined : { auto: state.weakMode === "auto", onCandidate: (c: WeakCandidate) => notifyWeak(ctx, c) };

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
      state.notice?.("pi-secret-vault is active (functional superset) — pi-secret-mask is disabled for this session.", "info");
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
  // the raw prompt would already be persisted). In plain landing the text is
  // kept verbatim but detection still runs here, because the placeholder
  // contract (before_agent_start) is composed BEFORE the context hook — a value
  // first seen at send time would reach the model's first turn unexplained.
  pi.on("input", (event, ctx) => {
    if (!active(state)) return { action: "continue" as const };
    if ((event as { source?: string }).source === "extension") return { action: "continue" as const };
    const rules = currentRules();
    let text = event.text ?? "";
    const res = redactTextSpans([{ get: () => text, set: (t) => { text = t; } }], state.registry, state.salt, {
      autoDetect: true,
      rules,
      weak: weakOptions(ctx),
    });
    if (!redactOnDisk(state.landing) || !res.changed) return { action: "continue" as const };
    return { action: "transform" as const, text };
  });

  // Send-boundary redaction. The event carries a deep copy: edits here never
  // reach the session transcript, only the provider payload.
  pi.on("context", (event, ctx) => {
    if (!active(state)) return undefined;
    const res = redactMessages(event.messages as unknown[], state.registry, state.salt, {
      rules: currentRules(),
      weak: weakOptions(ctx),
    });
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

  // Tell the model what the tokens mean (idempotent keyed section). The key is
  // shared with the vault, so a mask that yielded to it must leave the section
  // alone — hook order puts the vault first, and deleting here would wipe the
  // contract it just wrote.
  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions?.sections as Record<string, string> | undefined;
    if (!sections) return undefined;
    if (active(state)) {
      if (state.registry.size > 0) sections[SECTION_KEY] = SECTION_TEXT;
      else if (SECTION_KEY in sections) delete sections[SECTION_KEY];
    } else if (!state.disabledBy && SECTION_KEY in sections) {
      delete sections[SECTION_KEY];
    }
    return undefined;
  });

  // Guard unresolved placeholders, then restore real values right before the
  // tool executes (any tool, any argument position).
  pi.on("tool_call", (event) => {
    if (!active(state)) return undefined;
    const toolName = String((event as { toolName?: string }).toolName ?? "");
    const input = (event as { input?: unknown }).input;
    if (state.extract !== false) {
      const targets = inspectToolTargets(toolName, input);
      for (const content of targets.contents) registerExtractedSecrets(content, state.registry, state.salt);
      const sensitive = sensitiveReadTargets(toolName, input);
      if (state.filePolicy === "block" && sensitive.length > 0) {
        const list = sensitive.map((x) => x.path).slice(0, 3).join(", ");
        return {
          block: true,
          reason: `secret-mask: reading sensitive file(s) is blocked by policy (/secret files learn|off to allow): ${list}`,
        };
      }
    }
    if (state.registry.size === 0) return undefined;
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
    if (!active(state)) return undefined;
    const eventAny0 = event as { toolName?: string; input?: unknown; details?: unknown; structuredContent?: unknown };
    const textParts = Array.isArray(event.content)
      ? event.content.filter((p): p is { type: "text"; text: string } => {
          const part = p as { type?: string; text?: string };
          return part?.type === "text" && typeof part.text === "string";
        })
      : [];
    const joined = textParts.map((p) => p.text).join("\n");
    if (joined) state.lastToolOutput = joined.slice(0, 65_536);
    let withheld: string | undefined;
    if (state.extract !== false) {
      let extracted = 0;
      // Extract from the REDACTED text: registered values (incl. encoded
      // variants) are placeholders by now, so detect cannot re-register an
      // encoded form of a mounted secret as a new entry. Unregistered fresh
      // values pass through redact unchanged and are still found.
      const scanText = joined ? state.registry.redact(joined).text : joined;
      if (scanText) extracted += registerExtractedSecrets(scanText, state.registry, state.salt).count;
      if (eventAny0.details !== undefined && eventAny0.details !== null) {
        extracted += registerValueSecrets(redactDeep(eventAny0.details, state.registry).value, state.registry, state.salt).count;
      }
      if (eventAny0.structuredContent !== undefined && eventAny0.structuredContent !== null) {
        extracted += registerValueSecrets(redactDeep(eventAny0.structuredContent, state.registry).value, state.registry, state.salt).count;
      }
      const sensitive = sensitiveReadTargets(eventAny0.toolName ?? "", eventAny0.input);
      const dedicated = sensitive.find((x) => x.info.dedicated);
      const trimmed = joined.trim();
      if (
        state.filePolicy === "learn" &&
        dedicated &&
        extracted === 0 &&
        trimmed.length >= 6 &&
        trimmed.length <= 8192
      ) {
        const label = (dedicated.path.split(/[/\\]/).pop() ?? "FILE").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "FILE";
        state.registry.registerAuto(trimmed, "file:secret", label, state.salt);
        withheld = `[secret-mask: sensitive file content withheld (${trimmed.length} bytes). The value is registered in this session — use its placeholder in tool arguments, or /secret list to see the alias.]`;
      } else if (state.filePolicy === "block" && sensitive.length > 0) {
        withheld = "[secret-mask: sensitive file content withheld by policy (/secret files learn|off to allow).]";
      }
      if (withheld) {
        const images = Array.isArray(event.content)
          ? event.content.filter((p) => (p as { type?: string }).type !== "text")
          : [];
        const detailsRedacted =
          eventAny0.details !== undefined && eventAny0.details !== null ? redactDeep(eventAny0.details, state.registry).value : undefined;
        const structuredRedacted =
          eventAny0.structuredContent !== undefined && eventAny0.structuredContent !== null
            ? redactDeep(eventAny0.structuredContent, state.registry).value
            : undefined;
        return {
          content: [{ type: "text", text: withheld }, ...images],
          ...(detailsRedacted !== undefined ? { details: detailsRedacted } : {}),
          ...(structuredRedacted !== undefined ? { structuredContent: structuredRedacted } : {}),
        } as never;
      }
    }
    if (state.registry.size === 0) return undefined;
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
    if (!active(state)) return undefined;
    if (state.extract !== false && (event.message as { role?: string } | null)?.role === "assistant") {
      registerMessageToolSecrets(event.message, state.registry, state.salt);
    }
    if (!redactOnDisk(state.landing)) return undefined;
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
