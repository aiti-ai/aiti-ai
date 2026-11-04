/**
 * agent-spawn-env —— 可 spawn 外部 CLI 的 agent 扩展共享 spawn env 机制
 *
 * 权威源：pi-web-ext/_shared/agent-spawn-env.ts（改动后同步到各扩展目录副本）。
 * 当前副本：aiti-{zcode,claude-code,codex,pi,acp,codebuddy,cursor,qoder}-agent/agent-spawn-env.ts
 * 方案：docs/pi-web-ext-agent-spawn-env-plan.md（2026-09-12）
 *
 * 两件事：
 *   1. 全自动 AITI_BRIDGE_URL——按 pi-web 自身实例推导（systemd 注入 PORT / PI_WEB_BASE_PATH），
 *      agent 子进程里的 aiti MCP shim（aiti-mcp-shim.cjs）继承后自协商端点，自动连
 *      「spawn 自己的这个实例」的桥——通知/交互直达 AI 窗所在实例，dev/prod 不再串线。
 *   2. extman `spawn.env`（type: textlist）环境变量列表——用户逐行配 KEY=VALUE，我们自行
 *      解析 $VAR / ${VAR} 引用（工作 env 里已有者优先，回退父进程 env），完全不依赖目标机器
 *      shell 的变量展开（Windows cmd/PowerShell 均无 $ 语法），三平台同一套写法。
 *
 * 行语法（两处列表通用）：
 *   KEY=VALUE   设置（VALUE 支持 $VAR / ${VAR} 引用；未定义 → 空串 + warning）
 *   -KEY        从最终 env 移除 KEY（急救口：治理/全量透传漏进来的坏变量，用户配一行即拔掉；
 *               扩展注册侧同样可用，排除未设置的变量是幂等无害操作）
 *   # ... / 空行  注释与空白
 *
 * 合并顺序（后行覆盖前行；移除后可再被后续行重新设置）：
 *   治理白名单透传（有则）/ processEnv 全量 → 自动 AITI_BRIDGE_URL → extra
 *   → 扩展注册侧默认列表（registerSpawnEnvDefaults，含排除项）→ 用户 extman spawn.env（最高优先）。
 *
 * launch 解析（P0 共享层，docs/aiti-custom-agent-plan.md §3.3；2026-09-13）：
 *   resolveCliLaunch —— 统一 command/argsPrefix/成员 env/bridge 重写（$VAR/${cwd} 展开）；
 *   parseCustomAgents —— agents.json 内部格式校验（aiti-custom-agent UI 读写）；
 *   spawn.command / spawn.argsPrefix extman feature（spawnCommandFeature/spawnArgsPrefixFeature）。
 */

/** extman feature 源（ctx.features，startup 捕获；DI 方案 P1 同款，缺省走 __piWebExt 兜底） */
type FeaturesLike = { get(extId: string, fid: string): boolean | string | undefined };

let capturedFeatures: FeaturesLike | null = null;

/** startup 时捕获 ctx.features（可传 null 清除，热重载/测试用） */
export function captureSpawnEnvFeatures(f: FeaturesLike | null): void {
	capturedFeatures = f;
}

/** 扩展注册侧默认列表（agentSpawnEnv 时按 extId 取用；与用户列表按序合并，用户在后可覆盖） */
const registeredDefaults = new Map<string, string>();

/** 扩展在 startup/注册时声明自己的默认环境变量列表（含 -NAME 排除项；后注册覆盖前注册） */
export function registerSpawnEnvDefaults(extId: string, list: string): void {
	registeredDefaults.set(extId, String(list ?? ""));
}

/** pi-web 自身实例基地址（同进程推导；127.0.0.1 直连不走 nginx/Authelia）。
 *  dev=3001 + /dev、prod=3002 + 空（48）；155/23 随各自服务单元的 PORT/PI_WEB_BASE_PATH。 */
