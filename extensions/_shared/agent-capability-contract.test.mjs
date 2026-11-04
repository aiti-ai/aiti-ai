/**
 * agent-capability-contract —— Agent 类扩展 capability 声明 ↔ handle 方法存在性 静态对照
 * （债务清单 docs/pi-web-ext-agent-authoring-debt.md D2 防回归）。
 *
 * 机制：适配层（pi-web lib/session/handle-adapter.ts）对 steer/followUp 等命令是
 * 「cap("X") 通过后 await h.X!()」——声明 true 而方法缺失即运行时 TypeError；
 * getMessages 错名则走 fail-loud 报 UnsupportedCapability（不崩但功能缺失）。
 * 本测试静态扫描 pi-web-ext/aiti-*-agent 的 *.ts 源码（不 import、零副作用）：
 *   1. 逐行收集已知 capability 键为 `true` 的声明（剔除注释行）；
 *   2. 对照「方法定义行模式」与豁免表（无方法面的声明）；
 *   3. 声明 true 而两处皆无 → fail，提示补方法或改 false + fail-loud stub。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/agent-capability-contract.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** capability 键 → handle 方法名（多候选 = 任一存在即可）。
 *  依据 pi-web handle-adapter.ts 命令表的查名。 */
const CAP_TO_METHODS = {
	prompt: ["prompt"],
	abort: ["abort"],
	steer: ["steer"],
	followUp: ["followUp"],
	getMessages: ["getMessages"],
	getUsage: ["getUsage"],
	contextUsage: ["getContextUsage"],
	getCommands: ["getCommands"],
	respondPermission: ["respondPermission"],
	respondInteraction: ["respondInteraction"],
	queueManage: ["queueManage"],
	setModel: ["setModel"],
	setThinkingLevel: ["setThinkingLevel"],
	setPermissionMode: ["setPermissionMode"],
	fork: ["fork"],
	renameSession: ["setSessionName"], // adapter set_session_name → h.setSessionName!()
	compact: ["compact"],
	executeBash: ["executeBash"],
	setActiveTools: ["setActiveTools"],
	navigateTree: ["navigateTree"],
	deleteSession: ["deleteSession"],
	listModels: ["getAvailableModels"],
	// adapter get_tools 走 h.send 直达通道或 getAllTools 快照，任一即可
	listTools: ["getAllTools", "getTools", "send"],
};

/** 无独立方法面的 capability（声明 true 合法，无需方法）： */
const CAP_EXEMPT = new Set([
	"fileAttachments", // prompt images 参数面；ACP 实例按 initialize promptCapabilities 收敛
]);

const KNOWN_KEYS = new Set([...Object.keys(CAP_TO_METHODS), ...CAP_EXEMPT]);

/** 方法定义行模式（逐行；不含调用——调用带 `.` / `!` 前缀或缩进不符）：
 *   async followUp(text: string): Promise<void> {   /   getUsage() {   /
 *   queueManage = (req: {...}) => ...               /   private steer(): never { */
function methodDefined(src, method) {
	const esc = method.replace(/\$/g, "\\$");
	const reDef = new RegExp(`^\\s*(?:private\\s+|protected\\s+|public\\s+)?(?:readonly\\s+)?(?:async\\s+)?${esc}\\s*[<(]`);
	const reArrow = new RegExp(`^\\s*(?:private\\s+|readonly\\s+)?${esc}\\s*=\\s*(?:async\\s*)?\\(`);
	return src.split(/\r?\n/).some((line) => {
		const t = line.trim();
		if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
		return reDef.test(line) || reArrow.test(line);
	});
}

function listAgentExts() {
	return readdirSync(ROOT)
		.filter((name) => name.startsWith("aiti-") && name.endsWith("-agent"))
		.filter((name) => statSync(join(ROOT, name)).isDirectory())
		.sort();
}

function listTsFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (name === "node_modules" || name === "dist" || name === "tools" || name === "client") continue;
			out.push(...listTsFiles(p));
		} else if (name.endsWith(".ts")) {
			out.push(p);
		}
	}
	return out;
}

for (const ext of listAgentExts()) {
	test(`[${ext}] capability 声明 ↔ handle 方法对照（D2 防回归）`, () => {
		const files = listTsFiles(join(ROOT, ext));
		assert.ok(files.length, `${ext}: 未找到 .ts 源文件`);
		const src = files.map((p) => readFileSync(p, "utf8")).join("\n");

		// 收集声明 true 的已知 capability 键（剔除纯注释行）
		const claimed = new Map(); // key -> 首个声明处描述
		for (const file of files) {
			for (const [i, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
				const t = line.trim();
				if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
				const m = t.match(/^([A-Za-z]\w*):\s*true\b/);
				if (m && KNOWN_KEYS.has(m[1]) && !claimed.has(m[1])) {
					claimed.set(m[1], `${file.replace(ROOT + "/", "")}:${i + 1}`);
				}
			}
		}

		const problems = [];
		for (const [key, at] of [...claimed].sort()) {
			if (CAP_EXEMPT.has(key)) continue;
			const candidates = CAP_TO_METHODS[key] ?? [];
			const found = candidates.find((m) => methodDefined(src, m));
			if (!found) {
				problems.push(
					`capabilities.${key}: true（${at}）但无对应方法（${candidates.join("/")}）——` +
					`适配层调用即 TypeError/UnsupportedCapability；请实现方法或改 false + fail-loud stub`,
				);
			}
		}
		assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
	});
}
