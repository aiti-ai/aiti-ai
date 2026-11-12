/**
 * aiti-configs · pi-web 配置版本化 + 崩溃自检扩展（M4 独立化）
 *
 * 设计：docs/aiti-configs-extension-plan.md
 * 能力：
 *   - 注册制 includes：扩展声明 configs.includes 即被版本化（globalThis.__piWebExt 聚合）
 *   - MCP 工具（server.agent 进程内注入）：configs_status / configs_commit / configs_restore / configs_selfcheck
 *   - 安全盾网页 UI（🛡）：版本历史 / diff 预览 / 一键恢复 / 自检报告 / 仪表盘
 *   - API：status / commit / restore / selfcheck / log / diff / config
 *   - watchdog CLI 复用 core.cjs（同份逻辑，命令行兜底）
 */
import { existsSync } from "node:fs";
import { join as pathJoin } from "node:path";
const core = require("./core.cjs");

let configDir = ""; // 扩展配置区（startup 注入；loadConfig 迁移旧配置时作 legacyDir 传参）
let cacheDir = "";  // 扩展缓存区（sentry.jsonl / .stale-at 等运行态；数据分层：可删重建）
let cfg: any = null;
let lastSentryFp = ""; // 指纹防抖：同指纹不重复通知
let sentryTimer: any = null; // 兼容旧 shutdown 引用（哨兵已改由 schedule 驱动，此处不再自建 timer）

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const getCtx = () => ({ configDir, cacheDir, registry: (globalThis as any).__piWebExt });

function reloadCfg() {
  cfg = core.loadConfig(configDir || undefined);
  if (!existsSync(cfg._file)) {
    // 首次：落一个默认配置模板（含系统级 includes + 分层兜底 excludes），AI 可编辑
    try {
      const fsm = require("node:fs");
      const fspath = require("node:path");
      fsm.mkdirSync(configDir, { recursive: true });
      // _file lives outside configDir (self-config dir ~/.pi/configs-self) — create its parent too,
      // otherwise first launch fails with ENOENT when the self dir does not exist yet
      fsm.mkdirSync(fspath.dirname(cfg._file), { recursive: true });
      fsm.writeFileSync(cfg._file, JSON.stringify({
        // 搬仓重构（§4.1）：备份仓 ~/.pi/configs（新起历史）；自身配置经 configs-self include 防自丢
        repo: "~/.pi/configs",
        branch: "main",
        identity: { name: "aiti-ai", email: "ai@aiti.local" },
        includes: [
          // 黑名单制：目录级通配全量收，用户扩展/配置自动受保护（分层后 cache/ 由 excludes 兜底剔除）
          { path: "~/.pi/agent/**", dest: "pi/agent/" },
          { path: "~/.pi/pi-session-manager/**", dest: "pi/pi-session-manager/" },
          { path: "~/.pi/service-tunnels/**", dest: "pi/service-tunnels/" },
          { path: "~/.pi/mcp-profiles/**", dest: "pi/mcp-profiles/" },
          { path: "~/.pi/web/**", dest: "web/" },
          { path: "~/.pi/configs-self/**", dest: "self/" },
        ],
        // 黑名单制排除：dev 实例整体忽略 + 分层兜底（cache/venv/ops/state/运行态）+ 可重建物/下载物
        excludes: ["**/web-dev/**",
          "**/cache/**", "**/venv/**", "**/*-venv/**", "**/recordings/**",
          "**/ops/**", "**/state/**", "**/runtime/**", "**/bin/**", "**/instances/**", "**/acp/**",
          "**/novnc/**", "**/grdpwasm/**", "**/tts-cache/**", "**/webRDP/**", "**/view-common/**",
          "**/missions/projects/**", "**/ext-agents/**",
          "**/*-relay-state.json",
          "**/*.sock",
          "**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.vite/**", "**/.turbo/**", "**/__pycache__/**", "**/target/**", "**/.gradle/**", "**/.cache/**",
          "**/*.db", "**/*.db-wal", "**/*.db-shm", "**/*.sqlite", "**/*.sqlite3", "**/*-wal", "**/*-shm",
          "**/*.zip", "**/*.tar", "**/*.gz", "**/*.tgz", "**/*.7z", "**/*.rar", "**/*.wasm", "**/*.pwarc", "**/monaco/**", "**/bin/cc-connect", "**/*.pack",
          "**/sessions/**", "**/*.jsonl", "**/logs/**", "**/tmp/**", "**/*.log", "**/tool-output-artifacts/**", "**/missions/index/**", "**/model-usage/**", "**/*.bak*", "**/mcp-cache.json", "**/*-cache.json", "**/run-history.jsonl",
          "**/*-dev/**"],
        // 涉密名单：黑名单制——加密 or 阻断，绝不排除（auth.json 不再被丢）
        hardExcludes: ["**/.git/**", "**/.aiti-trace/**"],
        protected: ["**/auth.json", "**/*token*", "**/credentials*", "**/*.key", "**/*.pem", "**/*.p12", "**/*.jks", "**/*.asc", "**/.configs-key", "**/bridge-registry.json"],
        sizeLimitKB: 2048,
        commit: { mode: "smart", batch: 20, template: "chore(configs): {{summary}}", scopes: ["pi-agent", "aiti-cmd", "aiti-prompts", "aiti-extman", "ai-helper", "ai-created", "aiti-configs", "web"] },
        watch: false,
        sentry: { enabled: false, intervalSec: 60, bridgeUrl: null, fingerprints: [] },
        remote: { url: "", branch: "", push: false, autoPull: true }, // 远端同步（配置 url + push=true 启用；commit 后 pull --rebase → push）
        encrypt: { enabled: false, algo: "aes-256-gcm", keyFile: "", patterns: ["pi/agent/auth.json", "pi/agent/models.json", "pi/agent/models-store.json", "pi/pi-session-manager/auth_tokens.json", "pi/service-tunnels/*.json"] }, // 按文件粒度加密
      }, null, 2) + "\n");
      console.log("[aiti-configs] 已写默认配置：" + cfg._file);
    } catch (e) { console.warn("[aiti-configs] 写默认配置失败", e); }
  }
  return cfg;
}

