/**
 * custom-agent-client —— 自定义 Agent 管理面板（零构建原生 h()，样板 aiti-agent-manager）。
 *
 * 列表（名称/驱动/命令/探活/启停/编辑/复制/删除/排序）+ 表单（label/id/driver/
 * command/probe/argsPrefix/env 表格/bridge/order）——用户全程不写 JSON（方案
 * docs/aiti-custom-agent-plan.md §3.2）。保存即热生效（服务端 registerAll），
 * 无轮询（打开时拉一次 + 操作后用响应内回带的全量列表刷新）。
 *
 * export default function register(ctx) { registerCustomAgentClient(ctx, { extId: "aiti-custom-agent" }); }
 */

const DRIVER_OPTIONS = [
	{ value: "generic", label: "通用命令（one-shot：任务文本走 stdin）" },
	{ value: "claude", label: "Claude Code（协议委托：完整模型/权限/历史）" },
	{ value: "codex", label: "Codex（协议委托）" },
	{ value: "zcode", label: "ZCode（协议委托）" },
	{ value: "cursor", label: "Cursor（协议委托）" },
	{ value: "qoder", label: "Qoder（协议委托）" },
	{ value: "acp", label: "ACP（协议委托）" },
	{ value: "codebuddy", label: "CodeBuddy（协议委托）" },
	{ value: "pi", label: "Pi（协议委托）" },
];
const BRIDGE_OPTIONS = [
	{ value: "", label: "继承（自动注入 AITI_BRIDGE_URL）" },
	{ value: "host.docker.internal", label: "host.docker.internal（容器内回连宿主）" },
	{ value: "__url__", label: "自定义 URL…" },
	{ value: "off", label: "关闭（不注入桥地址）" },
];

// ============================================================================
// 前缀命令包装（docker / ssh / env / proxychains）——纯函数层（可单测）
//
// 存储语义沿用既有模型：command = 实际 spawn 的可执行文件（开启包装后即包装
// 工具本身）+ argsPrefix = 其后的完整参数（包装参数 … 被包装的真实 CLI）。
// 勾选「启用前缀命令」后由结构字段生成这两项；取消勾选则用户自行填命令。
// ============================================================================

/** 包装类型 → 默认可执行文件与探活命令 */
export const PREFIX_TOOLS = {
	docker: { tool: "docker", probe: "docker version" },
	ssh: { tool: "ssh", probe: "ssh -V" },
	env: { tool: "env", probe: "env" },
	runsocks: { tool: "runsocks", probe: "runsocks" },
	custom: { tool: "", probe: "" }, // 工具名由用户填（sudo / nix-shell / podman / timeout …）
};

export const PREFIX_KINDS = [
	{ value: "docker", label: "docker（容器里跑 agent）" },
	{ value: "ssh", label: "ssh（远程主机上跑）" },
	{ value: "env", label: "env（临时注入环境变量）" },
	{ value: "runsocks", label: "runsocks / proxychains（走代理）" },
	{ value: "custom", label: "自定义前缀命令（sudo / nix-shell / podman / timeout …）" },
];

/** 前缀命令下拉选项：无 = 不包装，直接跑「命令」里填的可执行文件 */
export const PREFIX_CHOICES = [
	{ value: "", label: "无（直接运行「命令」填的可执行文件）" },
	...PREFIX_KINDS,
];

/** docker 常用前缀命令（用户选择即用；不到之处在下「附加参数」里补） */
export const DOCKER_MODES = [
	{ value: "run-i", label: "run --rm -i（一次性任务，stdin 直传）", args: ["run", "--rm", "-i"] },
	{ value: "run-it", label: "run --rm -it（交互式 TTY）", args: ["run", "--rm", "-it"] },
	{ value: "run-host", label: "run --rm -i --network host（共享宿主网络，容器内桥直连）", args: ["run", "--rm", "-i", "--network", "host"] },
	{ value: "compose-run", label: "compose run --rm（compose 服务）", args: ["compose", "run", "--rm"] },
	{ value: "exec-i", label: "exec -i（进入已运行容器）", args: ["exec", "-i"] },
];

/** docker 常用选项（追加进「附加参数」） */
export const DOCKER_EXTRAS = [
	{ value: "add-host", label: "＋ --add-host=host.docker.internal:host-gateway", args: ["--add-host=host.docker.internal:host-gateway"] },
	{ value: "host-network", label: "＋ --network host（共享宿主网络）", args: ["--network", "host"] },
	{ value: "mount-cwd", label: "＋ 同路径挂载工作目录 -v ${cwd}:${cwd} -w ${cwd}", args: ["-v", "${cwd}:${cwd}", "-w", "${cwd}"] },
	{ value: "mount-claude", label: "＋ 挂载宿主 Claude 配置 ~/.claude", args: ["-v", "${HOME}/.claude:${HOME}/.claude"] },
	{ value: "mount-codex", label: "＋ 挂载宿主 Codex 配置 ~/.codex", args: ["-v", "${HOME}/.codex:${HOME}/.codex"] },
];

export const SOCKS_TOOLS = [
	{ value: "runsocks", label: "runsocks（dante）" },
	{ value: "proxychains4", label: "proxychains4" },
	{ value: "proxychains", label: "proxychains" },
];