export function piWebSelfBase(processEnv?: Record<string, string | undefined>): string {
	const env = processEnv ?? (process.env as Record<string, string | undefined>);
	const port = env.PORT || "3000";
	const basePath = (env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
	return `http://127.0.0.1:${port}${basePath}`;
}

/** 全自动注入项：aiti-devtools MCP 端点线索（带扩展路径签名，aiti-mcp-shim 识别后直连 <extBase>/mcp/mcp） */
export function bridgeEnv(processEnv?: Record<string, string | undefined>): Record<string, string> {
	return { AITI_BRIDGE_URL: `${piWebSelfBase(processEnv)}/api/extensions/aiti-devtools` };
}

// ---------------- 列表解析（纯语法层，无 shell 参与） ----------------

/** 单条操作：value=null 表示移除（-KEY），否则为设置（KEY=VALUE） */
export interface EnvLineOp {
	key: string;
	value: string | null;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** 解析列表文本为操作序列（非法行记 warning 跳过、不中断；重复 KEY 后行覆盖，移除行原样保留） */
export function parseEnvList(raw: string): { ops: EnvLineOp[]; warnings: string[] } {
	const ops: EnvLineOp[] = [];
	const warnings: string[] = [];
	for (const rawLine of String(raw || "").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		if (line.startsWith("-")) {
			const key = line.slice(1).trim();
			if (!KEY_RE.test(key)) {
				warnings.push(`跳过非法排除行（须 -NAME）：${line.slice(0, 80)}`);
				continue;
			}
			ops.push({ key, value: null });
			continue;
		}
		const eq = line.indexOf("=");
		if (eq <= 0) {
			warnings.push(`跳过非法行（须 KEY=VALUE 或 -NAME）：${line.slice(0, 80)}`);
			continue;
		}
		const key = line.slice(0, eq).trim();
		if (!KEY_RE.test(key)) {
			warnings.push(`跳过非法变量名：${key.slice(0, 80)}`);
			continue;
		}
		ops.push({ key, value: line.slice(eq + 1).trim() });
	}
	return { ops, warnings };
}

/**
 * 把操作序列应用到工作 env 上（原地修改并返回；无 shell 参与）：
 *   - 设置行：VALUE 中 $NAME / ${NAME} 先查工作 env（含治理透传/自动注入/前面行），
 *     再查 base（父进程 env）；两处皆无 → 空串 + warning（不保留字面量，避免半解析值进子进程）；
 *   - 移除行：delete，幂等（排除未设置的变量无害）；不做引号剥离 / %VAR% / 命令替换。
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
			onWarning?.(`${op.key}: 引用的 $${name} 未定义（工作 env 与父进程均无），按空串处理`);
			return "";
		});
	}
	return env;
}

/** 便捷口：解析 + 应用到空白 env（独立解析场景用；spawn 链路走 agentSpawnEnv） */
export function resolveEnvList(
	raw: string,
	base?: Record<string, string | undefined>,
): { env: Record<string, string>; warnings: string[] } {
	const { ops, warnings } = parseEnvList(raw);
	const env: Record<string, string> = {};
	applyEnvList(ops, env, { base, onWarning: (w) => warnings.push(w) });
	return { env, warnings };
}

/** 读 extman string/textlist feature 原文（ctx.features 优先，__piWebExt 直调兜底；非字符串一律按空串） */
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

/** 读 extman spawn.env 列表原文（缺省 ""） */
export function spawnEnvList(extId: string): string {
	return readStringFeature(extId, "spawn.env");
}

/** 读 extman spawn.command（启动命令覆盖；缺省 ""= 用驱动默认 CLI） */
export function spawnCommand(extId: string): string {
	return readStringFeature(extId, "spawn.command");
}

/** 读 extman spawn.argsPrefix（参数前缀列表原文，每行一个参数；缺省 ""） */
export function spawnArgsPrefix(extId: string): string {
	return readStringFeature(extId, "spawn.argsPrefix");
}

/**
 * spawn env 统一构造。
 *   - cli + governance：走治理白名单（external-governance.ts 的 governanceEnv）为基底，
 *     自动 bridgeEnv 进 extra（白名单外仍注入）；
 *   - 无 governance（cursor/qoder 等全量透传派）：processEnv 基底 + bridgeEnv + extra；
 *   - 再按序叠加：扩展注册侧默认列表（registerSpawnEnvDefaults）→ 用户 extman spawn.env
 *     （可覆盖/可 -NAME 排除一切，含自动注入项——逃生口）。
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

/** extman feature 声明（各 agent 扩展 features 数组统一追加；type: textlist 见方案文档机制 B） */
export function spawnEnvFeature(group?: string): {
	id: string; type: "textlist"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.env",
		...(group ? { group } : {}),
		type: "textlist",
		label: "spawn 环境变量",
		description:
			"每行一条，启动 agent 子进程时注入（我们自行解析，不依赖 shell，Windows 同样可用）：" +
			"KEY=VALUE 设置（支持 $VAR / ${VAR} 引用：先取当前生效值，再回退父进程环境变量；未定义按空串）；" +
			"-NAME 移除该变量（急救口：透传漏进来的坏变量配一行即拔掉）；# 注释与空行忽略。" +
			"此处可覆盖自动注入的 AITI_BRIDGE_URL，也可 -AITI_BRIDGE_URL 整个去掉。改完下一轮 spawn 生效。",
		value: "",
		placeholder: "FOO=bar\nBAR=$FOO\n-UNWANTED_VAR\n# 注释行与空行忽略",
	};
}

/** extman feature 声明：spawn.command（启动命令覆盖；P1' 启动包装，方案 docs/aiti-custom-agent-plan.md §3.5） */
export function spawnCommandFeature(group?: string): {
	id: string; type: "string"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.command",
		...(group ? { group } : {}),
		type: "string",
		label: "spawn 命令覆盖",
		description:
			"留空 = 使用本扩展默认 CLI。填入后以它替换默认 CLI 启动（docker 化包装：这里填 docker，" +
			"再配「spawn 参数前缀」拼 run --rm -i … 镜像 CLI）。支持 $VAR / ${cwd} 引用（spawn 时展开）。改完下一轮 spawn 生效。" +
			"注意：命令可执行任意本机程序，配置者须为本机管理员（与 spawn.env 同级信任）。",
		value: "",
		placeholder: "docker",
	};
}