// 哨兵启停：改由 aiti-ai-schedule 扩展聚合的定时任务驱动（schedules: configs-sentry 每 60s 跑），
// 不再自建 setInterval——不重复造调度器；configs 配置 sentry.enabled 仍控制是否动作（任务 run 内部判断）
function syncSentry() {} // 保留调用点（startup//config POST），实际启停交给 schedule 任务 run
// 深合并配置片段：嵌套对象段（encrypt/remote/identity/commit/sentry）合并而非整段覆盖（防 patterns 等被丢）
function mergeSet(base: any, patch: any): any {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...pv };
    } else {
      out[k] = pv;
    }
  }
  return out;
}

// 哨兵：命中崩溃指纹写 cacheDir/sentry.jsonl（watchdog/selfcheck/AI 可读）
function logSentry(kind: string, detail: string, sc: any) {
  try {
    const fsm = require("node:fs");
    fsm.mkdirSync(pathJoin(cacheDir), { recursive: true });
    fsm.appendFileSync(pathJoin(cacheDir, "sentry.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), kind, detail, selfcheck: sc ? { ok: sc.ok, bad: (sc.bad || []).map((b: any) => b.name) } : undefined }) + "\n");
  } catch (e) {}
}

// 远端同步结果通知：冲突/失败写 sentry.jsonl + console.warn（成功后不打扰）
function notifySync(sync: any) {
  if (!sync || sync.ok || sync.skipped) return;
  const kind = sync.conflict ? "PUSH_CONFLICT" : "PUSH_FAIL";
  const detail = (sync.conflict ? "远端同步 rebase 冲突（需手动处理 rebase 状态）" : "远端同步失败") + "：" + (sync.error || "");
  console.error("[aiti-configs·同步] ❌ " + detail);
  logSentry(kind, detail, null);
}

// 密文 commit 状态（不返回密钥内容）
function encryptStatus(c: any) {
  const en = c.encrypt || {};
  const kf = core.expandPath(en.keyFile || core.defaultKeyFile(c, getCtx()), getCtx());
  const fsm = require("node:fs");
  return { enabled: !!en.enabled, algo: en.algo || "aes-256-gcm", keyFile: kf, keyExists: kf ? fsm.existsSync(kf) : false, patterns: en.patterns || [] };
}

// 哨兵 tick：selfcheck 指纹 + 可选桥无应答检测 → 通知（防抖：指纹变化才报）
async function sentryTick(): Promise<void> {
  try {
    const c = reloadCfg();
    if (!c.sentry || !c.sentry.enabled) return;
    const d = await core.detectCrash(c, getCtx());
    const hits: any[] = d.hits;
    // 可选：桥端口无应答（sentry.bridgeUrl，如 http://127.0.0.1:8777/aiti/bridge/sessions）
    if (c.sentry.bridgeUrl) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 2000);
        const r = await fetch(c.sentry.bridgeUrl, { signal: ctrl.signal, cache: "no-store" });
        clearTimeout(to);
        if (!r.ok) hits.push({ name: "桥无应答", detail: c.sentry.bridgeUrl + " → " + r.status, level: "bridge" });
      } catch (e: any) {
        hits.push({ name: "桥无应答", detail: String((e && e.message) || e).slice(0, 80), level: "bridge" });
      }
    }
    const fp = hits.map((h) => h.name).sort().join(",") || "ok";
    if (hits.length === 0) {
      if (lastSentryFp && lastSentryFp !== "ok") logSentry("RECOVER", "崩溃指纹恢复：之前 " + lastSentryFp, d.selfcheck);
      lastSentryFp = "ok";
      return;
    }
    if (lastSentryFp === fp) return; // 同指纹防抖
    lastSentryFp = fp;
    const detail = hits.map((h) => h.name + "(" + h.detail + ")").join("; ");
    console.error("[aiti-configs·哨兵] ❌ 命中崩溃指纹：" + detail);
    logSentry("HIT", detail, d.selfcheck);
  } catch (e: any) {
    console.error("[aiti-configs·哨兵] ❌ 崩溃检测异常:", e);
  }
}