/** 协议型驱动默认 CLI 名（command 被包装命令顶替后，驱动不再自带 CLI 名——必须写进参数前缀尾部） */
export const DRIVER_DEFAULT_CLI = {
	claude: "claude", codex: "codex", zcode: "zcode", cursor: "cursor",
	qoder: "qoderclicn", codebuddy: "cbc", pi: "pi", acp: "ACP 成员 CLI",
};

/** 空的结构字段（按类型分桶；生成的 command/argsPrefix 由此推导） */
export function emptyPfx() {
	return {
		docker: { mode: "run-i", opts: "-v\n${cwd}:${cwd}\n-w\n${cwd}", image: "", cli: "" },
		ssh: { target: "", port: "", opts: "-t", cli: "" },
		env: { vars: "", cli: "" },
		runsocks: { tool: "runsocks", opts: "", cli: "" },
		custom: { tool: "", opts: "", cli: "" },
	};
}

/** 多行文本 → 参数行（去注释/空行/两端空白） */
export function linesOf(text) {
	return String(text ?? "").split(/\r?\n/).map((l) => String(l).trim()).filter((l) => l && !l.startsWith("#"));
}

/** 单行命令串 → 参数 token（空格分隔） */
export function tokensOf(text) {
	return String(text ?? "").trim().split(/\s+/).filter(Boolean);
}

/** 当前包装类型实际用的可执行文件（无 → ""；docker/ssh/env 固定；runsocks 可选工具） */
export function prefixToolOf(form) {
	if (!form.prefixKind) return "";
	if (form.prefixKind === "runsocks") return String(form.pfx?.runsocks?.tool ?? "").trim() || "runsocks";
	// custom：工具名用户自填（sudo / nix-shell / podman / timeout …）
	if (form.prefixKind === "custom") return tokensOf(form.pfx?.custom?.tool)[0] ?? "";
	return PREFIX_TOOLS[form.prefixKind]?.tool ?? "";
}

/** 结构字段 → argsPrefix 参数数组（= 生成参数前缀的唯一出处） */
export function buildPrefixArgs(form) {
	if (!form.prefixKind) return [];
	const p = form.pfx?.[form.prefixKind] ?? {};
	switch (form.prefixKind) {
		case "docker": {
			const mode = DOCKER_MODES.find((m) => m.value === p.mode) ?? DOCKER_MODES[0];
			return [...mode.args, ...linesOf(p.opts), ...tokensOf(p.image), ...tokensOf(p.cli)];
		}
		case "ssh": {
			const port = tokensOf(p.port);
			return [
				...linesOf(p.opts),
				...(port.length ? ["-p", port[0]] : []),
				...tokensOf(p.target),
				...tokensOf(p.cli),
			];
		}
		case "env":
			return [...linesOf(p.vars), ...tokensOf(p.cli)];
		// runsocks / custom：工具名是 command 本身（单个可执行文件，参数一律进附加参数）
		case "runsocks":
		case "custom":
			return [...linesOf(p.opts), ...tokensOf(p.cli)];
		default:
			return [];
	}
}

/** 自动探活值的集合（原先是自动填的 → 切类型时跟着换；用户手填的一律保留） */
const AUTO_PROBES = new Set([
	...Object.values(PREFIX_TOOLS).map((t) => t.probe),
	"docker", "ssh", "env", "runsocks", "proxychains", "proxychains4",
]);

/** 结构字段 → command/argsPrefix/probe 落回表单（切换类型/改字段后同步） */
export function applyPrefix(form) {
	const tool = prefixToolOf(form);
	// 无包装（下拉选「无」）：不动 command/参数前缀/探活，交回用户直填
	// （custom 例外：工具名还没填时保持选中态，command 留着给用户敲）
	if (!tool && form.prefixKind !== "custom") return { ...form, prefixKind: "", prefixEnabled: false };
	// 探活默认：类型固定值；runsocks/custom 用工具名本身（换工具时跟着换）
	const probeDefault = form.prefixKind === "runsocks" || form.prefixKind === "custom"
		? tool
		: (PREFIX_TOOLS[form.prefixKind]?.probe ?? "");
	const curProbe = String(form.probe ?? "").trim();
	// 只有当前值还是上一个工具的自动值（或空）时才改写；手填的一律保留
	const prevTool = String(form.command ?? "").trim();
	return {
		...form,
		prefixEnabled: true,
		command: tool || String(form.command ?? "").trim(),
		argsPrefixText: buildPrefixArgs(form).join("\n"),
		probe: (!curProbe || curProbe === prevTool || AUTO_PROBES.has(curProbe)) ? probeDefault : curProbe,
	};
}

/** 未开启包装时「命令 + 参数」整串 = 被包装的真实 CLI（开启时搬进 cli 字段，不丢配置） */
export function realCliText(command, argsPrefixText) {
	return [String(command ?? "").trim(), ...tokensOf(argsPrefixText)].filter(Boolean).join(" ");
}

/**
 * 开启/切换包装类型：
 *   - 真实 CLI 继承：已开启 → 上一类型的 cli 字段；未开启 → 当前「命令 + 参数」整串；
 *   - 目标类型的 cli 已有值时不覆盖（尊重用户手填）。
 */
