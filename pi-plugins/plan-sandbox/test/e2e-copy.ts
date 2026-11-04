/**
 * copy 档 E2E（强制降级路径）+ diffByCompare（无 git fallback）+ 归一化/校验单测
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { LinuxProvider } from "../providers.ts";
import { manifestIssues, normalizeDeliverableRel, type DeliverableManifest } from "../protocol.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`COPY-E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-copy-"));
const proj = path.join(base, "proj");
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");

// 带 git（copy 档 delta 首选）
execSync(`git init -q -b main && git config user.email t@t && git config user.name t && git add -A && git commit -qm init`, { cwd: proj });

const p = new LinuxProvider();
const h = await p.start(proj, "copy"); // 强制 copy 档
console.log("tier:", h.tier);
expect(h.tier === "copy", "forced copy tier");

// bash 无防护档：写快照
const r = await p.bashExec(h, "echo changed >> a.txt && echo new > n.txt && rm -f nothing-missing", proj, { timeoutSec: 60 });
if (r.exitCode !== 0) throw new Error("bash failed");

// 快照内可见、宿主不可见
expect(fs.readFileSync(path.join(h.extra.snapshotDir, "n.txt"), "utf8").includes("new"), "snapshot has n.txt");
expect(!fs.existsSync(path.join(proj, "n.txt")), "host untouched");

// delta（git 路径）
const d = await p.delta(h);
expect(d.modified.includes("a.txt"), `git delta modified: ${JSON.stringify(d)}`);
expect(d.added.includes("n.txt"), "git delta added");

// accept
const rep = await p.accept(h, ["n.txt"], []);
expect(rep.copied.includes("n.txt") && rep.failed.length === 0, `accept: ${JSON.stringify(rep)}`);
expect(fs.existsSync(path.join(proj, "n.txt")), "n.txt landed");
expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8") === "hello\n", "a.txt not accepted");
await p.destroy(h);
expect(!fs.existsSync(h.sandboxDir), "destroyed");

// ---- 无 git fallback：diffByCompare ----
const proj2 = path.join(base, "proj-nogit");
fs.mkdirSync(proj2, { recursive: true });
fs.writeFileSync(path.join(proj2, "x.txt"), "x\n");
const h2 = await p.start(proj2, "copy");
// 删掉快照里的 .git（模拟无 git 项目）
fs.rmSync(path.join(h2.extra.snapshotDir, ".git"), { recursive: true, force: true });
fs.writeFileSync(path.join(proj2, "x.txt"), "x\nCHANGED\n");
fs.writeFileSync(path.join(h2.extra.snapshotDir, "y.txt"), "y\n");
const d2 = await p.delta(h2);
expect(d2.modified.includes("x.txt"), `compare modified: ${JSON.stringify(d2)}`);
expect(d2.added.includes("y.txt"), "compare added");
await p.destroy(h2);

// ---- 归一化 + 校验单测 ----
expect(normalizeDeliverableRel("./src/a.ts", proj) === "src/a.ts", "normalize ./");
expect(normalizeDeliverableRel(path.join(proj, "src\\a.ts"), proj) === "src/a.ts", "normalize abs+backslash");
expect(normalizeDeliverableRel("../escape", proj) === null, "normalize escape");
const deltaFake = { added: ["src/a.ts"], modified: [], deleted: ["old.txt"] };
const m: DeliverableManifest = { files: ["./src/a.ts", "missing.ts"], deletions: ["old.txt"], summary: "", ts: 0, baseHashes: { "src/a.ts": "sha256:x", "missing.ts": null, "old.txt": "sha256:y" }, baseTs: 1 };
const issues = manifestIssues(deltaFake, m, proj);
expect(m.files[0] === "src/a.ts", "manifest normalized in place");
expect(issues.length === 1 && issues[0].includes("missing.ts"), `issues: ${JSON.stringify(issues)}`);
const ok = manifestIssues(deltaFake, { files: ["src/a.ts"], deletions: ["old.txt"], summary: "", ts: 0, baseHashes: { "src/a.ts": "sha256:x", "old.txt": "sha256:y" }, baseTs: 1 }, proj);
expect(ok.length === 0, `clean manifest should pass: ${JSON.stringify(ok)}`);
// 基线指纹缺失/覆盖不全 = manifest 不合法（fail-loud，无降级）
const noHash = manifestIssues(deltaFake, { files: ["src/a.ts"], deletions: [], summary: "", ts: 0, baseHashes: {}, baseTs: 1 } as DeliverableManifest, proj);
expect(noHash.some((s) => s.includes("baseHashes")), `missing fingerprint refused: ${JSON.stringify(noHash)}`);
const noField = manifestIssues(deltaFake, { files: ["src/a.ts"], deletions: [], summary: "", ts: 0 } as any, proj);
expect(noField.some((s) => s.includes("baseHashes")), `absent fingerprint refused: ${JSON.stringify(noField)}`);

fs.rmSync(base, { recursive: true, force: true });
console.log("COPY-E2E PASS ✓");
