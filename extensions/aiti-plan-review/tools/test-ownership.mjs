/**
 * aiti-plan-review 所有权判定逻辑测试（修复回归：同 cwd 其他会话不得被劫持）
 * 从 index.ts 源码提取 latestSandboxFor/adoptSandbox/claimableStatus/baseDirs 实测，避免手抄漂移。
 * 运行：node tools/test-ownership.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SRC = path.resolve(import.meta.dirname, "../index.ts");
const src = fs.readFileSync(SRC, "utf8");

function extract(startMarker, endMarker, includeEnd = true) {
	const i = src.indexOf(startMarker);
	if (i < 0) throw new Error("marker not found: " + startMarker);
	const j = src.indexOf(endMarker, i);
	if (j < 0) throw new Error("end not found: " + endMarker);
	return src.slice(i, includeEnd ? j + endMarker.length : j);
}

const code = [
	extract("function baseDirs()", "return [...out].filter((d) => fs.existsSync(d));\n}"),
	extract("const ADOPT_MAX_AGE_MS", "/** 收养：", false),
	extract("function adoptSandbox", "\n}"),
].join("\n") + "\nexport { baseDirs, claimableStatus, latestSandboxFor, adoptSandbox, ADOPT_MAX_AGE_MS };";

// esbuild 剥 TS 类型 → 落盘 → 动态 import
const jsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "psb-test-")), "helpers.mjs");
const Prelude = 'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\n';
fs.writeFileSync(jsPath, execFileSync(
	path.resolve(import.meta.dirname, "../node_modules/.bin/esbuild"),
	["--loader=ts", "--format=esm"],
	{ input: Prelude + code },
));

// 隔离：XDG 指到临时目录；cwd 用真实系统不可能有的路径，避免扫到机器上真沙箱
const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "psb-xdg-"));
process.env.XDG_RUNTIME_DIR = xdg;
const CWD = "/nonexistent-psb-test-project";
const base = path.join(xdg, "plan-sandbox");

const m = await import(jsPath);

let n = 0;
const mkSandbox = (meta, review) => {
	const dir = path.join(base, `sb-${++n}-${Math.random().toString(36).slice(2, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
	if (review) fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(review));
	fs.mkdirSync(path.join(dir, "upper"), { recursive: true });
	return dir;
};

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? "✓" : "✗ FAIL"), name); };

// ── 场景 1：会话 A 开了 plan（meta 带 sessionId=A），老会话 B（同 cwd、早于沙箱出生）不得认领 ──
const sbA = mkSandbox({ provider: "linux", tier: "overlay", projectDir: CWD, sandboxDir: "/x", createdAt: Date.now() - 5000, sessionId: "A" });
t("1a 他人沙箱：老会话 B(adopt) 不认领", m.latestSandboxFor(CWD, { mode: "adopt", sid: "B", bornAt: Date.now() - 60000 }) === null);
t("1b 他人沙箱：own 模式 B 不认领", m.latestSandboxFor(CWD, { mode: "own", sid: "B" }) === null);
t("1c 他人沙箱：归属者 A own 认领", m.latestSandboxFor(CWD, { mode: "own", sid: "A" })?.sandboxDir === sbA);
t("1d 他人沙箱：归属者 A adopt 也认领（重启恢复）", m.latestSandboxFor(CWD, { mode: "adopt", sid: "A", bornAt: Date.now() - 60000 })?.sandboxDir === sbA);
t("1e 他人沙箱：unowned 模式不可见", m.latestSandboxFor(CWD, { mode: "unowned" }) === null);

// ── 场景 2：UI /new-plan 预建无主沙箱：新会话收养并写回归属；老会话不得收养 ──
const sbU = mkSandbox({ provider: "linux", tier: "overlay", projectDir: CWD, sandboxDir: "/y", createdAt: Date.now() - 1000 });
t("2a 无主沙箱：老会话(出生早于沙箱)不收养", m.latestSandboxFor(CWD, { mode: "adopt", sid: "OLD", bornAt: Date.now() - 60000 }) === null);
const got = m.latestSandboxFor(CWD, { mode: "adopt", sid: "NEW", bornAt: Date.now() });
t("2b 无主沙箱：年轻新会话可收养", got?.sandboxDir === sbU);
m.adoptSandbox(sbU, "NEW");
t("2c 收养后 meta 写回 sessionId=NEW", JSON.parse(fs.readFileSync(path.join(sbU, "meta.json"))).sessionId === "NEW");
t("2d 收养后其他会话（再新）也认领不走", m.latestSandboxFor(CWD, { mode: "adopt", sid: "NEW2", bornAt: Date.now() }) === null);
t("2e 收养后归属者仍可认领", m.latestSandboxFor(CWD, { mode: "adopt", sid: "NEW", bornAt: Date.now() })?.sandboxDir === sbU);
// 2f/g /reuse 强制覆盖归属（force=true）：显式重用 = 所有权转移，旧主放行新主接管（缺省 force=false 不覆盖）
m.adoptSandbox(sbU, "REUSER", true);
t("2f force 覆盖旧主归属 → REUSER", JSON.parse(fs.readFileSync(path.join(sbU, "meta.json"))).sessionId === "REUSER");
m.adoptSandbox(sbU, "OTHER");
t("2g 缺省不覆盖（无主才写）→ 仍 REUSER", JSON.parse(fs.readFileSync(path.join(sbU, "meta.json"))).sessionId === "REUSER");

// ── 场景 3：无主但超窗口（预建流程中断）→ 不静默收养 ──
mkSandbox({ provider: "linux", tier: "overlay", projectDir: CWD, sandboxDir: "/z", createdAt: Date.now() - 11 * 60_000 });
t("3a 超收养窗口的无主沙箱不被收养", m.latestSandboxFor(CWD, { mode: "adopt", sid: "NEW3", bornAt: Date.now() }) === null);
t("3b 超窗口无主沙箱 unowned 也不可见（/new-plan 会新建）", m.latestSandboxFor(CWD, { mode: "unowned" }) === null);

// ── 场景 4：pending（待采认）/kept 沙箱不可被自动认领（连归属者也不行，重用必须显式 /reuse）──
mkSandbox({ provider: "linux", tier: "overlay", projectDir: CWD, sandboxDir: "/w", createdAt: Date.now() - 100, sessionId: "P" }, { status: "pending" });
t("4a pending 沙箱：归属者 adopt 不认领", m.latestSandboxFor(CWD, { mode: "adopt", sid: "P", bornAt: Date.now() - 60000 }) === null);
mkSandbox({ provider: "linux", tier: "overlay", projectDir: CWD, sandboxDir: "/v", createdAt: Date.now() - 90, sessionId: "K" }, { status: "kept" });
t("4b kept 沙箱：归属者 own 不认领", m.latestSandboxFor(CWD, { mode: "own", sid: "K" }) === null);

// ── 场景 5：无 review.json（从未 declare）= 活跃可写态，归属者可认领 ──
const sb5 = mkSandbox({ provider: "linux", tier: "overlay", projectDir: CWD, sandboxDir: "/u", createdAt: Date.now() - 50, sessionId: "S5" });
t("5 无 review=活跃：归属者 own 认领", m.latestSandboxFor(CWD, { mode: "own", sid: "S5" })?.sandboxDir === sb5);

// ── 场景 6：claimableStatus 直接验证 ──
t("6a claimable: 无review=true", m.claimableStatus(sb5) === true);
const pd = fs.readdirSync(base).find((d) => {
	try { return JSON.parse(fs.readFileSync(path.join(base, d, "review.json"))).status === "pending"; } catch { return false; }
});
t("6b claimable: pending=false", m.claimableStatus(path.join(base, pd)) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
