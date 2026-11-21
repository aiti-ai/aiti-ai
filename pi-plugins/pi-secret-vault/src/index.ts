/**
 * pi-secret-vault — encrypted, persistent secrets with a placeholder surface.
 *
 * One-liner: `/vault add` stores a value in an AES-256-GCM library; the model
 * only ever sees `rsec_<hash8>` tokens from `vault_get` and passes them into
 * tool arguments, where the runtime substitutes the real value.
 *
 * Hooks (superset of @aiti-ai/pi-secret-mask — both share the same engine):
 *   context / context_with_system  send-boundary redaction (+ vault landing)
 *   before_agent_start             placeholder usage contract for the model
 *   tool_call                      unresolved-placeholder guard + restore
 *   tool_result                    reverse redaction of tool output
 *   message_end                    on-disk redaction (landing vault/ephemeral)
 *   session_before_compact/tree    summarizer input scrubbing
 *   user_bash                      `!` command gate (warn / strict block)
 *   before_provider_request        payload rewrite fallback + audit proof
 *   registerTool                   vault_list / vault_get (read-only)
 *   registerCommand                /vault (human writes) + /secret (session)
 *
 * Coexistence: an events handshake makes mask yield when the vault is present;
 * the vault only yields when it finds a legacy mask (no handshake support).
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Registry,
  RulesSource,
  auditPayload,
  guardReason,
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
  registerWeakCandidates,
  restoreDeepInPlace,
  sensitiveReadTargets,
  unmountedInValue,
  unmountedPlaceholders,
  inspectToolTargets,
  fnv1a,
  LANDING_MODES,
  type CustomRule,
  type SecretState,
  type WeakCandidate,
} from "@aiti-ai/secret-mask-core";
import { appendAuditLog, handleSecretCommand } from "@aiti-ai/secret-mask-core";
import { STABLE_NAMESPACE, stablePlaceholder } from "@aiti-ai/secret-mask-core";
import {
  VaultStore,
  handleVaultCommand,
  landValueInVault,
  mountAlias,
  vaultGet,
  vaultList,
  writeSessionRecord,
} from "@aiti-ai/secret-vault-core";
import {
  AUDIT_LOG_PATH,
  LEGACY_PERSIST_PATH,
  MASTER_KEY_PATH,
  RULES_PATH,
  SESSION_STATE_PATH,
  SETTINGS_PATH,
  VAULT_DIR,
} from "./paths.ts";

const SECTION_KEY = "secret_masking";
const SELF = "vault";
const PEER = "mask";
const HELLO_EVENT = "aiti-secret:hello";

const SECTION_TEXT = [
  "Some credentials in this conversation are replaced by opaque tokens like rsec_a1b2c3d4.",
  "Such a token IS a working credential: the runtime substitutes the real secret when the token appears",
  "verbatim in tool arguments (bash/edit/write/MCP). Copy the token exactly. Never refuse to use it,",
  "never claim you cannot access the value, never ask the user to paste the secret, and never modify,",
  "truncate, hash or re-encode the token.",
  "Never present a token to the user as if it were the secret value: it only resolves inside tool",
  "arguments, so a user cannot type it into a login prompt. When the user asks what the value is, say",
  "it is masked (vault_list / vault_get give you a token, never plaintext).",
  "The secret vault is human-writable only: use vault_list to discover aliases and vault_get to obtain a",
  "token. You cannot add, rotate, remove or reveal vault entries — ask the user to run the /vault command.",
].join("\n");

interface ExtensionState extends SecretState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  peerSeen: boolean;
  peerExpected: boolean;
  weakNotified: Set<string>;
  notice?: (text: string, level?: "info" | "warning" | "error") => void;
}

function active(state: ExtensionState): boolean {
  return state.enabled && !state.disabledBy;
}

function messageText(message: unknown): string {
  const m = message as { content?: unknown } | null;
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part) => {
        const p = part as { type?: string; text?: string } | null;
        return p?.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Explicit /name, else a redacted first-user-message excerpt (never raw values). */