/** extman feature 声明：spawn.argsPrefix（参数前缀；textlist 每行一个参数，拼在驱动内置参数之前） */
export function spawnArgsPrefixFeature(group?: string): {
	id: string; type: "textlist"; label: string; description: string; value: string; placeholder: string; group?: string;
} {
	return {
		id: "spawn.argsPrefix",
		...(group ? { group } : {}),
		type: "textlist",
		label: "spawn 参数前缀",
		description:
			"每行一个参数，拼在驱动内置参数之前（docker 化：run / --rm / -i / -v 挂载 / 镜像名 / 容器内 CLI 名）。" +
			"支持 $VAR / ${VAR} / ${cwd}（会话工作目录）引用，spawn 时展开；# 注释与空行忽略。改完下一轮 spawn 生效。" +
			"docker 配方要求 -v ${cwd}:${cwd} -w ${cwd} 同路径挂载，否则容器内路径与宿主历史不一致。",
		value: "",
		placeholder: "run\n--rm\n-i\n-v\n${cwd}:${cwd}\n-w\n${cwd}\nmy-image:latest\nclaude",
	};
}

// ---------------- launch 解析（P0：command / argsPrefix / 成员 env / bridge 重写） ----------------

/** 通用 $VAR / ${VAR} 展开：resolve(name) 命中 → 值；未命中 → 空串 + warning（不保留字面量）。
 *  与 applyEnvList 同一引用语法；${cwd} 由调用方注入 resolve 实现。 */
export function expandRefs(
	value: string,
	resolve: (name: string) => string | undefined,
	onWarning?: (msg: string) => void,
): string {
	return String(value ?? "").replace(REF_RE, (_m, braced: string, plain: string) => {
		const name = braced || plain;
		const hit = resolve(name);
		if (hit !== undefined) return hit;
		onWarning?.(`引用的 $${name} 未定义，按空串处理`);
		return "";
	});
}

/** 解析多行参数列表：每行一个参数；# 注释与空行忽略；行内容原样保留（$VAR/${cwd} 在 spawn 时展开） */
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

/** 启动包装覆盖（P2 协议委托：aiti-custom-agent 成员 → 基础扩展 `<extId>.launch` 服务）。
 *  各基础扩展 spawn 点的 resolveCliLaunch 以本覆盖优先于 extman spawn.command/spawn.argsPrefix；
 *  target 仅供多成员家族（如 acp）选成员，单成员扩展忽略。 */
export interface LaunchOverride {
	command?: string;
	argsPrefix?: string[];
	env?: Record<string, string>;
	bridge?: string;
	target?: string;
}

