/**
 * plan-sandbox Linux 后端 E2E（不经 pi，直接驱动 provider）
 * 覆盖：start → bash 执行（新增/修改/删除/嵌套目录）→ 合并视图一致性 → delta → 部分采认 → 销毁
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-e2e-"));
const proj = path.join(base, "proj");
fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
fs.writeFileSync(path.join(proj, "a.txt"), "hello\n");
fs.writeFileSync(path.join(proj, "sub", "keep.txt"), "lower\n");
fs.writeFileSync(path.join(proj, "b.txt"), "to be deleted\n");

const p = new LinuxProvider();
const h = await p.start(proj);
console.log("tier:", h.tier);

// 1) bash 沙箱内执行：新增嵌套文件 / 修改 / 删除
const r1 = await p.bashExec(
	h,
	"mkdir -p src/deep && echo 'export const x=1' > src/deep/new.ts && echo changed >> a.txt && rm b.txt && echo BASH-OK",
	proj,
	{ timeoutSec: 120 },
);
if (r1.exitCode !== 0) throw new Error("E2E FAIL: bash exec failed");

// 2) 合并视图一致性（bash 产物必须对 read/ls/grep 可见）
const content = (await h.view.readFile(path.join(proj, "src/deep/new.ts"))).toString();
expect(content.includes("export const x"), "view.readFile sees bash-created file");
expect(!(await h.view.exists(path.join(proj, "b.txt"))), "whiteout honored (deleted file invisible)");
const walked: string[] = [];
await h.view.walk((_abs, rel) => walked.push(rel));
expect(walked.includes("src/deep/new.ts"), "view.walk sees new nested file (upper dir visible)");
expect(walked.includes("sub/keep.txt"), "view.walk sees lower file");

// 3) 宿主项目零变化
expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8") === "hello\n", "host a.txt untouched");
expect(fs.existsSync(path.join(proj, "b.txt")), "host b.txt untouched");
expect(!fs.existsSync(path.join(proj, "src")), "host has no src/");

// 4) delta
const d = await p.delta(h);
expect(d.added.includes("src/deep/new.ts"), `delta.added: ${JSON.stringify(d.added)}`);
expect(d.modified.includes("a.txt"), `delta.modified: ${JSON.stringify(d.modified)}`);
expect(d.deleted.includes("b.txt"), `delta.deleted: ${JSON.stringify(d.deleted)}`);

// 5) 部分采认：只采 new.ts，不采 a.txt 修改与 b.txt 删除
const report = await p.accept(h, ["src/deep/new.ts"], []);
expect(report.failed.length === 0, `accept failures: ${JSON.stringify(report.failed)}`);
expect(fs.readFileSync(path.join(proj, "src/deep/new.ts"), "utf8").includes("export const x"), "accepted file landed");
expect(fs.readFileSync(path.join(proj, "a.txt"), "utf8") === "hello\n", "unaccepted modification NOT landed");
expect(fs.existsSync(path.join(proj, "b.txt")), "unaccepted deletion NOT applied");

// 6) 显式采认删除
const report2 = await p.accept(h, [], ["b.txt"]);
expect(report2.deleted.includes("b.txt"), "deletion accepted");
expect(!fs.existsSync(path.join(proj, "b.txt")), "b.txt deleted in host");

// 7) 销毁
await p.destroy(h);
expect(!fs.existsSync(h.sandboxDir), "sandbox destroyed");

// 8) 第二轮：写工具宿主侧写入 upper 后 bash 可见（跨层一致性）
const h2 = await p.start(proj);
await h2.view.writeFile(path.join(proj, "from-write-tool.txt"), "via view\n");
const r2 = await p.bashExec(h2, "cat from-write-tool.txt", proj, { timeoutSec: 60 });
expect(r2.exitCode === 0, "bash sees write-tool output");
await p.destroy(h2);

fs.rmSync(base, { recursive: true, force: true });
console.log("E2E PASS ✓  (tier=" + h.tier + ")");