// ---- 定时任务 run（注册给 aiti-ai-schedule 聚合执行；不再自建 setInterval——不重复造调度器） ----
// ctx = { configDir, cacheDir, extId, scheduleId }（aiti-ai-schedule 传入）

// 任务 1 · 崩溃哨兵（每 60s）：selfcheck 指纹 + 可选桥检测 → HIT/RECOVER
function sentryTaskRun(ctx: any): void {
  configDir = ctx.configDir; // schedule 传来的扩展 configDir
  sentryTick().catch(() => {});
}

// 任务 2 · 配置变更滞留提醒（每 1h）：status 非空超阈值 → UNCOMMITTED（只通知，防抖）
async function staleWarnRun(ctx: any): Promise<void> {
  try {
    const c = core.loadConfig(ctx.configDir);
    if (!c.sentry || !c.sentry.enabled) return; // 与哨兵开关联动
    await core.syncToRepo(c, ctx); // 先更新仓副本
    const changed = (await core.gitStatus(c, ctx)).changed; // 仓副本 vs HEAD
    const fsm = require("node:fs");
    const startFile = pathJoin(ctx.cacheDir || ctx.configDir, ".stale-at");
    if (changed && changed.length > 0) {
      let start = 0;
      try { start = Number(fsm.readFileSync(startFile, "utf8")) || 0; } catch {}
      if (!start) { fsm.writeFileSync(startFile, String(Date.now())); return; } // 开始计时
      const hours = Math.max(1, Number(c.sentry.staleHours) || 24);
      if (Date.now() - start > hours * 3600 * 1000) {
        // 防抖：上次提醒后 staleHours/2 内不重复
        let lastWarn = 0;
        try { lastWarn = Number(fsm.readFileSync(pathJoin(ctx.cacheDir || ctx.configDir, ".stale-warn-at"), "utf8")) || 0; } catch {}
        if (Date.now() - lastWarn < (hours * 3600 * 1000) / 2) return;
        fsm.writeFileSync(pathJoin(ctx.cacheDir || ctx.configDir, ".stale-warn-at"), String(Date.now()));
        logSentry("UNCOMMITTED", "配置变更滞留 " + hours + "h+ 未提交（" + changed.length + " 项），建议固化现场（POST /snapshot）", await core.selfcheck(c, ctx));
        console.warn("[aiti-configs·哨兵] ⚠ 配置变更滞留 " + hours + "h 未提交（" + changed.length + " 项）");
      }
    } else {
      try { fsm.rmSync(startFile, { force: true }); } catch {}
    }
  } catch (e) {}
}

