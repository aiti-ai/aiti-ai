/**
 * provider-priority-contract — claim-order convention assertions for a shared agentKey (debt D9 regression guard).
 *
 * pi-web's `findProvidersForAgent` (lib/session/providers.ts) sorts by `priority ?? 0` descending —
 * when several providers share an agentKey, the number decides who gets claimed. Convention (spec §1):
 *   - dedicated extensions above generic drivers: qoder 20 (aiti-qoder-agent, credits/listModels/region routing)
 *       > CC-family native 10 (claude-code / codebuddy / cursor)
 *       > generic ACP driver 0 (aiti-acp-agent, declares nothing by default);
 *   - this test statically scans each extension's index.ts priority declarations and pins the numbers
 *     (changes must be conscious + synced with the spec).
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/provider-priority-contract.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Convention table: extension → expected priority (number = must declare explicitly;
 *  null = must not declare, eats the default 0); object = per-agentKey whitelist
 *  (only the listed driver may declare; all others stay declaration-free). */
const EXPECTED = {
	"aiti-qoder-agent": 20,
	"aiti-claude-code-agent": 10,
	"aiti-codebuddy-agent": 10,
	"aiti-cursor-agent": 10,
	// Generic drivers stay declaration-free by default; sole exception: the cursor ACP
	// native-server resident process (conscious decision 2026-11-26: 20 beats the CC-family
	// print backend's 10 so new/takeover cursor sessions default to RPC, print is fallback).
	"aiti-acp-agent": { "cursor": 20 },
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
	test(`[${ext}] provider priority convention (D9)`, () => {
		const text = readFileSync(join(ROOT, ext, "index.ts"), "utf8");
		const declared = declaredPriorities(text);
		if (expected === null) {
			assert.equal(declared.length, 0, `${ext}: generic drivers declare no priority (take the default 0, yielding to dedicated extensions); found ${JSON.stringify(declared)}`);
		} else if (typeof expected === "number") {
			assert.ok(declared.length >= 1, `${ext}: should declare priority: ${expected}`);
			for (const d of declared) {
				assert.equal(d.value, expected, `${ext}:${d.line} priority=${d.value} != convention ${expected} (changes must sync spec §1 and findProvidersForAgent's claim semantics)`);
			}
		} else {
			const whitelist = expected;
			const lineOf = (text.split(/\r?\n/).findIndex((l) => /agentKey:\s*"([^"]+)"/.test(l) && new RegExp(`agentKey:\\s*"cursor"`).test(l)));
			assert.ok(lineOf >= 0, `${ext}: no driver declaration found for a whitelisted agentKey`);
			assert.deepEqual(declared, [{ value: whitelist.cursor, line: lineOf + 1 }],
				`${ext}: only whitelisted drivers may declare a priority (found ${JSON.stringify(declared)})`);
		}
	});
}
