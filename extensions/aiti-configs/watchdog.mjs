#!/usr/bin/env node
/**
 * aiti-configs · watchdog CLI（崩溃自检 + 配置版本化，纯 Node 零依赖）
 *
 * 复用 core.cjs（与 pi-web 扩展同份逻辑）；不依赖 pi-web/浏览器/桥——系统崩了也能跑。
 *
 * 用法：
 *   node watchdog.mjs [dataDir] status
 *   node watchdog.mjs [dataDir] commit [--message="..."]
 *   node watchdog.mjs [dataDir] selfcheck
 *   node watchdog.mjs [dataDir] log [n]
 *   node watchdog.mjs [dataDir] restore [--commit=<hash|tag>] [--yes]
 *   node watchdog.mjs [dataDir] recover [--commit=<hash>] [--yes]
 *   node watchdog.mjs [dataDir] export [--out=<dir>]
 *   node watchdog.mjs [dataDir] import [--dir=<src>]
 *
 * [dataDir] 缺省：~/.pi/web/data/aiti-configs/config（三目录对称：config/state/cache）。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const core = require("./core.cjs");

const DEFAULT_DATA = join(homedir(), ".pi", "web", "data", "aiti-configs", "config");
const args = process.argv.slice(2);
const dataDir = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : DEFAULT_DATA;
const rest = args[0] && !args[0].startsWith("--") ? args.slice(1) : args;
const cmd = rest[0] || "selfcheck";
const opts = {};
for (const a of rest.slice(1)) {
  const m = a.match(/^--([^=]+)=(.*)$/) || a.match(/^--([^=]+)$/);
  if (m) opts[m[1]] = m[2] !== undefined ? m[2] : true;
}
const ctx = { configDir: dataDir }; // 数据分层：dataDir 参数语义=扩展配置区（legacyDir，供旧配置一次性迁移）

function gitRun(repo, args2) {
  return execSync("git " + args2, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
function p(title, body) { console.log("\n### " + title + "\n" + (body === "" ? "（空）" : body)); }
function jsonOrText(v) {
  try { return JSON.stringify(JSON.parse(v), null, 2); } catch (e) { return String(v); }
}

(async () => {
  const cfg = core.loadConfig(dataDir);
  try { mkdirSync(dataDir, { recursive: true }); } catch (e) {}
  switch (cmd) {
    case "keygen": {
      const r = core.generateKey(cfg, ctx);
      if (!r.ok) { console.log("❌ 生成密钥失败：" + r.error); process.exit(1); }
      console.log("✅ 已生成密文密钥：" + r.keyFile);
      console.log("   权限 600，在 {repo}/.git/ 下——git 元数据目录天然不跟踪、永不入仓。");
      console.log("   ⚠ 请立即备份该文件——丢失则密文永远无法恢复！");
      if (r.existed) console.log("   （密钥已存在，保留原密钥未覆盖——如需更换请先手动删除该文件）");
      break;
    }
    case "status": {
      const sync = await core.syncToRepo(cfg, ctx);
      const st = await core.gitStatus(cfg, ctx);
      p("configs 仓：" + cfg.repo, "同步 " + sync.synced.length + " 项，拦截 " + sync.skipped.length + " 项");
      if (sync.skipped.length) p("拦截明细", sync.skipped.map((s) => s.src + " → " + s.reason).join("\n"));
      if (st.clean) { console.log("\n✅ 工作区干净（无可提交变更）"); }
      else {
        console.log("\n⚠ 待提交 " + st.changed.length + " 个文件：");
        for (const c of st.changed) console.log("  " + (c.status === "D" ? "删除" : "变更") + "  " + c.path);
        console.log("\n提交：node watchdog.mjs " + dataDir + " commit");
      }
      break;
    }
    case "commit": {
      const r = await core.gitCommit(cfg, ctx, opts.message);
      if (!r.ok) { console.error("提交失败：" + r.out); process.exit(1); }
      if (r.noop) { console.log("无可提交变更（工作区干净）"); break; }
      console.log("✅ 已提交 " + r.hash + " · " + r.message + "（" + r.changed + " 文件）");
      break;
    }
    case "selfcheck": {
      const sc = await core.selfcheck(cfg, ctx);
      let allOk = true;
      for (const row of sc.rows) { console.log((row.ok ? "✅ " : "❌ ") + row.name + " · " + row.detail); if (!row.ok) allOk = false; }
      console.log(allOk ? "\n✅ 自检通过" : "\n❌ 自检未通过（" + sc.bad.length + " 项）");
      if (!allOk) process.exit(1);
      break;
    }
    case "log": {
      const n = parseInt(opts.n || "10", 10) || 10;
      for (const row of await core.gitLog(cfg, ctx, n)) console.log(row.hash + "  " + row.date + "  " + row.subject);
      break;
    }
    case "restore": {
      if (!opts.commit) { console.error("需要 --commit=<hash|tag>（log 查）"); process.exit(1); }
      if (opts.yes !== true) {
        const show = await core.gitShow(cfg, ctx, opts.commit);
        console.log("将恢复到 " + opts.commit + "：\n" + show);
        console.log("确认执行加 --yes（五步走，不丢数据，可回 pre-recover tag）");
        process.exit(0);
      }
      const r = await core.restore(cfg, ctx, opts.commit);
      for (const s of r.steps) console.log("[" + s.step + "] " + s.action + " → " + s.result);
      console.log(r.ok ? "✅ 恢复完成（tag=" + r.tag + "）" : "❌ 恢复失败：" + r.error);
      if (!r.ok) process.exit(1);
      break;
    }
    case "recover": {
      // 崩溃恢复：诊断包（selfcheck 明细 + 最近 commit）→ 组装版本提示词 → 输出供 AI 修复（本 CLI 不自动拉 AI，由上层调用）
      const sc = await core.selfcheck(cfg, ctx);
      const log = await core.gitLog(cfg, ctx, 5);
      console.log("[诊断包] configs 仓 HEAD=" + (sc.head || "无"));
      for (const row of sc.rows) console.log((row.ok ? "✅ " : "❌ ") + row.name + " · " + row.detail);
      if (opts.commit) console.log("[恢复候选] " + opts.commit + "：" + (await core.gitShow(cfg, ctx, opts.commit)).split("\n")[0] || "");
      console.log("\n请将以上诊断包作为一次独立 AI 会话的输入，指导其修复（修文件 / 恢复 commit / 修 JSON），完成后复跑：node watchdog.mjs " + dataDir + " selfcheck");
      if (!sc.ok) process.exit(1);
      break;
    }
    case "export": {
      const out = opts.out ? resolve(opts.out) : join(dataDir, "configs-export-" + new Date().toISOString().slice(0, 10));
      mkdirSync(out, { recursive: true });
      const inc = core.collectIncludes(cfg, ctx);
      let n = 0;
      const manifest = [];
      for (const it of inc) {
        if (String(it.path).includes("*")) continue;
        const src = core.expandPath(it.path, ctx);
        if (!existsSync(src)) continue;
        // 硬排除/排除优先：session/auth/大文件永不进迁移包
        if (core.matchesAny(src, [...(cfg.hardExcludes || []), ...(cfg.excludes || [])])) continue;
        const destRel = String(it.dest || src.split("/").pop());
        const destAbs = join(out, destRel);
        try { mkdirSync(resolve(destAbs, ".."), { recursive: true }); copyFileSync(src, destAbs); manifest.push({ src, dest: destRel }); n++; } catch (e) {}
      }
      writeFileSync(join(out, "manifest.json"), JSON.stringify({ exportedAt: new Date().toISOString(), config: { ...cfg, _file: undefined }, files: manifest }, null, 2));
      console.log("✅ 已导出 " + n + " 个配置文件到 " + out + "（不含 session/日志/大文件——硬排除）");
      break;
    }
    case "import": {
      const src = opts.dir ? resolve(opts.dir) : dataDir;
      const manFile = join(src, "manifest.json");
      if (!existsSync(manFile)) { console.error("未找到 manifest.json（用 export 生成）：" + manFile); process.exit(1); }
      const man = JSON.parse(readFileSync(manFile, "utf8"));
      let n = 0;
      for (const f of man.files || []) {
        const from = join(src, f.dest);
        if (!existsSync(from)) continue;
        try { mkdirSync(resolve(f.src, ".."), { recursive: true }); copyFileSync(from, f.src); n++; } catch (e) {}
      }
      console.log("✅ 已恢复 " + n + " 个配置文件到源路径（含 manifest 里的 includes 清单）。随后跑 selfcheck 复测。");
      break;
    }
    default:
      console.log("未知命令：" + cmd + "（可用：status/commit/selfcheck/log/restore/recover/export/import）");
      process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
