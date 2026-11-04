#!/usr/bin/env node
/** aiti-plan-review · 部署到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/（client 由 client/src JSX 构建） */
import { copyFileSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// 先构建 JSX client（失败即中止；构建产物免 checker——TS 残留在源头不可能，model-check 同例）
import { spawnSync } from "node:child_process";
{
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "build-client.mjs")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const root = resolve(import.meta.dirname, "..");
// 宿主 loader 是否已支持 SDK alias（ea526b0 引入）：未支持时扩展仍需 node_modules 链接，
// 此时不清理（清理会让扩展解析不到 SDK 而加载失败）。
const wsRoot = resolve(root, "..", "..", "..");
const hostSupportsAlias = [resolve(wsRoot, "pi-web", "lib", "ext", "loader.ts"), resolve(wsRoot, "pi-prod", "lib", "ext", "loader.ts")]
	.some((p) => {
		try { return readFileSync(p, "utf8").includes('"@earendil-works/pi-coding-agent": hostSdkDir'); } catch { return false; }
	});
const targets = [
	resolve(homedir(), ".pi", "web", "extensions", "aiti-plan-review"),
	resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-plan-review"),
];
for (const extDir of targets) {
	mkdirSync(extDir, { recursive: true });
	for (const f of ["index.ts", "package.json"]) {
		copyFileSync(resolve(root, f), resolve(extDir, f));
		console.log("[deploy]", resolve(extDir, f));
	}
	mkdirSync(resolve(extDir, "dist"), { recursive: true });
	copyFileSync(resolve(root, "dist/aiti-plan-review-client.mjs"), resolve(extDir, "dist/aiti-plan-review-client.mjs"));
	// plan-sandbox 核心模块（pi-ext/plan-sandbox，无 pi 运行时依赖）→ lib/ 供 agent 注入工具使用
	mkdirSync(resolve(extDir, "lib"), { recursive: true });
	const psRoot = resolve(root, "..", "..", "pi-ext", "plan-sandbox");
	for (const f of ["providers.ts", "fsview.ts", "ops.ts", "mission.ts", "accept-core.ts"]) {
		copyFileSync(resolve(psRoot, f), resolve(extDir, "lib", f));
		console.log("[deploy]", resolve(extDir, "lib", f));
	}
	// 宿主依赖：pi-web lib/ext/loader.ts 用 jiti alias 把 @earendil-works/pi-coding-agent
	// 指到宿主 node_modules——扩展部署目录不再需要 node_modules 链接。
	// 仅当宿主 loader 已支持 alias 时才清理既往链接（旧宿主上清理会让扩展挂）。
	const nm = resolve(extDir, "node_modules");
	if (hostSupportsAlias) {
		try {
			if (lstatSync(nm).isSymbolicLink()) { unlinkSync(nm); console.log("[deploy] 已清理遗留链接:", nm); }
		} catch {
			try { rmdirSync(nm); } catch {} // junction 删除兜底（仅空目录，安全）
		}
	} else {
		console.log("[deploy] 宿主 loader 未含 SDK alias，保留 node_modules 链接（如存在）:", nm);
	}
	console.log("[deploy]", resolve(extDir, "dist/aiti-plan-review-client.mjs"));
}

// 部署状态 commit（无变更跳过；失败不阻断）——crash-rescue #9：纯 mjs 扩展也可回滚

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["inbox", "history"], { log: (m2) => console.log(m2) });
deployCommit({ repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-plan-review", paths: ["aiti-plan-review"], ident: true, log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。生效：POST /api/extensions/reload（或刷新页面）");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