// 任务 3 · 定时兜底 commit（每 24h，对标 etckeeper cron）：sentry.autoCommit=true 才有变更就提交
async function autoCommitRun(ctx: any): Promise<void> {
  try {
    const c = core.loadConfig(ctx.configDir);
    if (!c.sentry || !c.sentry.autoCommit) return; // 默认关：sentry.autoCommit=true 才自动提交
    const r = await core.gitCommit(c, ctx); // gitCommit 内部 sync + 无变更 noop
    if (r && r.hash) console.log("[aiti-configs·自动提交] " + r.hash);
    notifySync(r && r.sync); // 远端同步冲突/失败 → 通知
  } catch (e) { console.warn("[aiti-configs·自动提交] 失败", e); }
}

// ---- agent 工具定义（process-injected，AI 直接用；与 aiti-devtools 同机制） ----
const TOOLS = [
  { name: "configs_status", description: "配置版本化状态：sync 源→仓副本 → 对比仓副本 vs HEAD，返回变更文件清单（含敏感/大文件拦截）。AI 改配置/扩展前先看 diff，改后提交。", inputSchema: { type: "object", properties: {} } },
  { name: "configs_commit", description: "配置提交：把已 sync 的仓副本变更 commit 进 configs 仓（conventional message，scope 按配置域）。返回 commit hash 与摘要。", inputSchema: { type: "object", properties: { message: { type: "string", description: "可选：自定义提交信息（缺省 AI 自动生成）" } } } },
  { name: "configs_restore", description: "配置回滚（后悔药）：恢复到指定 commit 版本（五步走：固化现场→tag→checkout→写回源→复测→写 HEAD，不丢数据）。需用户确认。", inputSchema: { type: "object", properties: { version: { type: "string", description: "目标 commit hash 或 tag（configs_log 可查）" }, confirm: { type: "string", description: "用户确认文本（如『确认恢复』）" } }, required: ["version"] } },
  { name: "configs_selfcheck", description: "配置自检：configs 仓状态 + 关键 JSON 可解析 + 扩展入口检查（✅/⚠/❌ 逐项）。崩溃排查首选。", inputSchema: { type: "object", properties: {} } },
  { name: "configs_log", description: "configs 仓最近提交历史（hash/时间/说明）。", inputSchema: { type: "object", properties: { n: { type: "number", description: "条数（默认 10）" } } } },
  { name: "configs_config", description: "查看/修改 ai-configs.json 配置（repo/includes/excludes/hardExcludes/sizeLimit/commit/sentry）。修改需确认。", inputSchema: { type: "object", properties: { get: { type: "boolean", description: "true=读当前配置（缺省）" }, set: { type: "object", description: "要合并写入的配置片段（如 {repo:'~/x', sizeLimitKB:256}）" } } } },
  { name: "configs_snapshot", description: "操作前固化现场（对标 etckeeper Pre-Invoke）：sync 源→仓副本→commit（+可选打 tag）。破坏性操作（改配置/改扩展/回滚前）先调，改坏可回滚。", inputSchema: { type: "object", properties: { tag: { type: "string", description: "可选：同时打 tag（如 good-v1）" }, message: { type: "string", description: "可选：commit 信息" } } } },
  { name: "configs_tag", description: "打/列/删 git tag：标记'好用版本'（如 good-v1）。action=list|add|del。", inputSchema: { type: "object", properties: { action: { type: "string", description: "list/add/del（缺省 list）" }, name: { type: "string", description: "tag 名（add/del 用，如 good-v1）" } } } },
  { name: "configs_key", description: "密文 commit 密钥管理：generate=生成密钥文件（600 权限，永不入仓）；status=查密钥/加密状态。开启 encrypt.enabled 后仓内为密文，push 公开仓也安全；密钥丢失无法恢复，务必备份。", inputSchema: { type: "object", properties: { action: { type: "string", description: "generate/status（缺省 status）" } } } },
  { name: "configs_scan", description: "预扫描 configs 仓内二进制/超大/异常文件（兜底防误收），命中则自动写 .gitignore（# aiti-configs auto-block，幂等）并重同步。", inputSchema: { type: "object", properties: {} } },
];

