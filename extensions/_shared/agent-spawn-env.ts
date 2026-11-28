/**
 * agent-spawn-env — shared spawn-env mechanism for agent extensions that spawn external CLIs
 *
 * Authoritative source: pi-web-ext/_shared/agent-spawn-env.ts (sync to each extension dir's copy after changes).
 * Deployed copies: aiti-{zcode,claude-code,codex,pi,acp,codebuddy,cursor,qoder}-agent/agent-spawn-env.ts
 * Plan: docs/pi-web-ext-agent-spawn-env-plan.md (2026-09-12)
 *
 * Two things:
 *   1. Fully automatic AITI_BRIDGE_URL — derived from the pi-web instance itself (systemd injects PORT / PI_WEB_BASE_PATH);
 *      the aiti MCP shim (aiti-mcp-shim.cjs) inside the agent subprocess inherits it and self-negotiates the endpoint, auto-connecting
 *      to the bridge of "the very instance that spawned it" — notifications/interactions reach the instance hosting the AI window; dev/prod no longer cross-wire.
 *   2. extman `spawn.env` (type: textlist) env-var list — the user configures KEY=VALUE line by line; we parse
 *      $VAR / ${VAR} references ourselves (working env first, falling back to the parent process env), with no dependence on the
 *      target machine's shell variable expansion (Windows cmd/PowerShell have no $ syntax); one syntax for all three platforms.
 *
 * Line syntax (shared by both lists):
 *   KEY=VALUE   set (VALUE supports $VAR / ${VAR} references; undefined → empty string + warning)
 *   -KEY        remove KEY from the final env (emergency escape: pull out a bad variable leaked in by governance/full passthrough with one line;
 *               also usable on the extension-registration side; excluding an unset variable is an idempotent no-op)
 *   # ... / blank line  comments and whitespace
 *
 * Merge order (later lines override earlier; a removed key can be re-set by later lines):
 *   governance whitelist passthrough (if present) / full processEnv → automatic AITI_BRIDGE_URL → extra
 *   → extension-registered default list (registerSpawnEnvDefaults, incl. exclusions) → user extman spawn.env (highest priority).
 *
 * Launch resolution (P0 shared layer, docs/aiti-custom-agent-plan.md §3.3; 2026-09-13):
 *   resolveCliLaunch — unified command/argsPrefix/member env/bridge rewrite ($VAR/${cwd} expansion);
 *   parseCustomAgents — validation of the agents.json internal format (read/written by the aiti-custom-agent UI);
 *   spawn.command / spawn.argsPrefix extman features (spawnCommandFeature/spawnArgsPrefixFeature).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** extman feature source (ctx.features, captured at startup; same DI approach as plan P1, with the __piWebExt fallback when absent) */
type FeaturesLike = { get(extId: string, fid: string): boolean | string | undefined };

let capturedFeatures: FeaturesLike | null = null;

/** Captures ctx.features at startup (pass null to clear; for hot reload/tests) */
export function captureSpawnEnvFeatures(f: FeaturesLike | null): void {
	capturedFeatures = f;
}

/** Extension-registered default list (looked up by extId in agentSpawnEnv; merged in order with the user list, user last so it wins) */
const registeredDefaults = new Map<string, string>();

/** The extension declares its own default env-var list at startup/registration (incl. -NAME exclusions; later registration overrides earlier) */
export function registerSpawnEnvDefaults(extId: string, list: string): void {
	registeredDefaults.set(extId, String(list ?? ""));
}

/** pi-web's own instance base URL (derived in-process; 127.0.0.1 connects directly, bypassing nginx/Authelia).
 *  dev=3001 + /dev, prod=3002 + empty (48); 155/23 follow their own service units' PORT/PI_WEB_BASE_PATH. */
