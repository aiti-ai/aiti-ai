/**
 * external-cli-governance — governance mode for external CLI providers (shared source,
 * copied into each extension directory for deployment).
 *
 * Origin: transcription of the pi-subagents 0.58 external runner's governance mode (MIT),
 * adapted to this repo's provider slots.
 * Authority: pi-web-ext/_shared/external-cli-governance.ts (sync the per-extension copies after changes).
 * Current copies: aiti-{claude-code,codex,pi,acp,zcode}-agent/external-governance.ts
 *
 * Four pieces of governance:
 *   1. env allowlist (governanceEnv) — spawn only forwards allowlisted env vars; other
 *      parent-process secrets (per-provider API keys / auth tokens) no longer leak into the child CLI process.
 *   2. preflight (preflightCli) — probe binary presence + version before launch (TTL-cached);
 *      a fail-loud message replaces a runtime spawn ENOENT.
 *   3. capability-narrowing copy table (CAPABILITY_NOTICE pattern) — unsupported capabilities carry
 *      a human-readable reason (a copy layer on top of our provider-slot capabilities booleans;
 *      wired up when a guard consumer lands).
 *   4. read/write split (READONLY_TOOL_ARGS pattern) — read-only variants declared explicitly
 *      (-writer suffix reverse convention: read-only by default, only the writer variant opens up writes).
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// 1) env allowlist
// ---------------------------------------------------------------------------

/** Base allowlist common to all external CLIs (system identity + proxy + TLS). */
export const BASE_ENV_ALLOW = [
	"PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
	"LANG", "LC_ALL", "TERM",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
	"http_proxy", "https_proxy", "no_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

/** Per-CLI keys (aligned with the pi-subagents claude-code adapter + common providers in this repo). */
export const CLI_ENV_ALLOW: Record<string, string[]> = {
	"claude-code": [
		"CLAUDE_CONFIG_DIR",
		"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
		"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY",
		"AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION",
		"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
		"GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID",
	],
	"codex": [
		"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME", "CODEX_API_KEY",
		// Custom provider auth (~/.codex/config.toml model_providers.*.env_key),
		// e.g. the openrouter bridge provider — without it the turn fails outright (turn.failed, Missing environment variable).
		"OPENROUTER_API_KEY",
	],
	"pi": [
		// pi itself and its provider auth go through the agent directory (models.json/auth.json);
		// env vars keep only runtime keys and common provider prefixes (avoid breaking custom providers).
		"PI_CODING_AGENT_DIR", "PI_WEB_PKG_DIR",
		"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
		"ZAI_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY",
		"QWEN_API_KEY", "DASHSCOPE_API_KEY", "OPENROUTER_API_KEY",
		"SILICONFLOW_API_KEY", "XAI_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
	],
	"acp": [
		"ACP_*",
	],
	"zcode": [
		// Official env injection channel (research: docs/zcode-desktop-cli-agent-analysis.md §5.1/§8.6):
		// model/endpoint/key all via env, ~/.zcode/cli/config.json stays unwritten;
		// UA/fingerprint/tool definitions are built by the official CLI itself, the extension only drives the protocol layer.
		"ZCODE_MODEL", "ZCODE_BASE_URL", "ZCODE_API_KEY", "ZCODE_APP_VERSION", "ZCODE_ENV",
		"ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_HTTP_PROXY", "ZCODE_NO_PROXY",
	],
	"codebuddy": [
		// Official env direct-read channel (iam.md precedence CODEBUDDY_AUTH_TOKEN > apiKeyHelper > CODEBUDDY_API_KEY;
		// third-party models = CODEBUDDY_API_KEY + CODEBUDDY_BASE_URL pointing at an OpenAI-compatible endpoint).
		"CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_BASE_URL",
		"CODEBUDDY_IS_SANDBOX", "CODEBUDDY_CONFIG_DIR",
		// aiti bridge direct connection (shim self-negotiated endpoint; when the service process carries this env, cbc sessions get the aiti_* tools)
		"AITI_BRIDGE_URL",
	],
};

/**
 * Build a governed child-process env: allowlisted keys (exact + `prefix*` wildcards) + extra overrides.
 * Replaces the full passthrough of `env: { ...process.env }`.
 */
export function governanceEnv(cli: keyof typeof CLI_ENV_ALLOW | string, extra?: Record<string, string>): Record<string, string> {
	const allow = [...BASE_ENV_ALLOW, ...(CLI_ENV_ALLOW[cli as string] ?? [])];
	const out: Record<string, string> = {};
	for (const k of Object.keys(process.env)) {
		const hit = allow.some((a) => (a.endsWith("*") ? k.startsWith(a.slice(0, -1)) : k === a));
		if (hit && process.env[k] !== undefined) out[k] = process.env[k] as string;
	}
	return { ...out, ...(extra ?? {}) };
}

// ---------------------------------------------------------------------------
// 2) preflight
// ---------------------------------------------------------------------------

const preflightCache = new Map<string, { at: number; version: string | null; ok: boolean }>();

/**
 * Pre-launch probe: binary executable + optional version (`--version`). TTL-cached; a failure caches
 * nothing beyond the negative result.
 * Returns { ok, version, error } — when ok=false, error is the human-readable failure reason (fail-loud).
 */
export function preflightCli(bin: string, opts: { versionArgs?: string[]; timeoutMs?: number; ttlMs?: number } = {}): Promise<{ ok: boolean; version: string | null; error?: string }> {
	const ttl = opts.ttlMs ?? 60_000;
	const cached = preflightCache.get(bin);
	if (cached && Date.now() - cached.at < ttl) {
		return Promise.resolve(cached.ok
			? { ok: true, version: cached.version }
			: { ok: false, version: null, error: cached.version ?? `${bin} 探测失败` });
	}
	return new Promise((resolve) => {
		execFile(bin, opts.versionArgs ?? ["--version"], { timeout: opts.timeoutMs ?? 5_000 }, (err, stdout) => {
			if (err) {
				const msg = String((err as NodeJS.ErrnoException).code) === "ENOENT"
					? `${bin} 未安装或不在 PATH`
					: `${bin} 探测失败: ${err.message.split("\n")[0]}`;
				preflightCache.set(bin, { at: Date.now(), version: msg, ok: false });
				resolve({ ok: false, version: null, error: msg });
				return;
			}
			const version = String(stdout).trim().split("\n")[0]?.slice(0, 64) ?? null;
			preflightCache.set(bin, { at: Date.now(), version, ok: true });
			resolve({ ok: true, version });
		});
	});
}

// ---------------------------------------------------------------------------
// 3) capability-narrowing copy table (pattern example — providers declare as needed; wired when a guard consumer lands)
// ---------------------------------------------------------------------------

/** Human-readable reasons for unsupported capabilities (instead of a bare false; declared alongside provider capabilities). */
export interface CapabilityNotices {
	[capability: string]: string;
}

/** Common narrowing reasons for one-shot stdin-style external CLIs (aligned with the pi-subagents external-cli-contract). */
export const ONESHOT_CLI_NOTICES: CapabilityNotices = {
	steer: "one-shot stdin 模式在启动后关闭输入，无法接受运行中导向消息。",
	fork: "外部 CLI 会话无原生 fork 语义（无 pi session 树）。",
	compact: "外部 CLI 不暴露上下文压缩接口。",
	setActiveTools: "外部 CLI 的工具白名单只能启动时声明，不能运行中切换。",
};

// ---------------------------------------------------------------------------
// 4) read/write split
// ---------------------------------------------------------------------------

/** CLI args of the read-only variant (writer-variant reverse convention: read-only by default, only the writer opens writes). */
export const READONLY_TOOL_ARGS: Record<string, string[]> = {
	"claude-code": ["--allowedTools", "Read,Glob,Grep"],
};
