/**
 * provider-priority-contract —— 同 agentKey 认领顺序约定断言（债务 D9 防回归）。
 *
 * pi-web `findProvidersForAgent`（lib/session/providers.ts）按 `priority ?? 0` 降序排——
 * 同 agentKey 有多家 provider 时，数值决定谁被认领。约定（规范 §1）：
 *   - 专属扩展高于通用驱动：qoder 20（aiti-qoder-agent，credits/listModels/区域路由）
 *       > CC 族原生 10（claude-code / codebuddy / cursor）
 *       > 通用 ACP 驱动 0（aiti-acp-agent，缺省不声明）；
 *   - 本测试静态扫描各扩展 index.ts 的 priority 声明钉死数值（改动须有意识 + 同步规范）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/provider-priority-contract.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 约定表：扩展 → 期望 priority（number = 必须显式声明；null = 不得声明（吃缺省 0））。 */
const EXPECTED = {
	"aiti-qoder-agent": 20,
	"aiti-claude-code-agent": 10,
	"aiti-codebuddy-agent": 10,
	"aiti-cursor-agent": 10,
	"aiti-acp-agent": null, // 通用驱动：永远让位（缺省 0）
};

function declaredPriorities(text) {
	const out = [];
	for (const [i, line] of text.split(/\r?\n/).entries()) {
		const t = line.trim();
		if (t.startsWith("//") || t.startsWith("*")) continue;
		const m = t.match(/priority:\s*(\d+)/);
		if (m) out.push({ value: Number(m[1]), line: i + 1 });
	}
	return out;
}

for (const [ext, expected] of Object.entries(EXPECTED)) {
	test(`[${ext}] provider priority 约定（D9）`, () => {
		const text = readFileSync(join(ROOT, ext, "index.ts"), "utf8");
		const declared = declaredPriorities(text);
		if (expected === null) {
			assert.equal(declared.length, 0, `${ext}: 通用驱动不声明 priority（吃缺省 0 让位专属扩展）；发现 ${JSON.stringify(declared)}`);
		} else {
			assert.ok(declared.length >= 1, `${ext}: 应声明 priority: ${expected}`);
			for (const d of declared) {
				assert.equal(d.value, expected, `${ext}:${d.line} priority=${d.value} ≠ 约定 ${expected}（改动须同步规范 §1 与 findProvidersForAgent 认领语义）`);
			}
		}
	});
}
