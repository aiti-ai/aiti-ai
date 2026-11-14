/**
 * ext-entry-contracts.test.mjs —— 全量扩展入口契约巡检（覆盖所有官方扩展）。
 *
 * E2E 实测沉淀的回归闸门（2026-11-06）：
 *   1. package.json 必须声明 aitiExtProtocol（协议红线，全仓校验的仓库内等价断言）；
 *   2. registerItems/registerItems?. 调用的插槽名必须是宿主 ExtSlotName 联合的合法成员
 *      （拼错插槽 = 条目永远不渲染 = 死入口）；
 *   3. registerItems 引用的 feature 必须在扩展 features 声明里存在（引用不存在的
 *      feature id = 条目被永远隐藏的死卡——aiti-app-center feature-gate 过滤按此口径）；
 *   4. index.ts 静态 ui 声明的插槽键同样是合法插槽名；
 *   5. 镜像脚本排除契约：__pycache__/*.pyc 必须在 sync 脚本排除集内
 *      （文件系统拷贝绕过 gitignore 的泄露回归，见 sync 脚本 fix c6e38ac0）。
 *
 * Run: node --test pi-web-ext/_shared/ext-entry-contracts.test.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const workRoot = join(extRoot, "..");

/** 宿主 ExtSlotName 联合镜像（pi-web lib/ext/types.ts；扩宿主插槽时同步此处）。 */
const VALID_SLOTS = new Set([
  "toolbar", "sidebar", "sidebarFooter", "sessionTopbar", "sessionRowActions",
  "sessionRowLeading", "sessionRowMeta", "sidebarProjects", "sidebarContent",
  "dialogs", "banners", "pages", "chatInputTop", "chatOverlay",
  "userMessageActions", "assistantMessageActions", "assistantMessageFooter",
  "fileViewer", "pathPicker", "newSessionBackendOptions", "sessionStats",
  "composerTools", "queuePanel", "recoveryDialog", "workspacePickerActions",
  "newSessionContextTrailing", "modelSelector", "modelSelectorFooter",
  "settingsModels", "settingsAgentsFeature", "settingsAgents", "terminalDock",
  "sidebarExplorerDock", "rightFileDock", "sidebarTasks", "composerAffix",
  "modelInfoLead", "compactLead", "sessionRequestCard", "newSessionSelectors",
  "newSessionPreparers", "newSessionWidgets",
  "noWorkspaceGuide",  // v3 新增：fresh 首屏整页引导替换槽（AppShell 消费；aiti-quickstart 首用）
  // 跨 bundle 生态槽：宿主 ExtSlotName 类型联合未收录（types 缺口，运行时字符串键注册表不受影响），
  // 消费方 = aiti-model-wizard 的会话信息聚合（getExtUiItems 跨 bundle 读）。见 aiti-provider-usage。
  "sessionInfoPanel",
]);

function listExts() {
  // 并发套件里 sync-mirror 测试会临时创建/删除夹具扩展目录——ENOENT 视为已消失，跳过
  const dirs = readdirSync(extRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "_shared" && e.name !== "node_modules")
    .map((e) => e.name);
  return dirs.filter((n) => {
    try { return existsSync(join(extRoot, n, "package.json")); } catch { return false; }
  });
}

function* clientFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // assets/ + chunk-*.mjs = vite 构建产物（vendor 库内部 feature: 字符串会
      // 造成契约扫描假阳性）——契约检查只看手写源码
      if (e.name === "node_modules" || e.name === "dist" || e.name === "vendor" || e.name === "assets") continue;
      yield* clientFiles(p);
    } else if (/\.(tsx?|js|mjs)$/.test(e.name) && !/\.test\.(mjs|js)$/.test(e.name) && !/\.min\.(js|mjs)$/.test(e.name) && !/-chunk-[A-Za-z0-9_-]+\.mjs$/.test(e.name)) {
      // -chunk-<hash>.mjs = vite 构建产物（vendor 库内部的 feature: 字符串会造成
      // 契约扫描假阳性）——契约检查只看手写源码
      yield p;
    }
  }
}