/** launch 解析输入（resolveCliLaunch） */
export interface CliLaunchInput {
	/** 驱动默认 CLI（成员 command 覆盖之） */
	defaultCommand: string;
	/** 启动命令覆盖（空串/缺省 → defaultCommand；覆盖时 argv 不再附带原 CLI 名） */
	command?: string;
	/** 参数前缀（逐项展开 $VAR/${VAR}/${cwd}） */
	argsPrefix?: string[];
	/** 驱动内置 argv（不含 CLI 名本身） */
	driverArgs?: string[];
	/** 预构建基底 env（协议扩展路径：agentSpawnEnv 产物）；缺省 = processEnv 全量透传（generic 路径） */
	env?: Record<string, string>;
	/** 成员级 env（最高优先；值展开 $VAR/${VAR}/${cwd}） */
	memberEnv?: Record<string, string>;
	/** 桥模式：inherit（缺省，保持现状）/ host.docker.internal（替换主机）/ off（移除）/ 显式 http(s):// URL */
	bridge?: string;
	processEnv?: Record<string, string | undefined>;
	/** ${cwd} 解析值；缺省 process.cwd() */
	cwd?: string;
	warn?: (msg: string) => void;
}

/** launch 解析产物：最终 spawn(command, args, { env }) 三元组 + 警告 */
export interface ResolvedLaunch {
	command: string;
	args: string[];
	env: Record<string, string>;
	warnings: string[];
	/**
	 * win32 且 command 以 .cmd/.bat 结尾时为 true（lessons §0.1：Node ≥18.20 直 spawn
	 * .cmd shim 即 EINVAL）——调用方 spawn opts 必须带 `shell: launch.shell`。
	 * 参数全部为旗标/路径（prompt 走 stdin），无 cmd 特殊字符面。
	 */
	shell?: boolean;
}

