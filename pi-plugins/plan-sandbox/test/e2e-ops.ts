/**
 * ops 层 E2E：MergedView 之上的 read/write/edit/ls/find/grep（此前零覆盖的 ~150 行）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LinuxProvider } from "../providers.ts";
import { buildFindOps, buildLsOps, buildReadOps, buildWriteOps, buildEditOps, executeGrep } from "../ops.ts";

function expect(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`OPS-E2E FAIL: ${msg}`);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), "psb-ops-"));
fs.mkdirSync(path.join(base, "proj", "src", "deep"), { recursive: true });
const proj = fs.realpathSync(path.join(base, "proj"));
fs.writeFileSync(path.join(proj, "src", "a.ts"), "const alpha = 1;\n");
fs.writeFileSync(path.join(proj, "src", "deep", "b.ts"), "const beta = 2;\nconst alphaEcho = beta;\n");
fs.writeFileSync(path.join(proj, "README.md"), "# t\n");

const p = new LinuxProvider();
const h = await p.start(proj);

// bash 在沙箱内产生增量：新文件 / 修改 / 目录
await p.bashExec(h, "echo 'const gamma = 3;' > src/gamma.ts && mkdir -p gen && echo generated > gen/out.txt && echo appended >> src/a.ts", proj, { timeoutSec: 60 });

const readOps = buildReadOps(h);
const writeOps = buildWriteOps(h);
const editOps = buildEditOps(h);
const lsOps = buildLsOps(h);
const findOps = buildFindOps(h);

// 1) read：bash 产物可见（合并视图）
const gamma = (await readOps.readFile(path.join(proj, "src/gamma.ts"))).toString();
expect(gamma.includes("gamma = 3"), "read sees bash-created file");

// 2) write：写入 upper，bash 可见（跨层一致性）
await writeOps.writeFile(path.join(proj, "src/from-write.ts"), "const w = 1;\n");
expect(fs.existsSync(path.join(h.sandboxDir, "upper", "src", "from-write.ts")), "write landed in upper");

// 3) ls：readdir 合并（upper 新目录 + lower 文件）
const srcEntries = await lsOps.readdir(path.join(proj, "src"));
const names = srcEntries.map((e) => e.name).sort();
expect(names.includes("gamma.ts") && names.includes("a.ts") && names.includes("deep") && names.includes("from-write.ts"), `ls union: ${JSON.stringify(names)}`);
expect((await lsOps.stat(path.join(proj, "src"))).isDirectory(), "stat directory");

// 4) find：glob 覆盖 upper+lower，跳过 node_modules/.git
const tsFiles = await findOps.glob("**/*.ts", proj, { limit: 100 });
const rels = tsFiles.map((a) => path.relative(proj, a).split(path.sep).join("/")).sort();
expect(rels.includes("src/gamma.ts"), `find upper file: ${JSON.stringify(rels)}`);
expect(rels.includes("src/deep/b.ts"), "find lower nested file");
expect(rels.includes("src/from-write.ts"), "find write-tool file");

// 5) grep：增量+基线都能搜到，带上下文
const g = await executeGrep(h, { pattern: "alpha", path: "src", limit: 100 });
const text = g.content[0]!.text as string;
expect(text.startsWith("a.ts:1:"), `grep lower hit with path:line (pi convention, rel to search root): ${text}`);
expect(text.includes("alphaEcho"), "grep lower nested file");

const g2 = await executeGrep(h, { pattern: "gamma", path: "src", limit: 100 });
expect(g2.content[0]!.text.startsWith("gamma.ts:1:"), `grep upper hit: ${g2.content[0]!.text}`);

// 6) edit ops：读合并 + 写 upper
await editOps.writeFile(path.join(proj, "src/a.ts"), (await editOps.readFile(path.join(proj, "src/a.ts"))).toString() + "// edited\n");
expect((await readOps.readFile(path.join(proj, "src/a.ts"))).toString().includes("// edited"), "edit writeFile roundtrip");

// 7) 越界写被拒
let blocked = false;
try {
	await writeOps.writeFile("/tmp/psb-ops-escape.txt", "nope");
} catch {
	blocked = true;
}
expect(blocked, "write outside project blocked");

// 8) 视图外读直通真实 fs（只读无害）
expect((await readOps.readFile("/etc/hostname")).length > 0, "outside read passthrough");

await p.destroy(h);
fs.rmSync(base, { recursive: true, force: true });
console.log("OPS-E2E PASS ✓");