function toolResult(text: string, isError = false) {
  // 确保 error 类型的结果带 console.error 标记，便于前端统一处理
  if (isError) {
    console.error("[aiti-configs·tool] ❌ " + text);
  }
  return { content: [{ type: "text" as const, text }], isError };
}
async function runTool(name: string, args: any): Promise<any> {
  const c = reloadCfg();
  switch (name) {
    case "configs_status": {
      const sync = await core.syncToRepo(c, getCtx());
      const st = await core.gitStatus(c, getCtx());
      const summary = sync.skipped.length
        ? "\n⏭ 拦截 " + sync.skipped.length + " 项（" + sync.skipped.slice(0, 5).map((s: any) => s.reason).join("；") + (sync.skipped.length > 5 ? "…" : "") + "）" : "";
      return toolResult(JSON.stringify({ ok: true, clean: st.clean, changed: st.changed, synced: sync.synced.length, skipped: sync.skipped.slice(0, 10), encryptFiles: (c.encrypt && c.encrypt.enabled) ? st.encryptFiles : [], summary: st.clean ? "工作区干净" : "待提交 " + st.changed.length + " 个文件" + summary }, null, 2));
    }
    case "configs_commit": {
      const r = await core.gitCommit(c, getCtx(), args && args.message);
      if (!r.ok) return toolResult("提交失败: " + (r as any).out, true);
      return toolResult(JSON.stringify({ ok: true, noop: r.noop, hash: r.hash, message: r.message, changed: r.changed }, null, 2));
    }
    case "configs_restore": {
      const version = args && args.version;
      if (!version) return toolResult("需要 version（configs_log 查 commit hash/tag）", true);
      if (!args || args.confirm !== "确认恢复") {
        const diff = await core.gitDiff(c, getCtx(), version);
        const show = await core.gitShow(c, getCtx(), version);
        return toolResult("将恢复到 " + version + "。\n" + show + "\n\n变更 diff（前 2000 字符）：\n" + diff.slice(0, 2000) + "\n\n确认恢复请带 confirm:'确认恢复'（恢复协议五步走，不丢数据，坏状态可回 pre-recover tag）", false);
      }
      const r = await core.restore(c, getCtx(), version);
      if (!r.ok) {
        console.error("[aiti-configs·restore] ❌ 恢复失败: " + (r.error || JSON.stringify(r.steps)));
        return toolResult("恢复失败: " + (r.error || JSON.stringify(r.steps)), true);
      }
      return toolResult(JSON.stringify({ ok: r.ok, steps: r.steps, tag: r.tag, version: r.version, error: r.error, selfcheck: r.selfcheck && { ok: r.selfcheck.ok, bad: r.selfcheck.bad } }, null, 2), false);
    }
    case "configs_selfcheck": {
      const sc = await core.selfcheck(c, getCtx());
      if (!sc.ok) {
        return toolResult("自检未通过（" + (sc.bad || []).length + " 项）\n" + (sc.bad || []).map((b: any) => b.name + ": " + (b.detail || "")).join("; "), true);
      }
      return toolResult(JSON.stringify({ ok: sc.ok, rows: sc.rows, bad: sc.bad }, null, 2), false);
    }
    case "configs_log": {
      const n = (args && args.n) ? Number(args.n) : 10;
      return toolResult(JSON.stringify({ ok: true, log: await core.gitLog(c, getCtx(), n) }, null, 2));
    }
    case "configs_config": {
      if (args && args.get === false && args.set) {
        const merged = mergeSet(c, args.set);
        if (core.saveConfig(merged)) { cfg = core.loadConfig(configDir); syncSentry(); return toolResult("已更新配置"); }
        return toolResult("写配置失败", true);
      }
      const { _file, ...rest } = c;
      return toolResult(JSON.stringify({ ok: true, file: c._file, config: rest }, null, 2));
    }
    case "configs_snapshot": {
      const r = await core.snapshot(c, getCtx(), { tag: args && args.tag, message: args && args.message });
      if (!r.ok) return toolResult("快照失败：" + r.error, true);
      return toolResult(JSON.stringify({ ok: true, hash: r.hash, noop: r.noop, tag: r.tag, changed: r.changed, skipped: r.skipped }, null, 2));
    }
    case "configs_tag": {
      const a = (args && args.action) || "list";
      if (a === "add") {
        if (!args || !args.name) return toolResult("需要 name（tag 名，如 good-v1）", true);
        const r = await core.gitTag(c, getCtx(), String(args.name));
        return toolResult(r.ok ? "已打 tag: " + args.name : "打 tag 失败：" + r.out, !r.ok);
      }
      if (a === "del") {
        if (!args || !args.name) return toolResult("需要 name", true);
        const r = await core.gitTagDelete(c, getCtx(), String(args.name));
        return toolResult(r.ok ? "已删 tag: " + args.name : "删 tag 失败：" + r.out, !r.ok);
      }
      return toolResult(JSON.stringify({ ok: true, tags: await core.gitTagList(c, getCtx()) }, null, 2));
    }
    case "configs_key": {
      const a = (args && args.action) || "status";
      const en = c.encrypt || {};
      const keyFile = core.expandPath(en.keyFile || core.defaultKeyFile(c, getCtx()), getCtx());
      if (a === "generate") {
        const r = core.generateKey(c, getCtx());
        if (!r.ok) return toolResult("生成密钥失败：" + r.error, true);
        return toolResult(r.existed
          ? "ℹ️ 密钥已存在（" + r.keyFile + "），保留原密钥未覆盖——历史密文可继续解密。如需更换请先删除该文件。"
          : "已生成密文密钥（" + r.keyFile + "，600 权限，git 永不跟踪）。请立即备份该文件——密钥丢失则密文永远无法恢复！开启 encrypt.enabled 后仓内为密文。");
      }
      const exists = keyFile && require("node:fs").existsSync(keyFile);
      return toolResult(JSON.stringify({ ok: true, enabled: !!en.enabled, algo: en.algo || "aes-256-gcm", keyFile, keyExists: exists, patterns: en.patterns || [] }, null, 2));
    }
    case "configs_scan": {
      // 预扫描仓内二进制/超大/异常文件（块 F 兜底），并自动写 .gitignore 防再入；
      // 顺带清理 excludes 收紧后残留在仓里的孤儿副本（如分层迁移前的 novnc/ops 旧布局）
      const scanned = await core.scanStaged(c, getCtx());
      const g = await core.autoGitignore(c, getCtx(), scanned);
      if (g.written) await core.syncToRepo(c, getCtx()); // gitignore 生效后重同步
      const pruned = await core.pruneRepoOrphans(c, getCtx());
      if (pruned.pruned) await core.gitCommit(c, getCtx(), "chore(configs): prune 仓内被排除路径孤儿副本 " + pruned.pruned + " 个");
      return toolResult(JSON.stringify({ ok: true, tracked: scanned.tracked, hits: scanned.hits, autoGitignoreWritten: g.written, orphansPruned: pruned.pruned, orphanPaths: pruned.paths }, null, 2));
    }
    default: return toolResult("unknown tool: " + name, true);
  }
}

