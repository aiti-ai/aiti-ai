/**
 * shared-copy-sync — consistency checks between the shared layer's "authoritative source <-> extension
 * copies" (debt list D7).
 *
 * Background: shared implementation layers such as backend-queue.ts / agent-spawn-env.ts were
 * distributed to the agent extension directories as manual copies (deployed by copying with the
 * extension) with no sync script — a copy-side change without write-back to the authority (or vice
 * versa) drifts silently; D1's missing-capture bug once existed in every copy at the same time.
 *
 * Check strategy:
 *   1. Whole-file copies: any same-named copy found in the repo must be byte-identical to the _shared authority;
 *   2. external-governance.ts (copy file name) <-> external-cli-governance.ts (authority):
 *      each copy is a per-extension trimmed subset (keeping only its own CLI allowlist section); verify
 *      "copy non-comment lines are a subset of the authority's line set" — catches logic changes without
 *      write-back; trimming is allowed.
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

/** Whole-file copies (same file name; authority at _shared/<name>). */
const EXACT_COPIES = [
	"backend-queue.ts",
	"agent-spawn-env.ts",
	"ext-model-state.ts",
	"controlled-login.mjs",
	"cbc-model-catalog.ts",
	"cursor-cli-store.ts", // copies also existed under session-manager/lib/agents/ (covered by the repo-wide find)
	"session-recycle.ts", // D8: the acp/qoder/pi/attach copies
	"exec-async.ts", // execSync->async rework (2026-09-12): git-trace/git-review/channels/editor/agents/cmd/session-manager copies
	"agent-accounts.ts", // account-profile engine (2026-09-13): the aiti-agent-manager copy
];

/** Trimmed subset copies: copy file name -> authority file name. */
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

/** Non-comment/non-empty lines (trimmed), used for the subset comparison. */
function codeLines(text) {
	return text.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
}

test("whole-file shared copies are byte-identical with the authoritative source (D7)", () => {
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
		// After M2a (2026-09-16) the copies were retired in favor of @aiti-ai/ext-shared package imports:
		// zero copies is fine; should a same-named copy appear again (a new extension hand-copying), it is
		// still forced to be byte-identical with the authority — the anti-drift guard is kept.
		for (const copy of copies) {
			const same = readFileSync(copy).equals(authBuf);
			if (!same) {
				problems.push(`副本漂移: ${relative(ROOT, copy)} ≠ _shared/${name} —— 以权威源为准同步（副本侧改动须先回写 _shared）`);
			}
		}
	}
	assert.deepEqual(problems, [], `\n${problems.join("\n")}`);
});

test("external-governance copies are a line-level subset of the authority (external-cli-governance) (D7)", () => {
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