/**
 * 统一 launch 解析（P0 共享层，方案 docs/aiti-custom-agent-plan.md §3.3）。
 *   - command：成员覆盖 → defaultCommand；
 *   - env：显式 env 或 processEnv 全量透传为基底 → 自动 AITI_BRIDGE_URL（已有则保持）→
 *     成员 env（最高优先，逐项展开）→ bridge 重写（inherit/host.docker.internal/URL/off）；
 *   - args：[...argsPrefix(展开), ...driverArgs]——command 覆盖时由调用方保证 driverArgs 不含原 CLI 名。
 * 纯函数：不 spawn、不读文件（feature 读取在扩展侧完成后传入）。
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

	// env 基底：显式 env（协议扩展路径，agentSpawnEnv 产物）或全量透传（generic 路径）
	const env: Record<string, string> = input.env
		? { ...input.env }
		: { ...(processEnv as Record<string, string>) };
	// 自动桥线索：显式 env 未带时补注入（agentSpawnEnv 产物已带则原样保持）
	if (!Object.prototype.hasOwnProperty.call(env, "AITI_BRIDGE_URL")) {
		env.AITI_BRIDGE_URL = bridgeEnv(processEnv).AITI_BRIDGE_URL;
	}

	// 引用展开上下文：${cwd} 特殊名 → 工作 env → 父进程 env；皆无 → undefined（空串 + warning）
	const resolveRef = (name: string): string | undefined => {
		if (name === "cwd") return cwd;
		if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
		if (Object.prototype.hasOwnProperty.call(processEnv, name)) return processEnv[name] as string;
		return undefined;
	};

	// 成员 env（最高优先）
	for (const [k, v] of Object.entries(input.memberEnv ?? {})) {
		env[k] = expandRefs(v, resolveRef, (m) => onWarning(`env ${k}: ${m}`));
	}

	// bridge 重写（作用于最终 env 的 AITI_BRIDGE_URL）
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
					onWarning(`bridge=host.docker.internal：当前 AITI_BRIDGE_URL 非法（${cur}），保持不变`);
				}
			} else {
				onWarning("bridge=host.docker.internal：当前无 AITI_BRIDGE_URL，忽略");
			}
		} else if (/^https?:\/\//i.test(mode)) {
			env.AITI_BRIDGE_URL = expandRefs(mode, resolveRef, (m) => onWarning(`bridge: ${m}`));
		} else {
			onWarning(`bridge 模式无法识别（${mode}），按 inherit 处理`);
		}
	}

	// 参数前缀展开 + 拼装
	const prefix = (input.argsPrefix ?? []).map((a) => expandRefs(a, resolveRef, (m) => onWarning(`argsPrefix「${a}」: ${m}`)));
	let launchArgs: string[] = [...prefix, ...(input.driverArgs ?? [])];
	const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command.trim());
	if (shell) onWarning(`command 是 .cmd/.bat shim，spawn 需带 shell:true（调用方读取 launch.shell）`);

	// 脚本入口（.js/.cjs/.mjs）：CreateProcess 无法直跑（POSIX 依赖 shebang+chmod，Windows 必挂）
	// → 包装 process.execPath 直跑（lessons §0.1/§5「node 直跑入口」，三平台同构）。
	let launchCommand = command;
	if (/\.(cjs|mjs|js)$/i.test(command.trim())) {
		launchCommand = process.execPath;
		launchArgs = [command, ...launchArgs];
		onWarning(`command 是脚本入口，已包装 process.execPath 直跑`);
	}
	return { command: launchCommand, args: launchArgs, env, warnings, shell };
}

/** 自定义 agent 成员（agents.json 内部格式，UI 读写；parseCustomAgents 产物） */
export interface CustomAgentSpec {
	/** provider type（唯一；slug：[a-z0-9][a-z0-9_-]*，不含 / 和 .） */
	id: string;
	/** 选择器展示名 */
	label: string;
	/** 驱动类型：generic（通用命令 one-shot）或协议型（claude/codex/…——注册侧映射到
	 *  基础扩展 `<extId>.launch` 服务，服务缺席则该成员不注册） */
	driver: string;
	/** 启动命令（generic 必填；协议型空 = 用驱动默认 CLI） */
	command: string;
	/** 参数前缀（逐项展开 $VAR/${cwd}） */
	argsPrefix: string[];
	/** 成员级 env（最高优先） */
	env: Record<string, string>;
	/** 桥模式：""=inherit / host.docker.internal / off / http(s)://… */
	bridge: string;
	/** 委托目标成员（仅多成员家族协议型，如 acp 的 "claude-code"；空 = 服务端缺省成员） */
	target: string;
	/** 探活命令（缺省 = command） */
	probe: string;
	/** picker 位次（小者靠前；缺省 1000 与内置一致） */
	order: number;
	/** 启停（false=保留配置但不注册） */
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
 * 校验/规整 agents.json（内部格式，方案 §3.2）：非法条目按 warning 跳过、不整体失败；
 * id 去重（先到先得）、driver 白名单（P1 仅 generic）、env 兼容行式写法（KEY=VALUE / -NAME）。
 */
export function parseCustomAgents(raw: unknown): { agents: CustomAgentSpec[]; warnings: string[] } {
	const warnings: string[] = [];
	const agents: CustomAgentSpec[] = [];
	const obj = typeof raw === "string" ? safeJsonParse(raw) : raw;
	if (obj !== null && typeof obj === "object" && "__parseError" in (obj as Record<string, unknown>)) {
		warnings.push(`agents.json 不是合法 JSON（${(obj as Record<string, unknown>).__parseError}），按空配置处理`);
		return { agents, warnings };
	}
	const list = (obj as { agents?: unknown } | null | undefined)?.agents;
	if (list === undefined) return { agents, warnings };
	if (!Array.isArray(list)) {
		warnings.push("agents.json 的 agents 字段不是数组，按空配置处理");
		return { agents, warnings };
	}
	const seen = new Set<string>();
	list.forEach((item, i) => {
		const at = `agents[${i}]`;
		const it = (item ?? {}) as Record<string, unknown>;
		const id = String(it.id ?? "").trim();
		if (!CUSTOM_AGENT_ID_RE.test(id)) {
			warnings.push(`${at}: 非法 id「${id.slice(0, 40)}」（须 [a-z0-9][a-z0-9_-]*，不含 / .），跳过`);
			return;
		}
		if (seen.has(id)) {
			warnings.push(`${at}: id「${id}」重复，保留先到条目，跳过`);
			return;
		}
		const label = String(it.label ?? "").trim();
		if (!label) {
			warnings.push(`${at}(${id}): 缺显示名 label，跳过`);
			return;
		}
		const driver = String(it.driver ?? "generic").trim() || "generic";
		if (!/^[a-z][a-z0-9-]*$/i.test(driver)) {
			warnings.push(`${at}(${id}): 非法驱动类型「${driver.slice(0, 40)}」，跳过`);
			return;
		}
		const command = String(it.command ?? "").trim();
		if (driver === "generic" && !command) {
			warnings.push(`${at}(${id}): 缺启动命令 command，跳过`);
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
					warnings.push(`${at}(${id}): 非法环境变量名「${key.slice(0, 40)}」，忽略`);
					continue;
				}
				env[key] = String(v ?? "");
			}
		} else if (typeof it.env === "string" && it.env.trim()) {
			// 兼容行式写法（KEY=VALUE / -NAME 排除）
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
