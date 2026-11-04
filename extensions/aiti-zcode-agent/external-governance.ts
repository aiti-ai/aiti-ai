/**
 * external-cli-governance —— 外部 CLI provider 的治理模式（共享源，复制到各扩展目录部署）
 *
 * 来源：pi-subagents 0.58 外部 runner 的治理模式抄写（MIT），适配本仓库 provider 槽。
 * 权威源：pi-web-ext/_shared/external-cli-governance.ts（改动后同步到各扩展副本）。
 * 当前副本：aiti-{claude-code,codex,pi,acp,zcode}-agent/external-governance.ts
 *
 * 四件治理：
 *   1. env allowlist（governanceEnv）——spawn 只透传白名单环境变量，父进程的
 *      其他密钥（各家 API key/auth token）不再泄入子 CLI 进程。
 *   2. preflight（preflightCli）——启动前探测二进制存在 + 版本（带 TTL 缓存），
 *      fail-loud 提示替代运行时 spawn ENOENT。
 *   3. 能力收窄文案表（CAPABILITY_NOTICE 模式）——不支持的能力带人话理由
 *      （我们 provider 槽 capabilities 布尔位之上的文案层，guard 消费后续接）。
 *   4. 读写分型（READONLY_TOOL_ARGS 模式）——只读变体显式声明（-writer 后缀
 *      反向约定：默认只读，writer 才放开写）。
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// 1) env allowlist
// ---------------------------------------------------------------------------

/** 所有外部 CLI 通用的基础白名单（系统定位 + 代理 + TLS）。 */
export const BASE_ENV_ALLOW = [
	"PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP",
	"LANG", "LC_ALL", "TERM",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
	"http_proxy", "https_proxy", "no_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

/** 各 CLI 专属键（与 pi-subagents claude-code adapter 对齐 + 本仓库常用 provider）。 */
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
		// 自定义 provider 认证（~/.codex/config.toml 的 model_providers.*.env_key），
		// 如 openrouter 桥接 provider——缺了它轮次直接 turn.failed（Missing environment variable）。
		"OPENROUTER_API_KEY",
	],
	"pi": [
		// pi 自身及其 provider 认证走 agent 目录（models.json/auth.json），
		// 环境变量只留运行时与常见 provider 前缀（防误伤自定义 provider）。
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
		// 官方 env 注入通道（调研 docs/zcode-desktop-cli-agent-analysis.md §5.1/§8.6）：
		// 模型/端点/key 全走 env，不写 ~/.zcode/cli/config.json；
		// UA/指纹/工具定义全由官方 CLI 本体构造，扩展只做协议层驱动。
		"ZCODE_MODEL", "ZCODE_BASE_URL", "ZCODE_API_KEY", "ZCODE_APP_VERSION", "ZCODE_ENV",
		"ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_HTTP_PROXY", "ZCODE_NO_PROXY",
	],
};

/**
 * 生成治理后的子进程 env：白名单键（精确 + `前缀*` 通配）+ extra 覆盖。
 * 替代 `env: { ...process.env }` 的全量透传。
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
 * 启动前探测：二进制可执行 + 可选版本（`--version`）。TTL 缓存，失败不缓存负面结果以外的信息。
 * 返回 { ok, version, error }——ok=false 时 error 是给人看的失败原因（fail-loud）。
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
// 3) 能力收窄文案表（模式示例——provider 按需声明，guard 消费后续接）
// ---------------------------------------------------------------------------

/** 不支持能力的人话理由（替代裸 false；provider 的 capabilities 旁路声明）。 */
export interface CapabilityNotices {
	[capability: string]: string;
}

/** one-shot stdin 型外部 CLI 的通用收窄理由（pi-subagents external-cli-contract 对齐）。 */
export const ONESHOT_CLI_NOTICES: CapabilityNotices = {
	steer: "one-shot stdin 模式在启动后关闭输入，无法接受运行中导向消息。",
	fork: "外部 CLI 会话无原生 fork 语义（无 pi session 树）。",
	compact: "外部 CLI 不暴露上下文压缩接口。",
	setActiveTools: "外部 CLI 的工具白名单只能启动时声明，不能运行中切换。",
};

// ---------------------------------------------------------------------------
// 4) 读写分型
// ---------------------------------------------------------------------------

/** 只读变体的 CLI 参数（writer 变体反向约定：默认只读，writer 才放开写）。 */
export const READONLY_TOOL_ARGS: Record<string, string[]> = {
	"claude-code": ["--allowedTools", "Read,Glob,Grep"],
};