export function piWebSelfBase(processEnv?: Record<string, string | undefined>): string {
	const env = processEnv ?? (process.env as Record<string, string | undefined>);
	const port = env.PORT || "3000";
	const basePath = (env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
	return `http://127.0.0.1:${port}${basePath}`;
}

/** Fully automatic injection: aiti-devtools MCP endpoint hint (carries the extension path signature; aiti-mcp-shim recognizes it and connects straight to <extBase>/mcp/mcp) */
export function bridgeEnv(processEnv?: Record<string, string | undefined>): Record<string, string> {
	return { AITI_BRIDGE_URL: `${piWebSelfBase(processEnv)}/api/extensions/aiti-devtools` };
}

// ---------------- List parsing (pure syntax layer, no shell involved) ----------------

/** Single operation: value=null means remove (-KEY), otherwise set (KEY=VALUE) */
export interface EnvLineOp {
	key: string;
	value: string | null;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Parses list text into an operation sequence (invalid lines are logged as warnings and skipped, never aborting; a repeated KEY is overridden by the later line; removal lines are kept as-is) */
export function parseEnvList(raw: string): { ops: EnvLineOp[]; warnings: string[] } {
	const ops: EnvLineOp[] = [];
	const warnings: string[] = [];
	for (const rawLine of String(raw || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("-")) {
			const key = line.slice(1).trim();
			if (!KEY_RE.test(key)) {
				warnings.push(`Skipping invalid exclusion line (must be -NAME): ${line.slice(0, 80)}`);
				continue;
			}
			ops.push({ key, value: null });
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			warnings.push(`Skipping invalid line (must be KEY=VALUE or -NAME): ${line.slice(0, 80)}`);
			continue;
		}
		const key = line.slice(0, eq).trim();
		if (!KEY_RE.test(key)) {
			warnings.push(`Skipping invalid variable name: ${key.slice(0, 80)}`);
			continue;
		}
		ops.push({ key, value: line.slice(eq + 1).trim() });
	}
	return { ops, warnings };
}

/**
 * Applies the operation sequence to the working env (in-place mutation and return; no shell involved):
 *   - Set lines: $NAME / ${NAME} in VALUE first look up the working env (governance passthrough / auto injection / earlier lines included),
 *     then base (parent process env); missing in both → empty string + warning (the literal is not kept, to avoid half-parsed values entering the subprocess);
 *   - Removal lines: delete, idempotent (excluding an unset variable is harmless); no quote stripping / %VAR% / command substitution.
 */
export function applyEnvList(
	ops: EnvLineOp[],
	env: Record<string, string>,
	opts?: { base?: Record<string, string | undefined>; onWarning?: (msg: string) => void },
): Record<string, string> {
	const base = opts?.base;
	const onWarning = opts?.onWarning;
	for (const op of ops) {
		if (op.value === null) {
			delete env[op.key];
			continue;
		}
		env[op.key] = op.value.replace(REF_RE, (_m, braced: string, plain: string) => {
			const name = braced || plain;
			if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
			if (base && Object.prototype.hasOwnProperty.call(base, name)) return base[name] as string;
			onWarning?.(`${op.key}: referenced $${name} is undefined (missing from both the working env and the parent process); treated as an empty string`);
			return "";
		});
	}
	return env;
}

/** Convenience entry: parse + apply to a blank env (for standalone parsing scenarios; the spawn chain goes through agentSpawnEnv) */
export function resolveEnvList(
	raw: string,
	base?: Record<string, string | undefined>,
): { env: Record<string, string>; warnings: string[] } {
	const { ops, warnings } = parseEnvList(raw);
	const env: Record<string, string> = {};
	applyEnvList(ops, env, { base, onWarning: (w) => warnings.push(w) });
	return { env, warnings };
}

/** Reads an extman string/textlist feature's raw text (ctx.features first, __piWebExt direct call as fallback; anything non-string is treated as "") */
function readStringFeature(extId: string, fid: string): string {
	const v = capturedFeatures?.get?.(extId, fid);
	if (typeof v === "string") return v;
	try {
		const reg = (globalThis as { __piWebExt?: { featureValue?: (extId: string, fid: string) => boolean | string } }).__piWebExt;
		const v2 = reg?.featureValue?.(extId, fid);
		if (typeof v2 === "string") return v2;
	} catch { /* ignore */ }
	return "";
}

/** Reads the extman spawn.env list raw text (default "") */
export function spawnEnvList(extId: string): string {
	return readStringFeature(extId, "spawn.env");
}

/** Reads extman spawn.command (launch command override; default "" = the driver's default CLI) */
export function spawnCommand(extId: string): string {
	return readStringFeature(extId, "spawn.command");
}

/** Reads extman spawn.argsPrefix (argument prefix list raw text, one argument per line; default "") */
export function spawnArgsPrefix(extId: string): string {
	return readStringFeature(extId, "spawn.argsPrefix");
}

// ---------------- UI environment session snapshot (aiti-ui-env) ----------------

/**
 * aiti-ui-env writes a snapshot of its mode-arbiter decision
 * (<dataRoot>/aiti-ui-env/cache/session-env.json: which target — Xvfb headless
 * display or the real desktop — is active, plus the env to reach it) whenever
 * the resolution changes. agentSpawnEnv merges the snapshot's display keys into
 * every spawned agent session, so a fresh session's bash tools and stdio MCP
 * servers land on the chosen display. This is the piece that makes the
 * extension panel's "display mode" actually take effect for sessions.
 *
 * Merge position: after `extra`, BEFORE the registered defaults and the user's
 * extman spawn.env list — the user can always override (DISPLAY=:0) or remove
 * (-DISPLAY) the injected keys.
 *
 * Per-extension opt-out via the extman feature `spawn.displayEnv`:
 *   "" / auto (default) → inject whenever a snapshot exists
 *   off                 → never inject
 *   headless / desktop  → inject only when the snapshot's target matches
 *
 * No snapshot (extension absent / display resolution never succeeded) → zero
 * behavior change, so defaulting to auto is safe.
 */

const UI_ENV_SNAPSHOT_KEYS = [
	"DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
	"XDG_SESSION_TYPE", "GDK_BACKEND", "WAYLAND_DISPLAY",
	"GTK_MODULES", "QT_ACCESSIBILITY", "NO_AT_BRIDGE",
	"UI_ENV_VNC_PORT", "UI_ENV_VNC_WEB_PORT",
] as const;

/** Extension data root (<webRoot>/data with the same dev/prod isolation as lib/ext/data-dir.ts) */
export function uiEnvDataRoot(processEnv: Record<string, string | undefined>): string {
	const explicit = processEnv.PI_WEB_DATA_DIR;
	if (explicit) return explicit;
	const root = processEnv.PI_WEB_DEV_DIST === "1" ? join(homedir(), ".pi", "web-dev", "data") : join(homedir(), ".pi", "web", "data");
	return root;
}

export interface UiEnvSnapshot { target: string; mode?: string; rationale?: string; env: Record<string, string>; updatedAt?: string; }

/** Read the aiti-ui-env session-env snapshot; null = absent/corrupt (never throws). */
export function readUiEnvSnapshot(processEnv?: Record<string, string | undefined>): UiEnvSnapshot | null {
	const env = processEnv ?? (process.env as Record<string, string | undefined>);
	try {
		const raw = readFileSync(join(uiEnvDataRoot(env), "aiti-ui-env", "cache", "session-env.json"), "utf8");
		const d = JSON.parse(raw) as UiEnvSnapshot;
		if ((d.target !== "headless" && d.target !== "desktop") || !d.env || typeof d.env !== "object") return null;
		const out: Record<string, string> = {};
		for (const k of UI_ENV_SNAPSHOT_KEYS) {
			const v = (d.env as Record<string, unknown>)[k];
			if (typeof v === "string") out[k] = v;
		}
		return { target: d.target, mode: d.mode, rationale: d.rationale, env: out, updatedAt: d.updatedAt };
	} catch { return null; }
}

/**
 * Unified spawn-env construction.
 *   - cli + governance: the governance whitelist (governanceEnv from external-governance.ts) as the base,
 *     automatic bridgeEnv merged into extra (injected even outside the whitelist);
 *   - no governance (the full-passthrough camp: cursor/qoder etc.): processEnv base + bridgeEnv + extra;
 *   - merged in order: aiti-ui-env display-env snapshot (spawn.displayEnv switch, default auto)
 *     → registered defaults (registerSpawnEnvDefaults) → user extman spawn.env
 *     (everything can be overridden or excluded with -NAME, including auto-injected items — the escape hatch).
 */
export function agentSpawnEnv(opts: {
	cli?: string;
	governance?: (cli: string, extra?: Record<string, string>) => Record<string, string>;
	extra?: Record<string, string>;
	extId?: string;
	envList?: string;
	processEnv?: Record<string, string | undefined>;
	warn?: (msg: string) => void;
}): Record<string, string> {
	const processEnv = opts.processEnv ?? (process.env as Record<string, string | undefined>);
	const bridge = bridgeEnv(processEnv);
	let out: Record<string, string>;
	if (opts.cli && opts.governance) {
		out = opts.governance(opts.cli, { ...bridge, ...opts.extra });
	} else {
		out = { ...(processEnv as Record<string, string>), ...bridge, ...opts.extra };
	}
	// aiti-ui-env display snapshot (per-extension spawn.displayEnv switch; default auto)
	const displayMode = String(readStringFeature(opts.extId ?? "", "spawn.displayEnv") || "auto").trim().toLowerCase();
	if (displayMode !== "off") {
		const snap = readUiEnvSnapshot(processEnv);
		if (snap && (displayMode === "" || displayMode === "auto" || displayMode === snap.target)) {
			for (const k of UI_ENV_SNAPSHOT_KEYS) {
				if (k in snap.env) out[k] = snap.env[k];
			}
		}
	}
	const onWarning = opts.warn ?? ((m: string) => console.warn(`[spawn.env] ${m}`));
	const warnings: string[] = [];
	const defaultsList = opts.extId ? registeredDefaults.get(opts.extId) || "" : "";
	const { ops, warnings: w1 } = parseEnvList(defaultsList);
	const { ops: userOps, warnings: w2 } = parseEnvList(opts.envList || "");
	warnings.push(...w1, ...w2);
	applyEnvList(ops, out, { base: processEnv, onWarning });
	applyEnvList(userOps, out, { base: processEnv, onWarning });
	return out;
}

/** extman feature declaration (appended uniformly to each agent extension's features array; for type: textlist see mechanism B in the plan doc) */
export function spawnEnvFeature(group?: string): {
	id: string; type: "textlist"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.env",
		...(group ? { group } : {}),
		type: "textlist",
		label: "Spawn environment variables",
		description:
			"One per line, injected when the agent subprocess is spawned (parsed by us, no shell dependency, works on Windows too): " +
			"KEY=VALUE sets (supports $VAR / ${VAR} references: the current effective value first, then the parent process env; undefined becomes an empty string); " +
			"-NAME removes that variable (emergency escape: one line pulls out a bad variable that leaked through passthrough); # comments and blank lines ignored. " +
			"Here you can override the auto-injected AITI_BRIDGE_URL, or remove it entirely with -AITI_BRIDGE_URL. Takes effect on the next spawn.",
		value: "",
		placeholder: "FOO=bar\nBAR=$FOO\n-UNWANTED_VAR\n# comment lines and blank lines are ignored",
	};
}

/** extman feature declaration: spawn.displayEnv (aiti-ui-env display snapshot injection switch) */
export function spawnDisplayEnvFeature(group?: string): {
	id: string; type: "string"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.displayEnv",
		...(group ? { group } : {}),
		type: "string",
		label: "Display env injection",
		description:
			"Injects the display environment (DISPLAY/XAUTHORITY/DBUS etc.) decided by aiti-ui-env's display-mode arbiter into the session processes spawned by this extension, " +
			"so GUI programs and MCP in new sessions land on the matching screen (the virtual screen is viewable in the browser over VNC). Values: empty or auto = follow the display mode (inject whenever a snapshot exists); " +
			"off = never inject; headless = inject only virtual-screen snapshots; desktop = inject only real-desktop snapshots. Takes effect on the next spawn; " +
			"a same-named variable in spawn.env can still override (e.g. DISPLAY=:0) or exclude with -DISPLAY.",
		value: "",
		placeholder: "auto",
	};
}