export function switchPrefixKind(form, kind) {
	if (!kind) return { ...form, prefixKind: "", prefixEnabled: false };
	const pfx = { ...(form.pfx ?? emptyPfx()) };
	const prevCli = form.prefixEnabled
		? String(pfx[form.prefixKind]?.cli ?? "").trim()
		: realCliText(form.command, form.argsPrefixText);
	if (prevCli && !String(pfx[kind]?.cli ?? "").trim()) pfx[kind] = { ...pfx[kind], cli: prevCli };
	return applyPrefix({ ...form, prefixEnabled: true, prefixKind: kind, pfx });
}

// ---------------- 反向解析（读回已存成员 → 结构字段，尽量无损） ----------------

const DOCKER_VAL_FLAGS = new Set([
	"-v", "--volume", "-w", "--workdir", "-e", "--env", "--env-file", "--entrypoint", "-u", "--user",
	"-p", "--publish", "--name", "-l", "--label", "--network", "--add-host", "--dns", "--shm-size",
	"--memory", "--cpus", "--ipc", "--pid", "--security-opt", "--cap-add",
]);
const SSH_VAL_FLAGS = new Set(["-p", "-i", "-o", "-J", "-F", "-l", "-S", "-W", "-L", "-R", "-D"]);
const SOCKS_VAL_FLAGS = new Set(["-f", "-o"]);

/** ssh 参数 → { target, port, opts, cli } */
function splitSsh(args) {
	const opts = [];
	let port = "";
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		if (args[i] === "-p" && args[i + 1] !== undefined) {
			port = String(args[i + 1]);
			i += 2;
			continue;
		}
		opts.push(args[i]);
		if (SSH_VAL_FLAGS.has(args[i]) && args[i + 1] !== undefined && args[i + 1] !== "-p") opts.push(args[i + 1]);
		i += 1;
	}
	const target = args[i] && !args[i].startsWith("-") ? String(args[i]) : "";
	if (target) i += 1;
	return { target, port, opts: opts.join("\n"), cli: args.slice(i).join(" ") };
}

/** docker 参数 → { mode, opts, image, cli }（带值选项原样留在 opts，保序） */
function splitDocker(args) {
	const mode = [...DOCKER_MODES].sort((a, b) => b.args.length - a.args.length)
		.find((m) => m.args.every((a, j) => args[j] === a)) ?? DOCKER_MODES[0];
	const rest = args.slice(mode.args.length);
	const opts = [];
	let image = "";
	let k = 0;
	while (k < rest.length) {
		const tok = rest[k];
		if (DOCKER_VAL_FLAGS.has(tok)) {
			opts.push(tok, rest[k + 1] ?? "");
			k += 2;
			continue;
		}
		if (!tok.startsWith("-") && !image) {
			image = tok;
			k += 1;
			continue;
		}
		opts.push(tok);
		k += 1;
	}
	return { mode: mode.value, opts: opts.filter((x) => x !== "").join("\n"), image, cli: "" };
}

/** env / proxychains 参数 → { vars|opts, cli }（前缀 token 归包装，其后归真实 CLI） */
function splitLeadBy(pred, args) {
	const lead = [];
	let i = 0;
	while (i < args.length && pred(args[i])) {
		lead.push(args[i]);
		i += 1;
	}
	return { lead: lead.join("\n"), cli: args.slice(i).join(" ") };
}

/** 已存成员 → { prefixEnabled, prefixKind, pfx }（command 是包装工具才识别；其余按未启用处理） */
export function detectPrefix(m) {
	const pfx = emptyPfx();
	const command = String(m?.command ?? "").trim();
	const args = Array.isArray(m?.argsPrefix) ? m.argsPrefix.map(String) : [];
	if (SOCKS_TOOLS.some((t) => t.value === command) || command === "runsocks") {
		const { lead, cli } = splitLeadBy((t) => t.startsWith("-") || SOCKS_VAL_FLAGS.has(t), args);
		return { prefixEnabled: true, prefixKind: "runsocks", pfx: { ...pfx, runsocks: { tool: command, opts: lead, cli } } };
	}
	if (command === "docker" || command === "podman") {
		const d = splitDocker(args);
		return { prefixEnabled: true, prefixKind: "docker", pfx: { ...pfx, docker: { ...pfx.docker, ...d } } };
	}
	if (command === "ssh") {
		const s = splitSsh(args);
		return { prefixEnabled: true, prefixKind: "ssh", pfx: { ...pfx, ssh: { ...pfx.ssh, ...s } } };
	}
	if (command === "env") {
		const { lead, cli } = splitLeadBy((t) => t.includes("=") && !t.startsWith("-"), args);
		return { prefixEnabled: true, prefixKind: "env", pfx: { ...pfx, env: { vars: lead, cli } } };
	}
	return { prefixEnabled: false, prefixKind: "", pfx };
}

