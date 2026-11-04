#!/usr/bin/env node
/**
 * 扩展全局量灰名单检查（DI 方案 P3，docs/pi-web-ext-dependency-injection-plan.md §8-R1）
 *
 * 用法：node pi-web-ext/_shared/check-ext-globals.mjs [--strict]
 *   扫描 pi-web-ext/ 源码（排除 node_modules/ai-configs/构建产物）：
 *   1. 服务端 `__piWebExt.byId(...)` byId 穿透 / `featureValue|featureEnabled|setFeatureFlag` 直调
 *   2. 客户端 `window.__<Name>` / `globalThis.__<Name>` ad-hoc 全局
 * 已知量进灰名单（双轨兜底 / core 保留口 / 内部便道 / 框架聚合），**新出现的名字直接 FAIL**
 * ——红线：新增全局量一律拒绝（AGENTS.md 常见坑）。存量收敛进度见 DI 方案 §5 台账。
 * 已接入统一测试入口 scripts/test-web-ext.mjs（每次测试先跑，撞线整轮 FAIL）。
 * --strict：dualtrack 双轨兜底也计 FAIL（评估兜底退役进度用，默认不开）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");

/** ── 灰名单：已知且已文档化的全局量（DI 方案 §1.2 / §6 / 各扩展文档）────────
 *  分类：core-保留口（§6 豁免清单）/ dualtrack（P1/P2 迁移后的旧通道兜底，生产同步后退役）
 *  / internal（同扩展内部便道，收敛为模块内单例另行批次）/ framework（框架级聚合机制） */
const GRAY_CLIENT = new Map([
  // core 保留口（§6）
  ["__piPageEvents", "core-保留口"], ["__piPageEventsClient", "core-保留口（总线缺席兜底）"],
  ["__piWebPendingComposer", "core-保留口"], ["__runningEventsBroker", "core-保留口"],
  ["__PIBASE", "core-保留口"], ["__aitiTraceEmit", "core-保留口（pi 扩展生产者）"],
  ["__aitiInject", "core-保留口（middleware 跨 bundle）"],
  // P2 双轨兜底（生产同步后随兜底代码退役）
  ["__aitiModelCheckOpen", "dualtrack"], ["__aitiModelCheckApp", "dualtrack"],
  ["__aitiModelWizardOpen", "dualtrack"], ["__aitiModelWizardOpenTab", "dualtrack"],
  ["__aitiModelWizardViewParams", "dualtrack"], ["__aitiModelWizardCleanupEdit", "dualtrack"],
  ["__aitiHelperInvoke", "dualtrack"], ["__aitiSuggestAiFallback", "dualtrack"],
  ["__aitiAiScheduleOpen", "dualtrack"], ["__aitiGitReviewOpen", "dualtrack"], ["__aitiGitReviewWork", "dualtrack"],
  ["__aitiCmd", "dualtrack（aiti-cmd.open-session/open-shell 服务兜底）"],
  ["__piEventBus", "dualtrack（event-bus 客户端槽：materialize 竞态下 topic 订阅等待通道，待 onExtServiceChange 收敛）"],
  // 内部便道（同扩展自产自销；收敛为模块内单例另开批次，不阻断）
  ["__aitiEditor", "internal"], ["__aitiCpuMeter", "internal"], ["__speekScrollMode", "internal"],
  ["__speekListForHighlight", "internal"], ["__aitiDocCenterOpen", "internal"],
  ["__aitiAsrOpen", "internal"], ["__aitiConfigsOpen", "internal"], ["__aitiAppendSystemOpen", "internal"],
  ["__aitiGitTraceBanner", "internal"], ["__aitiGitTraceForkDialog", "internal"], ["__aitiGitTraceCtx", "internal"],
  ["__aitiEventBusDisposer", "internal（实例交接，draft-keeper 同款）"],
  ["__aitiCpuMeterOpts", "internal"], ["__AITI_AI_WIN__", "internal（AI 窗 window.open 名）"],
  ["__AitiCdpCore", "internal（devtools CDP 内核）"], ["__dbgLauncherInstalled", "internal（devtools dbg 家族）"],
  ["__aitiSuppressScroll", "internal"], ["__PIBASE__", "internal（basePath 便道）"],
  ["__AITI_FLOAT__", "internal（float 命名空间）"], ["__piweFloat", "internal"], ["__pfFrames", "internal（e2e 帧缓冲）"],
  ["__draftKeeperDisposer", "internal（实例交接）"], ["__aitiFolder", "internal"],
  ["__piFolderRevealLast", "internal"], ["__aitiSheetUniverApiUrl", "internal"],
  ["__aitiModelWizardViewParamsInternal", "internal"],
  ["__aitiVoiceInputL2", "internal（ai-input 语音 L2 单例）"],
  ["__aitiBridgeProbe", "internal（bridge-probe 自装幂等守卫）"],
  ["__dbgAiHostWin", "internal（devtools AI 窗 opener/parent 缓存）"],
]);
/** 框架级聚合（读全部扩展声明：configs.includes / schedules / ai.skills）——机制保留，另有治理计划 */
const GRAY_SERVER_AGG = ["aiti-configs", "aiti-ai-schedule", "aiti-helper"];