function deriveSessionTitle(state: ExtensionState, ctx: { sessionManager?: any }, fallbackMessage?: unknown): string | undefined {
  const explicit = ctx.sessionManager?.getSessionName?.();
  if (explicit) return String(explicit).slice(0, 120);
  const candidates: string[] = [];
  const fromMessage = fallbackMessage ? messageText(fallbackMessage) : "";
  if (fromMessage) candidates.push(fromMessage);
  if (!fromMessage) {
    try {
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      for (const entry of entries) {
        if (entry?.type !== "message" || entry.message?.role !== "user") continue;
        const text = messageText(entry.message);
        if (text) {
          candidates.push(text);
          break;
        }
      }
    } catch {
      // history is best effort
    }
  }
  for (const text of candidates) {
    try {
      state.registry.autoRegister(text, state.salt);
      registerWeakCandidates(text, state.registry, state.salt, {});
      const red = state.registry.redact(text).text.replace(/\s+/g, " ").trim();
      if (red) return red.slice(0, 80);
    } catch {
      const red = text.replace(/\s+/g, " ").trim();
      if (red) return red.slice(0, 80);
    }
  }
  return undefined;
}

/** True when ~/.pi/agent/settings.json lists the given package. */
function settingsListPackage(name: string, path = SETTINGS_PATH): boolean {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown };
    const list = Array.isArray(doc.packages) ? doc.packages : [];
    return list.some((p) => {
      const text = typeof p === "string" ? p : p && typeof p === "object" ? JSON.stringify(p) : "";
      return text.includes(name);
    });
  } catch {
    return false;
  }
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const store = new VaultStore({ dir: VAULT_DIR, keyPath: MASTER_KEY_PATH, cwd: process.cwd() });
  const state: ExtensionState = {
    registry: new Registry(),
    enabled: true,
    salt: randomBytes(4).toString("hex"),
    cwd: process.cwd(),
    persisted: false,
    audit: false,
    persistPath: LEGACY_PERSIST_PATH,
    auditPath: AUDIT_LOG_PATH,
    landing: "vault",
    landingModes: LANDING_MODES,
    guard: true,
    strict: false,
    rulesPath: RULES_PATH,
    rules: [],
    sessionId: "",
    peerSeen: false,
    peerExpected: false,
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
  const toolState = (): { store: VaultStore; registry: Registry; sessionId: string; cwd: string } => ({
    store,
    registry: state.registry,
    sessionId: state.sessionId,
    cwd: state.cwd,
  });

  /**
   * The web pre-send gate masks with the *stable* vault placeholder
   * (`rsec_<fnv1a("vault:"+alias)>`) after the value is encrypted. This process
   * never saw that alias mount, so resolve unmounted tokens against the vault on
   * demand: the alias space is small and local, and the token is a pure function
   * of the alias. Fail-closed when the vault is locked — the guard then keeps the
   * literal token out of tool arguments.
   */
  const mountPreflightTokens = (text: string): number => {
    if (!text || !text.includes("rsec_")) return 0;
    let tokens: string[];
    try {
      tokens = unmountedPlaceholders(text, state.registry);
    } catch {
      return 0;
    }
    if (tokens.length === 0) return 0;
    let mounted = 0;
    try {
      for (const info of store.list()) {
        if (!tokens.includes(stablePlaceholder(STABLE_NAMESPACE, info.alias))) continue;
        try {
          mountAlias(toolState(), info.alias);
          mounted++;
        } catch {
          // locked / undecryptable: leave it unmounted (guard blocks its use)
        }
      }
    } catch {
      // vault unreadable: same fail-closed path
    }
    if (mounted > 0) persistSessionState();
    return mounted;
  };

  const persistSessionState = (): void => {
    try {
      writeSessionRecord(SESSION_STATE_PATH, state.sessionId || "unknown", {
        cwd: state.cwd,
        landing: state.landing,
        name: state.sessionName,
        file: state.sessionFile,
        mounted: state.registry.entries().filter((e) => e.source === "vault").map((e) => e.alias ?? e.label),
        pid: process.pid,
      });
    } catch {
      // state file is auxiliary; never break a hook because of it
    }
  };

  const notifyWeak = (candidate: WeakCandidate): void => {
    if (state.weakMode !== "notify") return;
    const hash = fnv1a(candidate.value);
    if (state.weakNotified.has(hash)) return;
    state.weakNotified.add(hash);
    state.notice?.(
      candidate.registered
        ? "secret-vault: detected a known weak password — masked automatically; consider rotating it to a stronger one (value hidden)."
        : "secret-vault: detected a possible weak password in your message — /secret add to register it (the value is hidden; /secret weak auto to auto-register).",
      "warning",
    );
  };
  const weakOptions = () =>
    state.weakMode === "off" ? undefined : { auto: state.weakMode === "auto", onCandidate: notifyWeak };

  // --- coexistence handshake (vault wins; legacy mask wins by fallback) ----
  pi.events.on(HELLO_EVENT, (data: unknown) => {
    const msg = data as { ext?: string; active?: boolean } | null;
    if (!msg || msg.ext !== PEER) return;
    state.peerSeen = true;
  });

  pi.on("session_start", (_event, ctx) => {
    state.salt = randomBytes(4).toString("hex");
    state.registry.salt = state.salt;
    state.cwd = ctx.cwd || process.cwd();
    state.sessionFile = ctx.sessionManager?.getSessionFile?.() ?? undefined;
    state.sessionName = deriveSessionTitle(state, ctx);
    store.updateCwd(state.cwd);
    rules.setScope(state.cwd);
    reloadRules();
    try {
      state.sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    } catch {
      state.sessionId = "";
    }
    state.notice = (text, level) => {
      try {
        ctx.ui.notify(text, level ?? "info");
      } catch {}
    };
    state.peerExpected = settingsListPackage("pi-secret-mask");
    // peerSeen is cumulative: a mask hello may arrive before this session_start.
    pi.events.emit(HELLO_EVENT, { ext: SELF, active: active(state) });
    if (state.peerExpected) {
      // One microtask turn: handshake handlers are synchronous. No reply means
      // a mask version without handshake support (<= 0.2.3), so the vault
      // yields and tells the user how to fix it.
      setImmediate(() => {
        if (state.peerSeen || state.disabledBy) return;
        state.disabledBy = "pi-secret-mask (legacy, no handshake)";
        state.notice?.(
          "pi-secret-vault: an old pi-secret-mask without handshake support is installed — the vault is disabled. Upgrade mask to >= 0.3.0 or uninstall one of the two.",
          "error",
        );
        pi.events.emit(HELLO_EVENT, { ext: SELF, active: false });
      });
    }
    persistSessionState();
  });

  const landOnDetect =
    state.landing === "vault"
      ? (entries: Array<{ value: string; label: string }>) => {
          for (const entry of entries) landValueInVault({ store, registry: state.registry }, entry.value, entry.label);
        }
      : undefined;

  // Input boundary: redact the user's own message before it becomes a session
  // entry (message_end would run after the raw prompt is already persisted).
  // Detection runs on every landing mode: vault/ephemeral must redact the text
  // before it is persisted, plain keeps the text but still mounts the value so
  // the placeholder contract (before_agent_start) covers the model's first turn
  // — the contract is composed before the context hook runs.
  pi.on("input", (event) => {
    if (!active(state)) return { action: "continue" as const };
    if ((event as { source?: string }).source === "extension") return { action: "continue" as const };
    mountPreflightTokens(event.text ?? "");
    const rules = currentRules();
    let text = event.text ?? "";
    const res = redactTextSpans([{ get: () => text, set: (t) => { text = t; } }], state.registry, state.salt, {
      autoDetect: true,
      rules,
      weak: weakOptions(),
      onDetected: state.landing === "vault" ? landOnDetect : undefined,
    });
    if (!redactOnDisk(state.landing) || !res.changed) return { action: "continue" as const };
    if (state.landing === "vault") persistSessionState();
    return { action: "transform" as const, text };
  });

  // The in-memory registry dies with the process; clear the mounted list so the
  // management UI only shows sessions that are actually holding aliases.
  pi.on("session_shutdown", () => {
    try {
      writeSessionRecord(SESSION_STATE_PATH, state.sessionId || "unknown", {
        cwd: state.cwd,
        landing: state.landing,
        name: state.sessionName,
        file: state.sessionFile,
        mounted: [],
        pid: process.pid,
      });
    } catch {
      // auxiliary state only
    }
  });

  pi.on("session_info_changed", (event: { name?: string }, _ctx) => {
    state.sessionName = event?.name ? String(event.name).slice(0, 120) : undefined;
    persistSessionState();
  });

  pi.on("context", (event) => {
    if (!active(state)) return undefined;
    mountPreflightTokens(JSON.stringify(event.messages ?? ""));
    const before = new Set(state.registry.entries().map((e) => e.placeholder));
    const res = redactMessages(event.messages as unknown[], state.registry, state.salt, {
      rules: currentRules(),
      weak: weakOptions(),
      onDetected:
        state.landing === "vault"
          ? (entries) => {
              for (const entry of entries) landValueInVault({ store, registry: state.registry }, entry.value, entry.label);
            }
          : undefined,
    });
    if (state.landing === "vault" && state.registry.entries().some((e) => !before.has(e.placeholder) && e.source === "vault")) {
      persistSessionState();
    }
    return res.changed ? { messages: event.messages } : undefined;
  });

  pi.on("context_with_system", (event) => {
    if (!active(state)) return undefined;
    const rules = currentRules();
    if (state.registry.size === 0 && rules.length === 0) return undefined;
    const res = redactSystemMessages(event.messages as unknown[], state.registry, { rules });
    return res.changed ? { messages: event.messages } : undefined;
  });

  // The section key is shared with the mask: a vault that yielded to a legacy
  // mask must not delete the contract the mask wrote.
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
          reason: `secret-vault: reading sensitive file(s) is blocked by policy (/secret files learn|off to allow): ${list}`,
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
    if (state.extract !== false) {
      let extracted = 0;
      if (joined) extracted += registerExtractedSecrets(joined, state.registry, state.salt).count;
      if (eventAny0.details !== undefined && eventAny0.details !== null) {
        extracted += registerValueSecrets(eventAny0.details, state.registry, state.salt).count;
      }
      if (eventAny0.structuredContent !== undefined && eventAny0.structuredContent !== null) {
        extracted += registerValueSecrets(eventAny0.structuredContent, state.registry, state.salt).count;
      }
      const sensitive = sensitiveReadTargets(eventAny0.toolName ?? "", eventAny0.input);
      const dedicated = sensitive.find((x) => x.info.dedicated);
      const trimmed = joined.trim();
      let withheld: string | undefined;
      if (state.filePolicy === "learn" && dedicated && extracted === 0 && trimmed.length >= 6 && trimmed.length <= 8192) {
        const label = (dedicated.path.split(/[/\\]/).pop() ?? "FILE").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "FILE";
        state.registry.registerAuto(trimmed, "file:secret", label, state.salt);
        withheld = `[secret-vault: sensitive file content withheld (${trimmed.length} bytes). The value is registered in this session — use its placeholder in tool arguments, or /secret list to see the alias.]`;
      } else if (state.filePolicy === "block" && sensitive.length > 0) {
        withheld = "[secret-vault: sensitive file content withheld by policy (/secret files learn|off to allow).]";
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

  pi.on("message_end", (event) => {
    if (!active(state)) return undefined;
    const msgRole = (event.message as { role?: string } | null)?.role;
    if (msgRole === "user" && !state.sessionName) {
      const title = deriveSessionTitle(state, { sessionManager: { getSessionName: () => undefined } }, event.message);
      if (title) {
        state.sessionName = title;
        persistSessionState();
      }
    }
    if (state.extract !== false && msgRole === "assistant") {
      registerMessageToolSecrets(event.message, state.registry, state.salt);
    }
    if (!redactOnDisk(state.landing)) return undefined;
    const rules = currentRules();
    if (state.registry.size === 0 && rules.length === 0) return undefined;
    const res = redactMessageDeep(event.message, state.registry, { rules });
    return res.count > 0 ? { message: res.message } : undefined;
  });

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

  pi.on("user_bash", (event, ctx) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    const hits = state.registry.redact(event.command).count;
    if (hits === 0) return undefined;
    if (state.strict) {
      try {
        ctx.ui.notify("secret-vault (strict): `!` command contains a mounted secret — blocked.", "error");
      } catch {}
      return {
        result: {
          output: "secret-vault (strict): the command contains a mounted secret value; use a tool call with the placeholder instead.",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    try {
      ctx.ui.notify("secret-vault: this `!` command contains a mounted secret; it will be stored in the session file (use /secret strict on to block).", "warning");
    } catch {}
    return undefined;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!active(state) || state.registry.size === 0) return undefined;
    const rewritten = redactDeepInPlace(event.payload, state.registry);
    if (state.audit) {
      const a = auditPayload(event.payload, state.registry);
      appendAuditLog(
        {
          time: new Date().toISOString(),
          sessionId: state.sessionId || ctx.sessionManager?.getSessionId?.() || "",
          strings: a.strings,
          placeholders: a.placeholders,
          leaks: a.leaks,
          leakedLabels: a.leakedLabels,
        },
        state.auditPath,
      );
      state.lastAudit = `${a.leaks} leak(s), ${a.placeholders} placeholder(s)`;
      if (a.leaks > 0) {
        try {
          ctx.ui.notify(
            `secret-vault LEAK: ${a.leaks} mounted value(s) found in the outgoing payload (${a.leakedLabels.join(", ")}) — /secret audit show`,
            "error",
          );
        } catch {}
      }
    }
    return rewritten > 0 ? event.payload : undefined;
  });

  // --- AI surface (read-only) ---------------------------------------------
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true }) as never;

  pi.registerTool({
    name: "vault_list",
    label: "Vault List",
    description:
      "List aliases in the user's encrypted secret vault (alias, description, tags, version, last use). Values are never returned. This tool is read-only; the vault can only be written by the human /vault command.",
    promptSnippet: "List secret vault aliases (vault_list) and obtain credentials as placeholders (vault_get)",
    promptGuidelines: [
      "Use vault_list when the user mentions a stored credential or asks which secrets are available.",
      "Use vault_get with an alias from vault_list to obtain a working placeholder; pass that placeholder verbatim into tool arguments.",
      "Never ask the user to paste a secret into the chat when vault_list contains a matching alias.",
    ],
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Optional tag filter (exact match)" },
      },
    },
    async execute(_toolCallId: unknown, params: { tag?: string }) {
      try {
        const res = vaultList(toolState(), params ?? {});
        return { content: res.content, details: res.details };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  });

  pi.registerTool({
    name: "vault_get",
    label: "Vault Get",
    description:
      "Mount a secret-vault alias in this session and receive its opaque placeholder token. The token works verbatim inside tool arguments (the runtime substitutes the real value at execution time). Also updates the last-used attribution fields.",
    promptSnippet: "Get a secret as a placeholder token (vault_get <alias>) and use the token inside tool arguments",
    promptGuidelines: [
      "Use vault_get with an alias from vault_list whenever a task needs a credential.",
      "Treat the returned token as a live credential: copy it exactly, never ask for the real value.",
    ],
    parameters: {
      type: "object",
      properties: {
        alias: { type: "string", description: "Alias from vault_list" },
      },
      required: ["alias"],
    },
    async execute(_toolCallId: unknown, params: { alias?: string }) {
      try {
        const res = vaultGet(toolState(), params ?? {});
        persistSessionState();
        return { content: res.content, details: res.details };
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // --- commands -----------------------------------------------------------
  pi.registerCommand("vault", {
    description:
      "Encrypted secret vault: add/set/capture/import/list/get/reveal/remove/forget/scope/mode/lock/unlock/status (values never enter the chat)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const outcome = await handleVaultCommand(toolState(), args ?? "", {
        input: (prompt: string) => ctx.ui.input(prompt, "Value never reaches the model"),
        confirm: (prompt: string) => ctx.ui.confirm("Secret vault", prompt),
        show: (title: string, value: string) => {
          try {
            // Dialog only (never the transcript): prefilled editor, result ignored.
            void ctx.ui.editor(title, value);
          } catch {}
        },
        copy: (value: string) => {
          try {
            void import("node:child_process").then((cp) => {
              const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard";
              const child = cp.spawn(cmd, { shell: true, stdio: ["pipe", "ignore", "ignore"] });
              child.stdin?.end(value);
            });
          } catch {}
        },
        notify: (text: string, level?: "info" | "warning" | "error") => {
          try {
            ctx.ui.notify(text, level ?? "info");
          } catch {}
        },
      });
      if (outcome.ok) persistSessionState();
      ctx.ui.notify(outcome.text, outcome.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("secret", {
    description:
      "Session secrets: add/list/remove, on/off, landing plain|vault|ephemeral, guard, strict, rules, save|load <file>, audit, status",
    handler: async (args: string, ctx: ExtensionContext) => {
      const outcome = await handleSecretCommand(state, args ?? "", {
        input: (title: string) => ctx.ui.input(title, "Value never reaches the model"),
        reloadRules,
      });
      ctx.ui.notify(outcome.text, outcome.ok ? "info" : "warning");
    },
  });
}