export function registerCustomAgentClient(ctx, config) {
	const h = (...a) => ctx.h(...a);
	const useState = (v) => ctx.useState(v);
	const useEffect = (fn, deps) => ctx.useEffect(fn, deps);
	const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/" + config.extId + p), { cache: "no-store", ...init });
	const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

	ctx.registerItems("toolbar", [{
		id: `${config.extId}-panel`,
		meta: {
			label: "自定义 Agent",
			title: "自定义 Agent：注册自定义后端（命令/参数前缀/env/桥模式）",
			icon: "icons/bot.svg",
			onClick: () => {
				if (!moduleSetOpen) return;
				moduleSetOpen((o) => !o);
				if (moduleSetView) moduleSetView({ mode: "list" });
			},
		},
	}]);
	ctx.registerItems("dialogs", [{
		id: `${config.extId}-panel-dialog`,
		render: () => h(CustomAgentPanel),
	}]);

	let moduleSetOpen = null;
	let moduleSetView = null;

	function emptyForm() {
		return { label: "", id: "", idTouched: false, driver: "generic", command: "", probe: "",
			argsPrefixText: "", envRows: [], bridge: "", bridgeUrl: "", order: "1000", enabled: true,
			prefixEnabled: false, prefixKind: "docker", pfx: emptyPfx() };
	}
	function formOf(m, copy = false) {
		const bridgeIsUrl = m.bridge && /^https?:\/\//i.test(m.bridge);
		const pfxDetected = detectPrefix(m);
		return {
			label: copy ? `${m.label}（副本）` : m.label,
			id: copy ? `${m.id}-copy` : m.id,
			idTouched: true,
			driver: m.driver || "generic",
			command: m.command || "",
			probe: m.probe || "",
			argsPrefixText: (m.argsPrefix || []).join("\n"),
			envRows: Object.entries(m.env || {}),
			bridge: bridgeIsUrl ? "__url__" : (m.bridge || ""),
			bridgeUrl: bridgeIsUrl ? m.bridge : "",
			target: m.target || "",
			order: String(m.order ?? 1000),
			enabled: m.enabled !== false,
			...pfxDetected,
		};
	}
	function agentOfForm(f) {
		const env = {};
		for (const [k, v] of f.envRows) {
			const key = String(k || "").trim();
			if (key) env[key] = String(v ?? "");
		}
		return {
			label: f.label, id: f.id, driver: f.driver, command: f.command, probe: f.probe,
			argsPrefix: f.argsPrefixText, env,
			bridge: f.bridge === "__url__" ? f.bridgeUrl : f.bridge,
			...(f.driver !== "generic" && f.target ? { target: f.target } : {}),
			order: f.order, enabled: f.enabled,
		};
	}

	function CustomAgentPanel() {
		const [open, setOpen] = useState(false);
		const [view, setView] = useState({ mode: "list" });
		const [data, setData] = useState(null);      // GET /agents 响应
		const [notice, setNotice] = useState(null);  // { kind: "ok"|"err", text }
		const [busy, setBusy] = useState(null);      // 进行中动作 key
		const [form, setForm] = useState(emptyForm());
		

		useEffect(() => {
			moduleSetOpen = setOpen;
			moduleSetView = setView;
			return () => {
				if (moduleSetOpen === setOpen) moduleSetOpen = null;
				if (moduleSetView === setView) moduleSetView = null;
			};
		}, []);

		async function call(key, p, init, okText) {
			setBusy(key);
			setNotice(null);
			try {
				const r = await api(p, init);
				const d = await r.json();
				if (d && d.error) setNotice({ kind: "err", text: d.error });
				else if (okText) setNotice({ kind: "ok", text: typeof okText === "function" ? okText(d) : okText });
				if (d && d.agents) setData(d);
				return d;
			} catch (e) {
				setNotice({ kind: "err", text: String(e?.message || e) });
				return null;
			} finally {
				setBusy(null);
			}
		}
		const post = (key, p, body, okText) => call(key, p, jsonInit(body), okText);

		useEffect(() => {
			if (open) call("load", "/agents", undefined);
		}, [open]);

		if (!open) return null;
		if (view.mode === "edit") {
			return hPanel(hForm);
		}
		return hPanel(hList);

		// ---------------- 面板骨架（aiti-float 契约：浮动接管 + 小屏全屏 + 内容区自滚） ----------------
		//
		// 契约要点（aiti-float 实现见 client/src/float.ts：接管时会给根节点写
		// `overflow:hidden !important`，非 autoh 还会写 `max-height:none` + 固定 height）：
		// 根节点必须是 **不可滚动** 的 flex 列容器（标题栏自然高 + 内容区 flex:1/minHeight:0/
		// overflowY:auto），否则内容一超就被裁掉且拿不到滚动条（历史 bug：表单变长后整窗不可滚动）。
		// autoh：高度随内容自适应，节点自带的 max-height 封顶继续生效（不写 data-ext-float-h）。
		function hPanel(content) {
			return h(
				"div",
				{
					"data-ext-float": "1", "data-ext-float-key": "aiti-custom-agent:panel",
					"data-ext-float-full": "1", "data-ext-float-w": "640", "data-ext-float-autoh": "1",
					style: { position: "fixed", top: "7%", right: "3%", zIndex: 9999, background: "var(--bg, #fff)", color: "inherit",
						border: "1px solid rgba(128,128,128,.35)", borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,.25)",
						padding: "12px 14px", width: 640, maxWidth: "94vw", maxHeight: "82vh",
						display: "flex", flexDirection: "column", overflow: "hidden", fontSize: 13 },
				},
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexShrink: 0 } },
					h("b", null, "自定义 Agent"),
					h("span", { style: { opacity: 0.6, fontSize: 11 } }, "新建会话后端注册中心 · 保存即热生效"),
					h("span", { style: { flex: 1 } }),
					view.mode === "list" && h("button", {
						disabled: busy != null,
						onClick: () => { setForm(emptyForm()); setView({ mode: "edit" }); },
					}, "＋ 新增"),
					view.mode === "edit" && h("button", { onClick: () => setView({ mode: "list" }) }, "返回列表"),
					h("button", { onClick: () => setOpen(false), title: "关闭" }, "✕"),
				),
				// 内容区：唯一滚动容器（aiti-float 约定 flex:1 + minHeight:0 + overflowY auto）
				h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 } },
					notice && h("div", {
						style: { margin: "4px 0 8px", whiteSpace: "pre-wrap", color: notice.kind === "err" ? "#dc2626" : "#16a34a" },
					}, notice.text),
					content(),
				),
			);
		}

		// ---------------- 列表页 ----------------
		function hList() {
			const agents = data?.agents ?? [];
			const warnings = data?.warnings ?? [];
			return h("div", null,
				!agents.length && h("div", { style: { opacity: 0.7, padding: "10px 0" } },
					data ? "还没有自定义后端——点「＋ 新增」注册一条（如 docker 化的 CLI）。" : "加载中…"),
				...agents.map((m, i) => hRow(m, agents[i - 1], agents[i + 1])),
				!!warnings.length && h("div", { style: { marginTop: 8, color: "#d97706", fontSize: 11, whiteSpace: "pre-wrap" } },
					"配置警告：\n" + warnings.join("\n")),
				h("div", { style: { opacity: 0.55, marginTop: 10, fontSize: 11, lineHeight: "16px" } },
					"generic 驱动 = one-shot 任务型：任务文本写进 stdin，stdout 流式进会话；模型/权限等完整协议能力等 P2 协议委托。"),
			);
		}

		function hRow(m, prev, next) {
			const probe = m.probe;
			return h("div", { key: m.id, style: { borderTop: "1px solid rgba(128,128,128,.18)", padding: "8px 0" } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
					h("b", null, m.label),
					m.enabled === false && h("span", { style: { color: "#64748b", fontSize: 11 } }, "已停用"),
					!m.enabled && null,
					m.enabled !== false && (m.registered
						? h("span", { style: { color: "#16a34a", fontSize: 11 } }, "● 已注册")
						: h("span", { style: { color: "#d97706", fontSize: 11 } }, "○ 未注册（探活失败或停用）")),
					probe && (probe.ok
						? h("span", { title: probe.detail, style: { color: "#16a34a", fontSize: 11 } }, "✓ 探活")
						: h("span", { title: probe.detail, style: { color: "#dc2626", fontSize: 11 } }, "✗ 探活")),
					h("span", { style: { flex: 1 } }),
					h("button", { disabled: busy != null, onClick: () => { setForm(formOf(m)); setView({ mode: "edit" }); } }, "编辑"),
					h("button", { disabled: busy != null, onClick: () => { setForm(formOf(m, true)); setView({ mode: "edit" }); } }, "复制"),
					h("button", {
						disabled: busy != null || !m.registered,
						title: "运行探活命令",
						onClick: () => post(`probe:${m.id}`, "/probe", { id: m.id }, (d) => `探活：${d.detail ?? (d.ok ? "可执行" : "失败")}`),
					}, "探活"),
					h("button", {
						disabled: busy != null,
						onClick: () => post(`toggle:${m.id}`, `/agents/${m.id}`, { ...m, enabled: m.enabled === false }, "已更新"),
					}, m.enabled === false ? "启用" : "停用"),
					h("button", {
						disabled: busy != null || !prev,
						title: "上移（与上一位交换位次）",
						onClick: () => swapOrder(m, prev),
					}, "↑"),
					h("button", {
						disabled: busy != null || !next,
						title: "下移（与下一位交换位次）",
						onClick: () => swapOrder(m, next),
					}, "↓"),
					h("button", {
						disabled: busy != null,
						onClick: async () => {
							if (!window.confirm(`删除自定义后端「${m.label}」(${m.id})？`)) return;
							await call(`del:${m.id}`, `/agents/${m.id}`, { method: "DELETE" }, "已删除");
						},
					}, "删除"),
				),
				h("div", { style: { opacity: 0.65, fontSize: 11, margin: "2px 0 2px" } },
					`${m.id} · 驱动 ${m.driver}${m.serviceKey ? (m.serviceOk ? " · 服务 ✓" : " · 服务 ✗（基础扩展未部署/过旧）") : ""} · ${m.command || "(默认 CLI)"}${(m.argsPrefix || []).length ? " ▸ " + m.argsPrefix.join(" ") : ""}`),
			);
		}

		async function swapOrder(a, b) {
			if (!a || !b) return;
			await post(`swap:${a.id}`, `/agents/${a.id}`, { ...a, order: b.order }, "已调整位次");
			await post(`swap:${b.id}`, `/agents/${b.id}`, { ...b, order: a.order }, "已调整位次");
		}

		// ---------------- 前缀命令（开关 / 类型字段 / 生成同步） ----------------

		/** 切 无/包装类型（选「无」= 直接跑命令）：真实 CLI（cli 字段）跟着类型走 */
		function pickPrefixKind(kind) {
			setForm((f) => switchPrefixKind(f, kind));
		}
		/** 改任一结构字段 → 立即重算 command/参数前缀 */
		function setPfx(patch) {
			setForm((f) => {
				const pfx = { ...(f.pfx ?? emptyPfx()) };
				pfx[f.prefixKind] = { ...(pfx[f.prefixKind] ?? {}), ...patch };
				return applyPrefix({ ...f, pfx });
			});
		}

		/** 被包装真实 CLI 的输入提示：协议型驱动必须显式填（command 顶替后驱动不带自家 CLI 名） */
		function cliPlaceholder() {
			const def = DRIVER_DEFAULT_CLI[form.driver];
			if (form.driver !== "generic") return `必填：${def ?? "该驱动默认 CLI"}（command 已由包装命令顶替）`;
			return form.prefixKind === "docker" ? "留空 = 用镜像入口点；否则填真实 CLI（如 claude）" : "如 claude（可带参数）";
		}

		/** 各包装类型的结构字段（生成 argsPrefix 的输入；docker 额外给常用前缀/选项下拉） */
		function hPrefixFields(p) {
			if (form.prefixKind === "docker") {
				return [
					hField("运行方式", h("select", { value: p.mode ?? "run-i", onChange: (e) => setPfx({ mode: e?.target?.value ?? "run-i" }) },
						...DOCKER_MODES.map((o) => h("option", { key: o.value, value: o.value }, o.label)))),
					hField("镜像/容器", h("input", {
						value: p.image ?? "", size: 30, placeholder: "aiti/aiti:core（exec 模式填容器名）",
						onInput: (e) => setPfx({ image: e?.target?.value ?? "" }),
					})),
					hField("容器内命令", h("input", {
						value: p.cli ?? "", size: 34, placeholder: cliPlaceholder(),
						onInput: (e) => setPfx({ cli: e?.target?.value ?? "" }),
					})),
					hField("附加参数", h("span", null,
						h("textarea", {
							value: p.opts ?? "", rows: 4, cols: 50, placeholder: "每行一个参数：-v / ${cwd}:${cwd} / -w / ${cwd}",
							onInput: (e) => setPfx({ opts: e?.target?.value ?? "" }),
						}), " ",
						h("select", {
							value: "",
							onChange: (e) => {
								const v = String(e?.target?.value ?? "");
								if (e?.target) e.target.value = "";
								if (!v) return;
								const extra = DOCKER_EXTRAS.find((x) => x.value === v);
								if (extra) setPfx({ opts: [...linesOf(p.opts), ...extra.args].join("\n") });
							},
						},
							h("option", { key: "__pick__", value: "" }, "＋ 常用选项…"),
							...DOCKER_EXTRAS.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
						h("div", { style: { opacity: 0.6, fontSize: 11, marginTop: 2 } },
							"容器内回连宿主桥：桥模式选 host.docker.internal 时补 --add-host=host.docker.internal:host-gateway，或直接用共享宿主网络的运行方式。"),
					)),
				];
			}
			if (form.prefixKind === "ssh") {
				return [
					hField("目标", h("input", {
						value: p.target ?? "", size: 30, placeholder: "user@host",
						onInput: (e) => setPfx({ target: e?.target?.value ?? "" }),
					})),
					hField("端口", h("input", {
						value: p.port ?? "", size: 6, placeholder: "22",
						onInput: (e) => setPfx({ port: e?.target?.value ?? "" }),
					})),
					hField("远端命令", h("input", {
						value: p.cli ?? "", size: 34, placeholder: cliPlaceholder(),
						onInput: (e) => setPfx({ cli: e?.target?.value ?? "" }),
					})),
					hField("附加选项", h("span", null,
						h("textarea", {
							value: p.opts ?? "", rows: 3, cols: 50, placeholder: "每行一个参数，如 -t / -o / StrictHostKeyChecking=accept-new",
							onInput: (e) => setPfx({ opts: e?.target?.value ?? "" }),
						}),
						h("div", { style: { opacity: 0.6, fontSize: 11, marginTop: 2 } }, "远端须免密登录（密钥 agent 已配好）；-p 端口在上方位次之间自动插入。"),
					)),
				];
			}
			if (form.prefixKind === "env") {
				return [
					hField("临时变量", h("textarea", {
						value: p.vars ?? "", rows: 3, cols: 50, placeholder: "每行一个 KEY=VALUE，如：\nHTTPS_PROXY=$HTTPS_PROXY\nFOO=bar",
						onInput: (e) => setPfx({ vars: e?.target?.value ?? "" }),
					})),
					hField("被包装命令", h("input", {
						value: p.cli ?? "", size: 34, placeholder: cliPlaceholder(),
						onInput: (e) => setPfx({ cli: e?.target?.value ?? "" }),
					})),
				];
			}
			if (form.prefixKind === "custom") {
				return [
					hField("附加参数", h("span", null,
						h("textarea", {
							value: p.opts ?? "", rows: 3, cols: 50,
							placeholder: "每行一个参数，如 nix-shell 的 --run / sudo 的 -E",
							onInput: (e) => setPfx({ opts: e?.target?.value ?? "" }),
						}),
						h("div", { style: { opacity: 0.6, fontSize: 11, marginTop: 2 } },
							"包装命令填在下方「命令」框（任意可执行文件：sudo / nix-shell / podman / timeout / firejail …）；这儿放它的参数。"),
					)),
					hField("被包装命令", h("input", {
						value: p.cli ?? "", size: 34, placeholder: cliPlaceholder(),
						onInput: (e) => setPfx({ cli: e?.target?.value ?? "" }),
					})),
				];
			}
			return [
				hField("代理工具", h("select", { value: p.tool ?? "runsocks", onChange: (e) => setPfx({ tool: e?.target?.value ?? "runsocks" }) },
					...SOCKS_TOOLS.map((o) => h("option", { key: o.value, value: o.value }, o.label)))),
				hField("附加参数", h("textarea", {
					value: p.opts ?? "", rows: 3, cols: 50, placeholder: "每行一个参数，如 proxychains 的 -f / 配置文件路径",
					onInput: (e) => setPfx({ opts: e?.target?.value ?? "" }),
				})),
				hField("被包装命令", h("input", {
					value: p.cli ?? "", size: 34, placeholder: cliPlaceholder(),
					onInput: (e) => setPfx({ cli: e?.target?.value ?? "" }),
				})),
				h("div", { style: { opacity: 0.6, fontSize: 11 } }, "socks 服务端地址在各工具自己的配置里（dante.conf / proxychains.conf），不在本表单。"),
			];
		}

		// ---------------- 表单页 ----------------
		function hForm() {
			return h("div", { style: { display: "grid", gap: 8 } },
				hField("显示名", h("input", {
					value: form.label, size: 44, placeholder: "如 Claude Code (Docker)",
					onInput: (e) => setForm((f) => ({ ...f, label: e?.target?.value ?? "", id: f.idTouched ? f.id : slugify(e?.target?.value ?? "") })),
				})),
				hField("标识 id", h("span", null,
					h("input", {
						value: form.id, size: 30, placeholder: "自动生成，可改",
						onInput: (e) => setForm((f) => ({ ...f, id: e?.target?.value ?? "", idTouched: true })),
					}),
					h("span", { style: { opacity: 0.6, fontSize: 11, marginLeft: 6 } }, "provider type（字母/数字/-_）")),
				),
				hField("驱动类型", h("select", { value: form.driver, onChange: (e) => setForm((f) => ({ ...f, driver: e?.target?.value ?? "generic" })) },
					...DRIVER_OPTIONS.map((o) => h("option", { key: o.value, value: o.value, disabled: !!o.disabled }, o.label)))),
				hField("前缀命令", h("span", null,
					h("select", { value: form.prefixEnabled ? form.prefixKind : "", onChange: (e) => pickPrefixKind(e?.target?.value ?? "") },
						...PREFIX_CHOICES.map((o) => h("option", { key: o.value || "__none__", value: o.value }, o.label))),
					h("span", { style: { opacity: 0.6, fontSize: 11, marginLeft: 6 } },
						"用 docker / ssh / env / proxychains 等包装真实 CLI——选中即顶替「命令」，真实 CLI 进参数前缀末尾"),
				)),
				form.prefixEnabled && h("div", { style: { border: "1px dashed rgba(128,128,128,.4)", borderRadius: 8, padding: "8px 10px", display: "grid", gap: 6 } },
					...hPrefixFields(form.pfx?.[form.prefixKind] ?? {}),
					h("div", { style: { opacity: 0.7, fontSize: 11, lineHeight: "16px", wordBreak: "break-all" } },
						`实际执行：${[form.command, ...linesOf(form.argsPrefixText)].join(" ")}`),
				),
				hField(form.prefixEnabled ? "包装命令" : "命令", h("span", null,
					h("input", {
						value: form.command, size: 36,
						// 自定义包装的工具名写在这里（绕过下面的只读）——它是 command 本身
						disabled: form.prefixEnabled === true && form.prefixKind !== "custom",
						placeholder: form.prefixEnabled
							? (form.prefixKind === "custom" ? "任意可执行文件：sudo / nix-shell / podman / timeout …" : "由包装类型决定（换 podman 等请选「自定义」）")
							: (form.driver === "generic" ? "如 docker（容器内 CLI 写进参数前缀末尾）" : "留空 = 用该驱动默认 CLI"),
						onInput: (e) => {
							const v = e?.target?.value ?? "";
							if (form.prefixEnabled && form.prefixKind === "custom") setPfx({ tool: v });
							else setForm((f) => ({ ...f, command: v }));
						},
					}), " ",
					h("button", {
						disabled: busy != null || !(form.probe || form.command).trim(),
						onClick: () => post("probe-form", "/probe", { command: form.command, probe: form.probe },
							(d) => `探测：${d.detail ?? (d.ok ? "可执行" : "失败")}`),
					}, busy === "probe-form" ? "探测中…" : "探测"),
				)),
				hField("探活命令", h("input", {
					value: form.probe, size: 36, placeholder: "缺省 = 命令（可带空格分隔参数，如 docker version）",
					onInput: (e) => setForm((f) => ({ ...f, probe: e?.target?.value ?? "" })),
				})),
				hField("参数前缀", h("span", null,
					h("textarea", {
						value: form.argsPrefixText, rows: 6, cols: 56,
						placeholder: "每行一个参数，如：\nrun\n--rm\n-i\n-v\n${cwd}:${cwd}\n-w\n${cwd}\nmy-image:latest\nclaude",
						onInput: (e) => setForm((f) => ({ ...f, argsPrefixText: e?.target?.value ?? "" })),
					}),
					h("div", { style: { opacity: 0.6, fontSize: 11, marginTop: 2 } },
						form.prefixEnabled
							? "由上方包装字段生成；改任一包装字段即按模板重写，这里可继续手改（每行一个参数，支持 $VAR / ${cwd}）。"
							: "拼在驱动内置参数之前；支持 $VAR / ${cwd}（会话工作目录）。docker 配方建议 -v ${cwd}:${cwd} -w ${cwd} 同路径挂载。")),
				),
				hField("环境变量", h("div", { style: { display: "grid", gap: 4 } },
					...form.envRows.map(([k, v], i) => h("div", { key: i, style: { display: "flex", gap: 4, alignItems: "center" } },
						h("input", { value: k, size: 16, placeholder: "KEY", onInput: (e) => setEnvRow(i, 0, e?.target?.value ?? "") }),
						h("span", null, "="),
						h("input", { value: v, size: 30, placeholder: "VALUE（支持 $VAR / ${cwd}）", onInput: (e) => setEnvRow(i, 1, e?.target?.value ?? "") }),
						h("button", { onClick: () => setForm((f) => ({ ...f, envRows: f.envRows.filter((_, j) => j !== i) })) }, "✕"),
					)),
					h("button", { onClick: () => setForm((f) => ({ ...f, envRows: [...f.envRows, ["", ""]] })) }, "＋ 添加变量"),
					h("div", { style: { opacity: 0.6, fontSize: 11 } }, "成员级 env，优先级最高；密钥建议写 $VAR 引用父进程环境变量而非明文。"),
				)),
				hField("桥模式", h("span", null,
					h("select", { value: form.bridge, onChange: (e) => setForm((f) => ({ ...f, bridge: e?.target?.value ?? "" })) },
						...BRIDGE_OPTIONS.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
					form.bridge === "__url__" && h("input", {
						value: form.bridgeUrl, size: 34, placeholder: "http://host:port/…",
						onInput: (e) => setForm((f) => ({ ...f, bridgeUrl: e?.target?.value ?? "" })),
						style: { marginLeft: 6 },
					}),
				)),
				(data?.driverMembers ?? {})[form.driver]?.length
					? hField("委托目标", h("span", null,
						h("select", { value: form.target, onChange: (e) => setForm((f) => ({ ...f, target: e?.target?.value ?? "" })) },
							h("option", { key: "__default__", value: "" }, "缺省成员"),
							...data.driverMembers[form.driver].map((mm) => h("option", { key: mm.name, value: mm.name }, `${mm.label}（agentKey: ${mm.agentKey}）`))),
						h("div", { style: { opacity: 0.6, fontSize: 11, marginTop: 2 } }, "多成员驱动（如 ACP）指定委托到哪个成员；缺省由基础扩展决定。"),
					))
					: null,
				hField("排序", h("input", {
					value: form.order, size: 8, placeholder: "1000",
					onInput: (e) => setForm((f) => ({ ...f, order: e?.target?.value ?? "" })),
				})),
				hField("启用", h("input", {
					type: "checkbox", checked: form.enabled === true,
					onChange: (e) => setForm((f) => ({ ...f, enabled: e?.target?.checked ?? true })),
				})),
				h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
					h("button", {
						disabled: busy != null || !form.label.trim() || (form.driver === "generic" && !form.command.trim()),
						onClick: async () => {
							const d = await post("save", "/agents", agentOfForm(form), () => "已保存并热生效");
							if (d && !d.error) { setView({ mode: "list" }); }
							if (d && d.problems && d.problems.length) setNotice({ kind: "err", text: "已保存，但以下成员未注册：\n" + d.problems.join("\n") });
							else if (d && d.warnings && d.warnings.length) setNotice({ kind: "err", text: "已保存，但有条目被跳过：\n" + d.warnings.join("\n") });
						},
					}, busy === "save" ? "保存中…" : "保存"),
					h("button", { onClick: () => setView({ mode: "list" }) }, "取消"),
				),
			);
		}

		function hField(labelText, control) {
			return h("label", { style: { display: "grid", gridTemplateColumns: "72px 1fr", gap: 8, alignItems: "start" } },
				h("span", { style: { paddingTop: 4, opacity: 0.8 } }, labelText),
				control,
			);
		}

		function setEnvRow(i, col, value) {
			setForm((f) => {
				const rows = f.envRows.map((r, j) => (j === i ? (col === 0 ? [value, r[1]] : [r[0], value]) : r));
				return { ...f, envRows: rows };
			});
		}
	}

	function slugify(text) {
		const s = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		return s || "";
	}
}

export default function register(ctx) {
	registerCustomAgentClient(ctx, { extId: "aiti-custom-agent" });
}