const SKIP_DIRS = new Set(["node_modules", "ai-configs", "templates", "sm-demo-source", "_shared", "shared", "demo", "demo-lazy"]);
/** 顶层只扫描真实扩展目录（排除备份/工具/共享目录） */
const TOP_SKIP = new Set(["ai-configs", "templates", "sm-demo-source", "_shared", "shared", "demo", "demo-lazy", "tools", "node_modules"]);
const SRC_EXT = /\.(ts|tsx|mjs)$/;

let HAS_SRC = false; // 当前扩展是否有 client/src（有则 client/*.mjs 视为构建产物跳过）
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (SRC_EXT.test(e.name)) yield p;
  }
}

const violations = [];
const knownHits = { client: 0, server: 0 };
const serverAggHits = new Map();

for (const extDir of readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && !TOP_SKIP.has(e.name)).map((e) => join(ROOT, e.name))) {
  const extId = extDir.split(sep).pop();
  try { HAS_SRC = statSync(join(extDir, "client", "src")).isDirectory(); } catch { HAS_SRC = false; }
  for (const file of walk(extDir)) {
    const rel = file.slice(ROOT.length + 1);
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    const isClient = /[\\/]client[\\/]/.test(rel);
    // 构建产物跳过（源码已扫描；产物里的压缩名/内部名不是新增来源）
    if (HAS_SRC && isClient && file.endsWith(".mjs") && !rel.includes("src")) continue;
    const lineOf = (idx) => src.slice(0, idx).split("\n").length;
    const lineAt = (re) => { const m = src.match(re); return m ? lineOf(m.index) : 0; };

    // 1) 服务端：byId 穿透 / feature 直调（排除注释行、兜底标注行）
    if (!isClient && file.endsWith(".ts")) {
      for (const m of src.matchAll(/byId\(/g)) {
        const line = src.slice(0, m.index).split("\n").pop() ?? "";
        const ctxWindow = src.slice(Math.max(0, m.index - 400), m.index + 200);
        if (/双轨|兜底|dualtrack|DI 方案|注释|\/\/.*byId|\.test\.|legacy/.test(line) || /双轨|兜底|dualtrack|DI 方案/.test(ctxWindow)) { knownHits.server++; continue; }
        violations.push(`[server byId] ${rel}:${lineOf(m.index)}  ${line.trim().slice(0, 100)}`);
      }
      for (const m of src.matchAll(/__piWebExt[^;]*?\.(featureValue|featureEnabled|setFeatureFlag|setFeatureValue)\s*\(/g)) {
        const line = src.slice(0, m.index).split("\n").pop() ?? "";
        if (/兜底|dualtrack|DI 方案|写路径|legacy/.test(line)) { knownHits.server++; continue; }
        violations.push(`[server feature 直调] ${rel}:${lineOf(m.index)}  ${line.trim().slice(0, 100)}`);
      }
    }

    // 2) 客户端：window/globalThis.__Name ad-hoc 全局
    if (isClient) {
      for (const m of src.matchAll(/(?:window|globalThis)\.__([A-Za-z][A-Za-z0-9_]*)/g)) {
        if (m[1].startsWith("piWeb")) { knownHits.client++; continue; } // core 平台全局（__piWeb* 命名收敛，§6）
        const name = "__" + m[1];
        const cat = GRAY_CLIENT.get(name);
        if (cat) {
          if (STRICT && cat.startsWith("dualtrack")) {
            violations.push(`[strict·dualtrack] ${rel}:${lineOf(m.index)}  ${name}（${cat}）`);
          } else {
            knownHits.client++;
          }
          continue;
        }
        violations.push(`[client 全局·未登记] ${rel}:${lineOf(m.index)}  ${name}（不在灰名单——新增全局一律拒绝；确需新增请先入文档并更新本脚本灰名单）`);
      }
      for (const m of src.matchAll(/(?:window|globalThis)\.__piWebExt\b/g)) {
        knownHits.client++;
      }
    }

    // 3) 框架聚合统计（豁免但可见）
    if (!isClient && GRAY_SERVER_AGG.includes(extId)) {
      const c = (src.match(/__piWebExt/g) ?? []).length;
      if (c) serverAggHits.set(rel, c);
    }
    void lineAt;
  }
}

console.log(`[globals] 灰名单命中：client=${knownHits.client} server(兜底注释行)=${knownHits.server}`);
if (serverAggHits.size) {
  console.log(`[globals] 框架聚合豁免（机制保留）：${[...serverAggHits.entries()].map(([f, c]) => `${f}×${c}`).join(", ")}`);
}
if (violations.length) {
  console.error(`\n[globals] ❌ ${violations.length} 处违规（新出现的 byId 穿透 / feature 直调 / 未登记全局）：`);
  for (const v of violations.slice(0, 40)) console.error("  " + v);
  if (violations.length > 40) console.error(`  …共 ${violations.length} 处`);
  process.exit(1);
}
console.log("[globals] ✅ 无新增违规。存量灰名单见 docs/pi-web-ext-dependency-injection-plan.md §5/§6。");