/** extman feature declaration: spawn.command (launch command override; P1' launch wrapper, plan docs/aiti-custom-agent-plan.md §3.5) */
export function spawnCommandFeature(group?: string): {
	id: string; type: "string"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.command",
		...(group ? { group } : {}),
		type: "string",
		label: "Spawn command override",
		description:
			"Empty = use this extension's default CLI. When set, it replaces the default CLI at launch (docker wrapper: put docker here, " +
			"then pair it with the \"spawn argument prefix\" to assemble run --rm -i … image CLI). Supports $VAR / ${cwd} references (expanded at spawn). Takes effect on the next spawn. " +
			"Note: the command can run any local program, so only the machine's administrator should configure it (same trust level as spawn.env).",
		value: "",
		placeholder: "docker",
	};
}

/** extman feature declaration: spawn.argsPrefix (argument prefix; textlist with one argument per line, prepended before the driver's built-in arguments) */
export function spawnArgsPrefixFeature(group?: string): {
	id: string; type: "textlist"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.argsPrefix",
		...(group ? { group } : {}),
		type: "textlist",
		label: "Spawn argument prefix",
		description:
			"One argument per line, prepended before the driver's built-in arguments (docker: run / --rm / -i / -v mounts / image name / CLI name inside the container). " +
			"Supports $VAR / ${VAR} / ${cwd} (session working directory) references, expanded at spawn; # comments and blank lines ignored. Takes effect on the next spawn. " +
			"The docker recipe requires -v ${cwd}:${cwd} -w ${cwd} mounting at the same path, otherwise in-container paths diverge from the host's history.",
		value: "",
		placeholder: "run\n--rm\n-i\n-v\n${cwd}:${cwd}\n-w\n${cwd}\nmy-image:latest\nclaude",
	};
}

