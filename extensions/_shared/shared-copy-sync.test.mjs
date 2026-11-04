/**
 * shared-copy-sync —— 共享层「权威源 ↔ 扩展副本」一致性校验（债务清单 D7）。
 *
 * 背景：backend-queue.ts / agent-spawn-env.ts 等共享实现层以手工副本方式分发到各
 * agent 扩展目录（部署随扩展拷贝），无同步脚本——副本侧改了不回写权威源（或反向）
 * 即静默漂移，D1 的捕获缺失曾同时存在于全部副本。
 *
 * 校验策略：
 *   1. 整文件副本：凡全仓出现的同名副本必须与 _shared 权威源逐字节一致；
 *   2. external-governance.ts（副本文件名）↔ external-cli-governance.ts（权威源）：
 *      副本是按扩展裁剪的子集（各只保留自家 CLI 白名单段），校验「副本非注释行 ⊆
 *      权威源行集合」——抓逻辑改动不回写，允许裁剪。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/shared-copy-sync.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEP = process.platform === "win32" ? "\\" : "/";

/** 整文件副本（文件名相同，权威源 _shared/<name>）。 */
const EXACT_COPIES = [
	"backend-queue.ts",
	"agent-spawn-env.ts",
	"ext-model-state.ts",
	"controlled-login.mjs",
	"cbc-model-catalog.ts",
	"cursor-cli-store.ts", // 副本另含 session-manager/lib/agents/（find 全仓覆盖）
	"session-recycle.ts", // D8：acp/qoder/pi/attach 四家副本
	"exec-async.ts", // execSync→async 改造（2026-09-12）：git-trace/git-review/channels/editor/agents/cmd/session-manager 副本
	"agent-accounts.ts", // 账号档引擎（2026-09-13）：aiti-agent-manager 副本
];

/** 裁剪子集副本：副本文件名 → 权威源文件名。 */
const SUBSET_COPIES = {
	"external-governance.ts": "external-cli-governance.ts",
};

function walkFiles(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of entries) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (name === "node_modules" || name === "dist" || name === ".git" || name === ".next") continue;
			walkFiles(p, out);
		} else {
			out.push(p);
		}
	}
	return out;
}

const allFiles = walkFiles(ROOT);

/** 非注释/非空行（trim 后），用于子集比较。 */
function codeLines(text) {
	return text.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
}

test("整文件共享副本与权威源逐字节一致（D7）", () => {
	const problems = [];
	for (const name of EXACT_COPIES) {
		const authority = join(ROOT, "_shared", name);
		let authBuf;
		try {
			authBuf = readFileSync(authority);
		} catch {
			problems.push(`权威源缺失: _shared/${name}（副本校验无从谈起，请确认权威源在位）`);
			continue;
		}
		const copies = allFiles.filter((p) => p.split(SEP).pop() === name && relative(ROOT, p).split(SEP)[0] !== "_shared");
		// M2a（2026-09-16）后副本已退役为 @aiti-ai/ext-shared 包导入：副本可以为零；
		// 若再出现同名副本（新扩展手拷），仍强制与权威源逐字节一致——防漂移守卫保留。
		for (const copy of copies) {
			const same = readFileSync(copy).equals(authBuf);
			if (!same) {
				problems.push(`副本漂移: ${relative(ROOT, copy)} ≠ _shared/${name} —— 以权威源为准同步（副本侧改动须先回写 _shared）`);
			}
		}
	}
	assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("external-governance 副本是权威源（external-cli-governance）的行级子集（D7）", () => {
	const problems = [];
	for (const [copyName, authName] of Object.entries(SUBSET_COPIES)) {
		const authority = new Set(codeLines(readFileSync(join(ROOT, "_shared", authName), "utf8")));
		const copies = allFiles.filter((p) => p.split(SEP).pop() === copyName);
		assert.ok(copies.length, `${copyName}: 全仓未发现任何副本`);
		for (const copy of copies) {
			const missing = codeLines(readFileSync(copy, "utf8")).filter((l) => !authority.has(l));
			if (missing.length) {
				problems.push(
					`副本越权/漂移: ${relative(ROOT, copy)} 有 ${missing.length} 行不在权威源 _shared/${authName} 中` +
					`（前 3 行: ${missing.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 60))).join(" | ")}）——` +
					`逻辑改动必须先回写权威源再裁剪`,
				);
			}
		}
	}
	assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});
