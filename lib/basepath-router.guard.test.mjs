// basePath 导航护栏——钉死 2026-09-06「/dev 跳 /dev/dev」合并事故（上游 #630 回归）。
//
// 背景：Next 的 router.replace/push 会**自行再拼 basePath**。上游 #630 把
// `router.replace("/")` 改为 `router.replace(window.location.pathname)`（修他们的
// 反代加前缀拓扑），但在 basePath 烘进构建的部署（如 PI_WEB_BASE_PATH=/dev 的
// dev 实例）里，pathname 已含 `/dev`，replace 后变 `/dev/dev/`。
// 正确姿势：`inAppPathname()`（lib/base-path.ts）剥掉 basePath 再交还 router；
// 根部署透传 = 上游行为不变。
//
// 本护栏钉三件事：
//   ① 全仓禁止 router.replace/push 直接吃 window.location.*（必须走 inAppPathname）
//   ② next.config.ts 的 NEXT_PUBLIC_BASE_PATH 注入接线不被丢（丢了它，
//      getBasePath() 恒空 → inAppPathname 停止剥离 → 双拼静默复发）
//   ③ skipTrailingSlashRedirect: true 不被丢（丢了会把 /dev → /dev/ 规范重定向
//      变成 Next 内置 308 死循环，见 next.config 注释）
//
// 维护约定：特性有意重构时同步更新本文件并在提交信息注明 guard，禁止改测试迁就实现。
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

test("[basepath-guard] 禁止 router.replace/push 直接吃 window.location（必须走 inAppPathname）", () => {
  const offenders = [];
  for (const dir of ["components", "hooks", "lib", "app"]) {
    for (const file of listSources(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, "utf8");
      const re = /router\.(?:replace|push)\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const window_ = src.slice(m.index, m.index + 240);
        const loc = window_.search(/window\.location\.(pathname|href)|(?<![.\w])location\.(pathname|href)/);
        if (loc === -1) continue;
        // 跳过注释行（本文档类注释里就会写着反例）
        const absOffset = m.index + loc;
        const lineStart = src.lastIndexOf("\n", absOffset) + 1;
        const lineHead = src.slice(lineStart, absOffset).trimStart();
        if (lineHead.startsWith("//") || lineHead.startsWith("*") || lineHead.startsWith("/*")) continue;
        const line = src.slice(0, absOffset).split("\n").length;
        offenders.push(`${path.relative(ROOT, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], [
    "router.replace/push 直接使用 window.location.pathname/href 会在 basePath 部署下双拼前缀",
    "（/dev → /dev/dev，见上游 #630 回归）。改用 lib/base-path.ts 的 inAppPathname()。",
    "命中位置：",
    ...offenders,
  ].join("\n"));
});

test("[basepath-guard] next.config.ts 的 NEXT_PUBLIC_BASE_PATH 注入接线不被丢", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  assert.match(cfg, /NEXT_PUBLIC_BASE_PATH:\s*basePath/, [
    "next.config env 丢了 NEXT_PUBLIC_BASE_PATH 注入 → lib/base-path.ts 的 getBasePath()",
    "恒为空 → inAppPathname() 停止剥离 basePath → router 双拼静默复发（/dev/dev）。",
  ].join("\n"));
});

test("[basepath-guard] skipTrailingSlashRedirect: true 不被丢（防 /dev 规范重定向死循环）", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  assert.match(cfg, /skipTrailingSlashRedirect:\s*true/, [
    "Next 内置尾斜杠 308 对 basePath 根路径也生效且先于 middleware，",
    "会把 /dev → /dev/ 规范重定向变成死循环（见 next.config.ts 注释）。",
  ].join("\n"));
});

test("[basepath-guard] lib/base-path.ts 必须导出 inAppPathname", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "base-path.ts"), "utf8");
  assert.match(src, /export function inAppPathname/);
});