// ---------------- Launch resolution (P0: command / argsPrefix / member env / bridge rewrite) ----------------

/** Generic $VAR / ${VAR} expansion: resolve(name) hit → value; miss → empty string + warning (the literal is not kept).
 *  Same reference syntax as applyEnvList; ${cwd} is provided by the caller's resolve implementation. */
export function expandRefs(
	value: string,
	resolve: (name: string) => string | undefined,
	onWarning?: (msg: string) => void,
): string {
	return String(value ?? "").replace(REF_RE, (_m, braced: string, plain: string) => {
		const name = braced || plain;
		const hit = resolve(name);
		if (hit !== undefined) return hit;
		onWarning?.(`Referenced $${name} is undefined; treated as an empty string`);
		return "";
	});
}

/** Parses a multi-line argument list: one argument per line; # comments and blank lines ignored; line content kept as-is ($VAR/${cwd} expanded at spawn) */
export function parseArgsLines(raw: string): { args: string[]; warnings: string[] } {
	const args: string[] = [];
	const warnings: string[] = [];
	for (const rawLine of String(raw || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		args.push(line);
	}
	return { args, warnings };
}

/** Launch wrapper override (P2 protocol delegation: aiti-custom-agent member → the base extension's `<extId>.launch` service).
 *  Each base extension's spawn-point resolveCliLaunch gives this override priority over extman spawn.command/spawn.argsPrefix;
 *  target is only for selecting a member in multi-member families (e.g. acp); single-member extensions ignore it. */
export interface LaunchOverride {
	command?: string;
	argsPrefix?: string[];
	env?: Record<string, string>;
	bridge?: string;
	target?: string;
}

/** Launch resolution input (resolveCliLaunch) */
export interface CliLaunchInput {
	/** Driver default CLI (the member command overrides it) */
	defaultCommand: string;
	/** Launch command override (empty/absent → defaultCommand; when overridden, argv no longer carries the original CLI name) */
	command?: string;
	/** Argument prefix ($VAR/${VAR}/${cwd} expanded item by item) */
	argsPrefix?: string[];
	/** Driver built-in argv (excluding the CLI name itself) */
	driverArgs?: string[];
	/** Pre-built base env (protocol-extension path: agentSpawnEnv output); default = full processEnv passthrough (generic path) */
	env?: Record<string, string>;
	/** Member-level env (highest priority; values expand $VAR/${VAR}/${cwd}) */
	memberEnv?: Record<string, string>;
	/** Bridge mode: inherit (default, keep as-is) / host.docker.internal (replace host) / off (remove) / explicit http(s):// URL */
	bridge?: string;
	processEnv?: Record<string, string | undefined>;
	/** ${cwd} resolution value; default process.cwd() */
	cwd?: string;
	warn?: (msg: string) => void;
}

/** Launch resolution output: the final spawn(command, args, { env }) triple + warnings */
export interface ResolvedLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
	warnings: string[];
	/**
	 * True when win32 and command ends with .cmd/.bat (lessons §0.1: spawning a
	 * .cmd shim directly on Node ≥18.20 fails with EINVAL) — the caller's spawn opts must pass `shell: launch.shell`.
	 * All arguments are flags/paths (the prompt goes over stdin), no cmd special-character surface.
	 */
	shell?: boolean;
}