export default {
  id: "aiti-configs",
  name: "配置版本化 + 崩溃自检（安全网）",
  version: "0.1.0",
  icon: "icon.svg",
  client: "dist/aiti-configs-client.mjs",

  // 定时任务（注册给 aiti-ai-schedule 聚合执行；不重复造 setInterval）——具体行为由 ai-configs.json 的 sentry 段控制
  schedules: [
    { id: "configs-sentry", name: "配置崩溃哨兵（自检指纹 + 可选桥检测）", intervalSec: 60, enabled: true, run: sentryTaskRun },
    { id: "configs-stale-warn", name: "配置变更滞留提醒", intervalSec: 3600, enabled: true, run: staleWarnRun },
    { id: "configs-auto-commit", name: "配置定时兜底提交", intervalSec: 86400, enabled: true, run: autoCommitRun },
  ],

  // AI 自管理清单（ai-helper 主动聚合）：AI 可说「帮我提交配置 / 回滚配置」
  ai: {
    manage: true,
    intro: "AI 能帮我提交/回滚配置（configs 仓后悔药），也能用 aiti_configs_* 工具直接查 diff",
    skills: "skills",
  },

  // 功能管理：AI 工具整组开关（默认关；helper 帮助点按需开 或 扩展管理器开）
  features: [
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（配置管理）", group: "AI", default: false,
      description: "会话内注入 aiti_configs_* 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    toolbar: [
      { id: "aiti-configs-open", label: "配置", title: "aiti-configs：配置版本化（status/commit/恢复）+ 自检报告 + 历史版本安全盾", icon: "icons/shield.svg" },
    ],
    dialogs: [{ id: "aiti-configs-dialog", label: "aiti-configs" }],
  },

  server: {
    startup(ctx) {
      configDir = ctx.configDir || "";
      cacheDir = ctx.cacheDir || configDir;
      reloadCfg();
      // 自动哨兵（默认关，保守）：sentry.enabled 时周期 selfcheck + 崩溃指纹 → sentry.jsonl + console（防抖）
      syncSentry();
      console.log("[aiti-configs] 就绪 · configDir=" + configDir + " · repo=" + cfg.repo + " · 自身配置=" + cfg._file + " · 聚合 includes=" + core.collectIncludes(cfg, { configDir, registry: (globalThis as any).__piWebExt }).length + " 项");
    },
    shutdown() {
      if (sentryTimer) { clearInterval(sentryTimer); sentryTimer = null; }
    },

    async api(req, ctx) {
      const p = ctx.path || [];
      if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      const c = reloadCfg();
      // GET /sentry-test → 手动跑一次哨兵 tick + 返回内部状态（调试用）
      if (p[0] === "sentry-test" && req.method === "GET") {
        const before = { timer: !!sentryTimer, lastFp: lastSentryFp, enabled: !!(cfg && cfg.sentry && cfg.sentry.enabled) };
        await sentryTick();
        let log = "(无)";
        try { log = require("node:fs").readFileSync(pathJoin(cacheDir, "sentry.jsonl"), "utf8"); } catch (e) {}
        return json({ before, after: { timer: !!sentryTimer, lastFp: lastSentryFp }, sentryLog: log.split("\n").slice(-3) });
      }
      // GET /status → 同步 + 变更摘要
      if (p[0] === "status" && req.method === "GET") {
        const sync = await core.syncToRepo(c, getCtx());
        const st = await core.gitStatus(c, getCtx());
        return json({ ok: true, clean: st.clean, changed: st.changed, synced: sync.synced.length, skipped: sync.skipped.slice(0, 10), repo: c.repo, remote: await core.gitRemoteStatus(c, getCtx()), encrypt: encryptStatus(c), encryptFiles: st.encryptFiles });
      }
      // GET/POST /key → 密文密钥状态 / 生成
      if (p[0] === "key") {
        if (req.method === "GET") return json({ ok: true, encrypt: encryptStatus(c) });
        if (req.method === "POST") {
          const r = core.generateKey(c, getCtx());
          return json(r.ok ? { ok: true, keyFile: r.keyFile, existed: !!r.existed, note: r.note || "", encrypt: encryptStatus(c) } : { ok: false, error: r.error }, r.ok ? 200 : 500);
        }
      }
      // POST /commit { message? } → 提交（+ 可选远端同步）
      if (p[0] === "commit" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const r = await core.gitCommit(c, getCtx(), body && body.message);
        if (!r.ok) return json({ ok: false, error: r.out }, 500);
        notifySync(r.sync); // 远端同步冲突/失败 → 通知
        return json({ ok: true, noop: r.noop, hash: r.hash, message: r.message, changed: r.changed, sync: r.sync });
      }
      // GET /log?n= → 历史
      if (p[0] === "log" && req.method === "GET") {
        const n = Math.min(parseInt(String(ctx.searchParams.get("n") || "10"), 10) || 10, 50);
        return json({ ok: true, log: await core.gitLog(c, getCtx(), n) });
      }
      // POST /diff { version?, path? } → diff 预览（version 缺省 HEAD=工作区未提交变更；path 可选，看单文件）
      // 路径走 body 不进 URL——避免落入隧道/代理 access log
      if (p[0] === "diff" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const v = typeof body?.version === "string" && body.version ? body.version : "HEAD";
        const path = typeof body?.path === "string" && body.path ? body.path : ".";
        return json({ ok: true, diff: await core.gitDiff(c, getCtx(), v, path), show: v === "HEAD" ? "" : await core.gitShow(c, getCtx(), v) });
      }
      // POST /restore { version, confirm } → 五步走恢复（需 confirm 确认，守 AGENTS git 红线）
      if (p[0] === "restore" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (!body || !body.version) return json({ ok: false, error: "需要 version" }, 400);
        if (body.confirm !== "确认恢复") {
          const v = String(body.version);
          return json({ ok: false, needConfirm: true, version: v, show: await core.gitShow(c, getCtx(), v), diff: await core.gitDiff(c, getCtx(), v).slice(0, 2000), hint: "带 confirm:'确认恢复' 执行（恢复协议五步走，不丢数据，坏状态可回 pre-recover tag）" }, 409);
        }
        const r = await core.restore(c, getCtx(), String(body.version));
        return json({ ok: r.ok, steps: r.steps, tag: r.tag, error: r.error, selfcheck: r.selfcheck ? { ok: r.selfcheck.ok, bad: r.selfcheck.bad } : null }, r.ok ? 200 : 500);
      }
      // POST /snapshot { tag?, message? } → 操作前固化现场（对标 etckeeper Pre-Invoke，供扩展/AI 调用）
      if (p[0] === "snapshot" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const r = await core.snapshot(c, getCtx(), { tag: body && body.tag, message: body && body.message });
        if (!r.ok) return json({ ok: false, error: r.error }, 500);
        return json({ ok: true, hash: r.hash, noop: r.noop, tag: r.tag, changed: r.changed, skipped: r.skipped });
      }
      // /tag：GET 列表；POST {name} 打 tag；DELETE ?name= 删 tag
      if (p[0] === "tag") {
        if (req.method === "GET") return json({ ok: true, tags: await core.gitTagList(c, getCtx()) });
        if (req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (!body || !body.name) return json({ ok: false, error: "需要 name" }, 400);
          const r = await core.gitTag(c, getCtx(), String(body.name));
          return r.ok ? json({ ok: true, name: body.name }) : json({ ok: false, error: r.out }, 400);
        }
        if (req.method === "DELETE") {
          const name = ctx.searchParams.get("name") || "";
          if (!name) return json({ ok: false, error: "需要 name" }, 400);
          const r = await core.gitTagDelete(c, getCtx(), name);
          return r.ok ? json({ ok: true, name }) : json({ ok: false, error: r.out }, 400);
        }
        return json({ ok: false, error: "method not allowed" }, 405);
      }
      // GET /selfcheck → 自检
      if (p[0] === "selfcheck" && req.method === "GET") {
        const sc = await core.selfcheck(c, getCtx());
        return json({ ok: sc.ok, rows: sc.rows, bad: sc.bad });
      }
      // GET /config → 读配置
      if (p[0] === "config" && req.method === "GET") {
        const { _file, ...rest } = c;
        return json({ ok: true, file: c._file, config: rest });
      }
      // POST /config { set } → 改配置
      if (p[0] === "config" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (body && body.set && typeof body.set === "object") {
          const merged = mergeSet(c, body.set);
          if (core.saveConfig(merged)) { cfg = core.loadConfig(configDir); syncSentry(); return json({ ok: true }); }
          return json({ ok: false, error: "写配置失败" }, 500);
        }
        return json({ ok: false, error: "需要 set" }, 400);
      }
      return json({ ok: false, error: "not found" }, 404);
    },

    agent: {
      agentTools() {
        // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
        return TOOLS.map((t) => ({
          name: "aiti_" + t.name,
          label: "aiti_" + t.name,
          description: t.description + "（aiti-configs 进程内直连，pi-web 会话）",
          parameters: t.inputSchema || { type: "object", properties: {} },
          async execute(_toolCallId: string, params: any) {
            const r = await runTool(t.name, params || {});
            return r;
          },
        }));
      },
    },
  },
};
