/**
 * aiti-custom-agent core —— agents.json 配置读写/规整纯逻辑（无依赖，CommonJS）。
 *
 * 职责边界：本文件管「持久化 + 保存侧规整」（原子写/slug/输入规整/唯一 id）；
 * 「加载侧校验」在共享层 agent-spawn-env.ts 的 parseCustomAgents（权威，UI 读回后
 * 统一走它）——两侧不同关注点，不重复同一规则。
 *
 * 存储：<configDir>/agents.json（内部格式，UI 读写，登记 package.json
 * aitiConfigs.configFiles 进备份白名单）：
 *   { "version": 1, "updatedAt": iso, "agents": [ { id,label,driver,command,
 *     argsPrefix[], env{}, bridge, probe, order, enabled } ] }
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function configPath(configDir) {
	return path.join(configDir, "agents.json");
}

/** 读配置原文：缺失 → { agents: [] }；坏 JSON → { __parseError } 交 parseCustomAgents 记 warning */
function loadAgents(configDir) {
	const fp = configPath(configDir);
	if (!fs.existsSync(fp)) return { agents: [] };
	try {
		return JSON.parse(fs.readFileSync(fp, "utf8"));
	} catch (e) {
		return { __parseError: String((e && e.message) || e) };
	}
}

/** 原子写出（tmp + rename，防半截配置）；agents 取规整后的最小字段集 */
function saveAgents(configDir, agents) {
	fs.mkdirSync(configDir, { recursive: true });
	const clean = (agents || []).map((m) => ({
		id: String(m.id),
		label: String(m.label),
		driver: String(m.driver || "generic"),
		command: String(m.command || ""),
		argsPrefix: Array.isArray(m.argsPrefix) ? m.argsPrefix.map(String) : [],
		env: m.env && typeof m.env === "object" && !Array.isArray(m.env)
			? Object.fromEntries(Object.entries(m.env).map(([k, v]) => [String(k).trim(), String(v ?? "")]))
			: {},
		bridge: String(m.bridge || ""),
		probe: String(m.probe || ""),
		order: Number.isFinite(Number(m.order)) && String(m.order ?? "").trim() !== "" ? Number(m.order) : 1000,
		enabled: m.enabled !== false,
	}));
	const fp = configPath(configDir);
	const tmp = fp + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), agents: clean }, null, 2) + "\n");
	fs.renameSync(tmp, fp);
	return { ok: true, count: clean.length };
}

/** label → slug（provider type 用：小写、非法字符折 -、折叠连字符）。
 *  含被剔除的非 ASCII 字符（中文等）时追加稳定短哈希，防「我的 X / 你的 X」同 slug 碰撞；空 → "agent"。 */
function slugify(text) {
	const s = String(text || "");
	const lower = s.toLowerCase();
	let base = lower
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	if (/[^\x00-\x7f]/.test(s)) {
		let h = 0;
		for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
		base = (base ? base + "-" : "agent-") + h.toString(36);
	}
	return base || "agent";
}

/** id 合法性（与 parseCustomAgents 同规：[a-z0-9][a-z0-9_-]*，不含 / .） */
function validId(id) {
	return /^[a-z0-9][a-z0-9_-]*$/i.test(String(id || "").trim());
}

/**
 * API 输入规整（保存侧第一道关；深校验交给 parseCustomAgents）：
 *   - id 缺省 slug(label)；label 缺 → error
 *   - argsPrefix 接受 string（多行）或 array → array
 *   - env 接受对象或 KEY=VALUE 行串 → 对象（-NAME 行丢弃——对象表达不了排除）
 *   - driver 白名单外的原样保留（parseCustomAgents 记 warning 跳过，UI 可见）
 * 返回 { agent } 或 { error }
 */
function normalizeInput(body) {
	const b = body && typeof body === "object" ? body : {};
	const label = String(b.label ?? "").trim();
	if (!label) return { error: "显示名 label 必填" };
	const driver = String(b.driver ?? "generic").trim() || "generic";
	const command = String(b.command ?? "").trim();
	// 仅 generic 必填 command（协议型空 = 用驱动默认 CLI，由基础扩展解析）
	if (driver === "generic" && !command) return { error: "启动命令 command 必填" };
	// spawn(command, args) 语义：command 是单个可执行文件名——含空格几乎总是误把参数写进命令
	if (driver === "generic" && /\s/.test(command)) {
		return { error: "启动命令含空格（spawn 需要单个可执行文件名）——参数请逐行放进「参数前缀」" };
	}
	const id = String(b.id ?? "").trim() || slugify(label);
	if (!validId(id)) return { error: `非法标识 id「${id}」（须字母/数字开头，仅含字母数字-_）` };

	let argsPrefix = [];
	if (Array.isArray(b.argsPrefix)) argsPrefix = b.argsPrefix.map((a) => String(a).trim()).filter(Boolean);
	else if (typeof b.argsPrefix === "string" && b.argsPrefix.trim()) {
		argsPrefix = b.argsPrefix.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
	}

	let env = {};
	if (b.env && typeof b.env === "object" && !Array.isArray(b.env)) {
		for (const [k, v] of Object.entries(b.env)) {
			const key = String(k).trim();
			if (key) env[key] = String(v ?? "");
		}
	} else if (typeof b.env === "string" && b.env.trim()) {
		for (const rawLine of b.env.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			if (line.startsWith("-")) continue; // 排除行在对象形态无意义，丢弃
			const eq = line.indexOf("=");
			if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
		}
	}

	const orderRaw = String(b.order ?? "").trim();
	return {
		agent: {
			id,
			label,
			driver,
			command,
			argsPrefix,
			env,
			bridge: String(b.bridge ?? "").trim(),
			target: String(b.target ?? "").trim(),
			probe: String(b.probe ?? "").trim(),
			order: orderRaw !== "" && Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : 1000,
			enabled: b.enabled !== false,
		},
	};
}

module.exports = { configPath, loadAgents, saveAgents, slugify, validId, normalizeInput };