/**
 * Unified launch resolution (P0 shared layer, plan docs/aiti-custom-agent-plan.md §3.3).
 *   - command: member override → defaultCommand;
 *   - env: explicit env or full processEnv passthrough as base → automatic AITI_BRIDGE_URL (kept if already present) →
 *     member env (highest priority, expanded item by item) → bridge rewrite (inherit/host.docker.internal/URL/off);
 *   - args: [...argsPrefix(expanded), ...driverArgs] — when command is overridden the caller guarantees driverArgs excludes the original CLI name.
 * Pure function: no spawn, no file reads (feature reads happen on the extension side and are passed in).
 */
export function resolveCliLaunch(input: CliLaunchInput): ResolvedLaunch {
	const processEnv = input.processEnv ?? (process.env as Record<string, string | undefined>);
	const warnings: string[] = [];
	const onWarning = (msg: string) => {
		warnings.push(msg);
		input.warn?.(msg);
	};
	const command = String(input.command ?? "").trim() || input.defaultCommand;
	const cwd = input.cwd ?? process.cwd();

	// env base: explicit env (protocol-extension path, agentSpawnEnv output) or full passthrough (generic path)
	const env: Record<string, string> = input.env
		? { ...input.env }
		: { ...(processEnv as Record<string, string>) };
	// auto bridge hint: injected only when the explicit env lacks it (kept as-is if the agentSpawnEnv output already has it)
	if (!Object.prototype.hasOwnProperty.call(env, "AITI_BRIDGE_URL")) {
		env.AITI_BRIDGE_URL = bridgeEnv(processEnv).AITI_BRIDGE_URL;
	}

	// reference expansion context: the ${cwd} special name → working env → parent process env; none → undefined (empty string + warning)
	const resolveRef = (name: string): string | undefined => {
		if (name === "cwd") return cwd;
		if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
		if (Object.prototype.hasOwnProperty.call(processEnv, name)) return processEnv[name] as string;
		return undefined;
	};

	// member env (highest priority)
	for (const [k, v] of Object.entries(input.memberEnv ?? {})) {
		env[k] = expandRefs(v, resolveRef, (m) => onWarning(`env ${k}: ${m}`));
	}

	// bridge rewrite (acts on the final env's AITI_BRIDGE_URL)
	const mode = String(input.bridge ?? "").trim() || "inherit";
	if (mode !== "inherit") {
		const cur = env.AITI_BRIDGE_URL;
		if (mode === "off") {
			delete env.AITI_BRIDGE_URL;
		} else if (mode === "host.docker.internal") {
			if (cur) {
				try {
					const u = new URL(cur);
					u.hostname = "host.docker.internal";
					env.AITI_BRIDGE_URL = u.toString();
				} catch {
					onWarning(`bridge=host.docker.internal: current AITI_BRIDGE_URL invalid (${cur}); left unchanged`);
				}
			} else {
				onWarning("bridge=host.docker.internal: no current AITI_BRIDGE_URL; ignored");
			}
		} else if (/^https?:\/\//i.test(mode)) {
			env.AITI_BRIDGE_URL = expandRefs(mode, resolveRef, (m) => onWarning(`bridge: ${m}`));
		} else {
			onWarning(`unrecognized bridge mode (${mode}); treated as inherit`);
		}
	}

	// argument prefix expansion + assembly
	const prefix = (input.argsPrefix ?? []).map((a) => expandRefs(a, resolveRef, (m) => onWarning(`argsPrefix "${a}": ${m}`)));
	let launchArgs: string[] = [...prefix, ...(input.driverArgs ?? [])];
	const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command.trim());
	if (shell) onWarning(`command is a .cmd/.bat shim; spawn needs shell:true (the caller reads launch.shell)`);

	// Script entry (.js/.cjs/.mjs): CreateProcess cannot run it directly (POSIX relies on shebang+chmod; Windows always fails)
	// → wrap to run via process.execPath (lessons §0.1/§5 "run the entry with node", identical on all three platforms).
	let launchCommand = command;
	if (/\.(cjs|mjs|js)$/i.test(command.trim())) {
		launchCommand = process.execPath;
		launchArgs = [command, ...launchArgs];
		onWarning(`command is a script entry; wrapped to run via process.execPath`);
	}
	return { command: launchCommand, args: launchArgs, env, warnings, shell };
}