test("每个官方扩展的 package.json 声明 aitiExtProtocol", () => {
  const bad = [];
  for (const name of listExts()) {
    const pkg = JSON.parse(readFileSync(join(extRoot, name, "package.json"), "utf8"));
    if (!/^1\.\d+$/.test(String(pkg.aitiExtProtocol ?? ""))) bad.push(`${name}: ${pkg.aitiExtProtocol ?? "缺失"}`);
  }
  assert.deepEqual(bad, [], "缺少/非法 aitiExtProtocol 的扩展");
});

test("registerItems 插槽名全部合法（拼错 = 死入口）", () => {
  const bad = [];
  for (const name of listExts()) {
    const dir = join(extRoot, name);
    for (const f of clientFiles(dir)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bregisterItems\b[\s\S]{0,40}?\(\s*["'`]([a-zA-Z]+)["'`]/g)) {
        if (!VALID_SLOTS.has(m[1])) bad.push(`${name} (${f.split("pi-web-ext/")[1]}): "${m[1]}"`);
      }
    }
  }
  assert.deepEqual(bad, [], "引用了不存在插槽的 registerItems 调用");
});

test("registerItems 引用的 feature 必须在 features 声明里存在", () => {
  const bad = [];
  for (const name of listExts()) {
    const dir = join(extRoot, name);
    const indexSrc = existsSync(join(dir, "index.ts")) ? readFileSync(join(dir, "index.ts"), "utf8") : "";
    const declared = new Set([...indexSrc.matchAll(/\{\s*id:\s*["'`]([a-zA-Z0-9._-]+)["'`]/g)].map((m) => m[1]));
    for (const f of clientFiles(dir)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bfeature:\s*["'`]([a-zA-Z0-9._-]+)["'`]/g)) {
        if (!declared.has(m[1])) bad.push(`${name}: feature "${m[1]}"（${f.split("pi-web-ext/")[1]}）不在 features 声明`);
      }
    }
  }
  assert.deepEqual(bad, [], "引用了未声明 feature 的条目");
});

test("index.ts 静态 ui 声明的插槽键全部合法", () => {
  const bad = [];
  for (const name of listExts()) {
    const indexSrc = existsSync(join(extRoot, name, "index.ts")) ? readFileSync(join(extRoot, name, "index.ts"), "utf8") : null;
    if (!indexSrc) continue;
    // Scan only the top-level ui: { ... } block — a whole-file 4-space sweep also hits
    // same-named keys inside agent tool declarations (session_search's promptGuidelines:
    // [...] was flagged as an unknown slot, 2026-11-11)
    const uiBlock = indexSrc.match(/^  ui: \{([\s\S]*?)\n  \},/m)?.[1] ?? "";
    // Non-slot metadata keys inside the ui block (the host's registerDeclaredSlots
    // declares them with no consumer; ai-helper aggregation reads them):
    // i18n/provides/clientDependsOn/clientImmediately are host-filtered whitelist,
    // helpers is aiti-helper aggregation metadata
    const UI_META_KEYS = new Set(["i18n", "provides", "clientDependsOn", "clientImmediately", "helpers"]);
    for (const m of uiBlock.matchAll(/^ {4}([a-zA-Z]+): \[$/gm)) {
      if (!VALID_SLOTS.has(m[1]) && !UI_META_KEYS.has(m[1])) bad.push(`${name}: ui.${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], "静态 ui 声明使用了未知插槽键");
});

test("镜像脚本排除契约：__pycache__/.pyc 在 sync 排除集内", () => {
  const src = readFileSync(join(workRoot, "scripts", "sync-extensions-to-aiti-ai.mjs"), "utf8");
  assert.match(src, /EXCLUDE_NAMES = new Set\([^\)]*__pycache__/, "EXCLUDE_NAMES 缺 __pycache__");
  assert.match(src, /EXCLUDE_SUFFIX = \[[^\]]*"\.pyc"/, "EXCLUDE_SUFFIX 缺 .pyc");
});