/** Custom agent member (agents.json internal format, read/written by the UI; output of parseCustomAgents) */
export interface CustomAgentSpec {
	/** provider type (unique; slug: [a-z0-9][a-z0-9_-]*, no / or .) */
	id: string;
	/** Display name in the picker */
	label: string;
	/** Driver type: generic (general-purpose one-shot command) or protocol-backed (claude/codex/… — the registration side maps it to
	 *  the base extension's `<extId>.launch` service; if the service is absent the member is not registered) */
	driver: string;
	/** Launch command (required for generic; empty for protocol-backed = the driver's default CLI) */
	command: string;
	/** Argument prefix ($VAR/${cwd} expanded item by item) */
	argsPrefix: string[];
	/** Member-level env (highest priority) */
	env: Record<string, string>;
	/** Bridge mode: ""=inherit / host.docker.internal / off / http(s)://… */
	bridge: string;
	/** Delegation target member (only for multi-member protocol-backed families, e.g. acp's "claude-code"; empty = the server-side default member) */
	target: string;
	/** Liveness probe command (default = command) */
	probe: string;
	/** Picker position (lower comes first; default 1000, same as built-ins) */
	order: number;
	/** Enabled/disabled (false = keep the config but do not register) */
	enabled: boolean;
}

const CUSTOM_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch (e) {
		return { __parseError: String((e as Error)?.message || e) };
	}
}

/**
 * Validates/normalizes agents.json (internal format, plan §3.2): invalid entries are logged as warnings and skipped, never failing wholesale;
 * ids deduplicated (first wins), driver whitelist (P1 generic only), env accepts the line syntax (KEY=VALUE / -NAME).
 */
export function parseCustomAgents(raw: unknown): { agents: CustomAgentSpec[]; warnings: string[] } {
	const warnings: string[] = [];
	const agents: CustomAgentSpec[] = [];
	const obj = typeof raw === "string" ? safeJsonParse(raw) : raw;
	if (obj !== null && typeof obj === "object" && "__parseError" in (obj as Record<string, unknown>)) {
		warnings.push(`agents.json is not valid JSON (${(obj as Record<string, unknown>).__parseError}); treated as an empty config`);
		return { agents, warnings };
	}
	const list = (obj as { agents?: unknown } | null | undefined)?.agents;
	if (list === undefined) return { agents, warnings };
	if (!Array.isArray(list)) {
		warnings.push("the agents field of agents.json is not an array; treated as an empty config");
		return { agents, warnings };
	}
	const seen = new Set<string>();
	list.forEach((item, i) => {
		const at = `agents[${i}]`;
		const it = (item ?? {}) as Record<string, unknown>;
		const id = String(it.id ?? "").trim();
		if (!CUSTOM_AGENT_ID_RE.test(id)) {
			warnings.push(`${at}: invalid id "${id.slice(0, 40)}" (must be [a-z0-9][a-z0-9_-]*, no / or .), skipping`);
			return;
		}
		if (seen.has(id)) {
			warnings.push(`${at}: duplicate id "${id}", keeping the first entry and skipping`);
			return;
		}
		const label = String(it.label ?? "").trim();
		if (!label) {
			warnings.push(`${at}(${id}): missing display name label, skipping`);
			return;
		}
		const driver = String(it.driver ?? "generic").trim() || "generic";
		if (!/^[a-z][a-z0-9-]*$/i.test(driver)) {
			warnings.push(`${at}(${id}): invalid driver type "${driver.slice(0, 40)}", skipping`);
			return;
		}
		const command = String(it.command ?? "").trim();
		if (driver === "generic" && !command) {
			warnings.push(`${at}(${id}): missing launch command, skipping`);
			return;
		}
		const argsPrefix = Array.isArray(it.argsPrefix)
			? it.argsPrefix.map((a) => String(a))
			: typeof it.argsPrefix === "string" && it.argsPrefix.trim()
				? parseArgsLines(it.argsPrefix).args
				: [];
		const env: Record<string, string> = {};
		if (it.env && typeof it.env === "object" && !Array.isArray(it.env)) {
			for (const [k, v] of Object.entries(it.env as Record<string, unknown>)) {
				const key = String(k).trim();
				if (!KEY_RE.test(key)) {
					warnings.push(`${at}(${id}): invalid env var name "${key.slice(0, 40)}", ignored`);
					continue;
				}
				env[key] = String(v ?? "");
			}
		} else if (typeof it.env === "string" && it.env.trim()) {
			// compatible line-style env syntax (KEY=VALUE / -NAME exclusion)
			const { ops, warnings: w } = parseEnvList(it.env);
			warnings.push(...w.map((m) => `${at}(${id}): ${m}`));
			for (const op of ops) {
				if (op.value === null) delete env[op.key];
				else env[op.key] = op.value;
			}
		}
		const orderRaw = String(it.order ?? "").trim();
		const order = orderRaw !== "" && Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : 1000;
		seen.add(id);
		agents.push({
			id,
			label,
			driver,
			command,
			argsPrefix,
			env,
			bridge: String(it.bridge ?? "").trim(),
			target: String(it.target ?? "").trim(),
			probe: String(it.probe ?? "").trim(),
			order,
			enabled: it.enabled !== false,
		});
	});
	return { agents, warnings };
}

/**
 * English `ui.i18n.en` entries for the four spawn.* feature toggles above.
 *
 * The factory hands every agent backend the same manifest text, so each backend spreads this
 * table into its own en table instead of hand-copying four labels + four descriptions:
 *   `ui: { i18n: { en: { ...spawnFeatureI18nEn(), … } } }`
 */
export function spawnFeatureI18nEn(): Record<string, string> {
	return {
		"feat.spawn.env": "Spawn environment",
		"feat.spawn.env.desc":
			"One per line, injected when the agent subprocess is spawned (parsed by us, no shell dependency; works on Windows too): " +
			"KEY=VALUE sets (supports $VAR / ${VAR} references — the current effective value first, then the parent process env; undefined becomes empty); " +
			"-NAME removes that variable (emergency escape: one line drops a bad variable that leaked in); # and blank lines are ignored. " +
			"This can override the auto-injected AITI_BRIDGE_URL, or remove it entirely with -AITI_BRIDGE_URL. Takes effect on the next spawn.",
		"feat.spawn.displayEnv": "Display env injection",
		"feat.spawn.displayEnv.desc":
			"Injects the display environment decided by aiti-ui-env (DISPLAY/XAUTHORITY/DBUS etc.) into sessions spawned by this extension, " +
			"so GUI programs and MCP inside new sessions land on the matching screen (viewable in the browser over VNC). " +
			"Values: empty or auto = follow the display mode (inject when a snapshot exists); off = never; headless = virtual-screen snapshots only; desktop = real-desktop snapshots only. " +
			"Takes effect on the next spawn; same-named variables in spawn.env still override (e.g. DISPLAY=:0) or can be excluded with -DISPLAY.",
		"feat.spawn.command": "Spawn command override",
		"feat.spawn.command.desc":
			"Empty = use this extension's default CLI. When set, it replaces the default CLI command (docker wrapper: put docker here and use " +
			"\"spawn argument prefix\" for run --rm -i … image CLI). Supports $VAR / ${cwd} references (expanded at spawn). Takes effect on the next spawn. " +
			"Note: the command can run any local program, so only the machine owner should configure it (same trust level as spawn.env).",
		"feat.spawn.argsPrefix": "Spawn argument prefix",
		"feat.spawn.argsPrefix.desc":
			"One argument per line, prepended before the driver's built-in arguments (docker: run / --rm / -i / -v mount / image name / CLI inside the container). " +
			"Supports $VAR / ${VAR} / ${cwd} (session working directory) references, expanded at spawn; # and blank lines are ignored. Takes effect on the next spawn. " +
			"The docker recipe needs -v ${cwd}:${cwd} -w ${cwd} so in-container paths match the host history.",
	};
}
