// 限流到期提醒单测（recover）：limitedSince 维护 / alertAt 登记与重武装 / 到期判定 /
// 开关优先级 / 提醒历史 / history.jsonl 回填迁移。纯 core 逻辑，无网络。
// 设计：docs/aiti-model-check-recovery-notify-plan.md
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const mc = require("../core.cjs");
const { ok, finish } = Tester();

const H = 3600 * 1000, D = 24 * H;
const NOW = Date.now();

function baseCfg(patch = {}) {
  return { recover: { enabled: true, minLimitedHours: 72, notifyDefault: true, providers: {}, models: {}, ...patch } };
}
function probe(state, cfg, e) {
  mc.applyToState(state, { latencyMs: 50, provider: "p", model: "m1", ...e }, cfg);
  return state.models["p/m1"];
}

// ── ① limitedSince 维护 ──────────────────────────────────────────
{
  const cfg = baseCfg();
  const state = { models: {} };
  const t0 = NOW - 5 * D;
  probe(state, cfg, { ts: t0, ok: false, status: 429, error: "429 rate limited", predictedAvailableAt: NOW + D });
  ok("① 首次 429 记 limitedSince", state.models["p/m1"].limitedSince === t0);
  const t1 = t0 + D;
  probe(state, cfg, { ts: t1, ok: false, status: 429, error: "429 rate limited", predictedAvailableAt: NOW + D });
  ok("① 连续 429 保持起点", state.models["p/m1"].limitedSince === t0);
  probe(state, cfg, { ts: t1 + H, ok: false, status: 503, error: "server error" });
  ok("① 其它错误不影响起点", state.models["p/m1"].limitedSince === t0);
  probe(state, cfg, { ts: t1 + 2 * H, ok: true, status: 200, text: "ok" });
  ok("① 恢复(200) 清除起点", state.models["p/m1"].limitedSince === null);
}

// ── ② alertAt 登记 / 重武装 / 清空 ───────────────────────────────
{
  const cfg = baseCfg();
  const state = { models: {} };
  const p1 = NOW + 2 * D;
  probe(state, cfg, { ts: NOW - 4 * D, ok: false, status: 429, error: "429", predictedAvailableAt: p1 });
  ok("② 429 带预测 → alertAt 登记", state.models["p/m1"].alertAt === p1 && state.models["p/m1"].alertNotifiedAt === null);
  state.models["p/m1"].alertNotifiedAt = NOW; // 模拟已提醒
  probe(state, cfg, { ts: NOW - 3 * D, ok: false, status: 429, error: "429", predictedAvailableAt: p1 });
  ok("② 同预测值 → 不改动（仍已提醒）", state.models["p/m1"].alertNotifiedAt === NOW);
  const p2 = p1 + D;
  probe(state, cfg, { ts: NOW - 2 * D, ok: false, status: 429, error: "429", predictedAvailableAt: p2 });
  ok("② 预测变化 → 重武装（清 notified）", state.models["p/m1"].alertAt === p2 && state.models["p/m1"].alertNotifiedAt === null);
  probe(state, cfg, { ts: NOW - D, ok: false, status: 429, error: "429 no reset info" });
  ok("② 预测缺失 → alertAt 清空", state.models["p/m1"].alertAt === null);
}

// ── ③ 到期判定（dueRecoverAlerts） ───────────────────────────────
{
  const cfg = baseCfg();
  const state = { models: {} };
  // a) 长期（5 天）+ 预测已过点 → due
  probe(state, cfg, { ts: NOW - 5 * D, ok: false, status: 429, error: "429", predictedAvailableAt: NOW - D });
  // b) 短期（6h）+ 预测已过点 → 不 due（未达阈值）
  mc.applyToState(state, { ts: NOW - 6 * H, ok: false, status: 429, latencyMs: 1, error: "429", predictedAvailableAt: NOW - H, provider: "p", model: "m2" }, cfg);
  // c) 长期 + 预测未到点 → 不 due
  mc.applyToState(state, { ts: NOW - 5 * D, ok: false, status: 429, latencyMs: 1, error: "429", predictedAvailableAt: NOW + D, provider: "p", model: "m3" }, cfg);
  // d) 已恢复 → 不 due
  mc.applyToState(state, { ts: NOW - 5 * D, ok: false, status: 429, latencyMs: 1, error: "429", predictedAvailableAt: NOW - D, provider: "p", model: "m4" }, cfg);
  mc.applyToState(state, { ts: NOW - H, ok: true, status: 200, latencyMs: 1, text: "ok", provider: "p", model: "m4" }, cfg);
  const due = mc.dueRecoverAlerts(state, cfg, NOW);
  ok("③ 到期判定：只含长期+到点+未恢复", due.length === 1 && due[0].provider === "p" && due[0].model === "m1", JSON.stringify(due.map((d) => d.model)));
  ok("③ limitedMs 已持续时长正确", Math.abs(due[0].limitedMs - 5 * D) < 1000);
}

// ── ④ 开关优先级 ────────────────────────────────────────────────
{
  const state = { models: {} };
  const pred = NOW - D, since = NOW - 5 * D;
  mc.applyToState(state, { ts: since, ok: false, status: 429, latencyMs: 1, error: "429", predictedAvailableAt: pred, provider: "prov1", model: "mm" }, baseCfg());
  const cfgDef = baseCfg();
  ok("④ 默认开", mc.dueRecoverAlerts(state, cfgDef, NOW).length === 1);
  const cfgProvOff = baseCfg({ providers: { prov1: false } });
  ok("④ provider 关 → 不提醒", mc.dueRecoverAlerts(state, cfgProvOff, NOW).length === 0);
  const cfgModelOn = baseCfg({ providers: { prov1: false }, models: { "prov1/mm": true } });
  ok("④ 模型级覆盖 provider 级", mc.dueRecoverAlerts(state, cfgModelOn, NOW).length === 1);
  const cfgModelOff = baseCfg({ models: { "prov1/mm": false } });
  ok("④ 模型关 → 不提醒", mc.dueRecoverAlerts(state, cfgModelOff, NOW).length === 0);
  const cfgDefOff = baseCfg({ notifyDefault: false });
  ok("④ 默认关", mc.dueRecoverAlerts(state, cfgDefOff, NOW).length === 0);
  const cfgGlobal = baseCfg({ enabled: false });
  ok("④ 总开关关全关", mc.dueRecoverAlerts(state, cfgGlobal, NOW).length === 0);
  ok("④ recoverNotifyEnabled 函数直测", mc.recoverNotifyEnabled(cfgDef, "prov1", "mm") === true && mc.recoverNotifyEnabled(cfgProvOff, "prov1", "mm") === false);
}

// ── ⑤ 提醒标记与历史 ────────────────────────────────────────────
{
  const cfg = baseCfg();
  const state = { models: {} };
  probe(state, cfg, { ts: NOW - 5 * D, ok: false, status: 429, error: "429", predictedAvailableAt: NOW - D });
  const due = mc.dueRecoverAlerts(state, cfg, NOW);
  mc.markRecoverAlertsNotified(state, due, NOW);
  ok("⑤ 标记后不再 due", mc.dueRecoverAlerts(state, cfg, NOW).length === 0);
  ok("⑤ alertNotifiedAt 写入", state.models["p/m1"].alertNotifiedAt === NOW);
  ok("⑤ recoverAlerts 历史一条且字段齐", state.recoverAlerts.length === 1 && state.recoverAlerts[0].provider === "p" && state.recoverAlerts[0].alertAt === NOW - D && state.recoverAlerts[0].limitedMs > 0);
  for (let i = 0; i < 120; i++) mc.markRecoverAlertsNotified(state, [{ provider: "p", model: "m1", alertAt: NOW, limitedSince: NOW - 5 * D, limitedMs: 5 * D }], NOW + i);
  ok("⑤ 历史上限 100 条", state.recoverAlerts.length === 100);
}

// ── ⑨ 待验证清单（pendingRecoverChecks：到点未验证，提示后不消失，探测验证后移除）──
{
  const cfg = baseCfg();
  const state = { models: {} };
  probe(state, cfg, { ts: NOW - 5 * D, ok: false, status: 429, error: "429", predictedAvailableAt: NOW - D }); // m1 到点
  mc.applyToState(state, { ts: NOW - D, ok: false, status: 429, latencyMs: 1, error: "429", predictedAvailableAt: NOW + D, provider: "p", model: "m2" }, cfg); // 未到点
  const p1 = mc.pendingRecoverChecks(state, cfg, NOW);
  ok("⑨ pending 含到点未验证", p1.length === 1 && p1[0].model === "m1" && p1[0].longTerm === true);
  mc.markRecoverAlertsNotified(state, mc.dueRecoverAlerts(state, cfg, NOW), NOW);
  const p2 = mc.pendingRecoverChecks(state, cfg, NOW);
  ok("⑨ 已提醒仍在 pending（待办不消失）", p2.length === 1 && p2[0].notified === true);
  probe(state, cfg, { ts: NOW, ok: true, status: 200, text: "ok" });
  ok("⑨ 验证(200)后从 pending 移除", mc.pendingRecoverChecks(state, cfg, NOW).length === 0);
}

// ── ⑥ history.jsonl 回填迁移 ────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcheck-recover-"));
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  const lines = [
    { ts: NOW - 10 * D, provider: "a", model: "x", ok: true, status: 200 },
    { ts: NOW - 9 * D, provider: "a", model: "x", ok: false, status: 429 },
    { ts: NOW - 8 * D, provider: "a", model: "x", ok: false, status: 429 },   // ← 最近 ok 后首条非 ok = -9d
    { ts: NOW - 12 * D, provider: "b", model: "y", ok: false, status: 429 },  // 无 ok → 首条 -12d
    { ts: NOW - 11 * D, provider: "b", model: "y", ok: false, status: 429 },
    { ts: NOW - 6 * D, provider: "c", model: "z", ok: true, status: 200 },    // 无后续记录 → 无起点（回落 lastProbedAt）
  ];
  fs.writeFileSync(path.join(dir, "cache", "history.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const state = { models: {
    "a/x": { provider: "a", model: "x", rateLimited: true, lastProbedAt: NOW - 8 * D, history: [] },
    "b/y": { provider: "b", model: "y", rateLimited: true, lastProbedAt: NOW - 11 * D, history: [] },
    "c/z": { provider: "c", model: "z", rateLimited: true, lastProbedAt: NOW - 5 * D, history: [] },
    "d/w": { provider: "d", model: "w", rateLimited: true, blockedAt: NOW - 4 * D, history: [] }, // 无记录 → blockedAt
    "e/v": { provider: "e", model: "v", rateLimited: false, lastOk: true },   // 非限流 → 不回填
    "f/u": { provider: "f", model: "u", rateLimited: true, lastProbedAt: NOW - 5 * D, predictedAvailableAt: NOW - 2 * D, history: [] }, // alertAt 回填
    "g/t": { provider: "g", model: "t", rateLimited: true, lastProbedAt: NOW - 5 * D, predictedAvailableAt: NOW - 2 * D, alertAt: NOW - 3 * D, history: [] }, // 已有 alertAt → 不覆盖
  } };
  const n = await mc.migrateLimitedSince(state, dir);
  ok("⑥ 回填数量 = 7（limitedSince 6 + alertAt 1）", n === 7, "n=" + n);
  ok("⑥ a/x = 最近 ok 后首条非 ok（-9d）", state.models["a/x"].limitedSince === NOW - 9 * D, String(state.models["a/x"].limitedSince - (NOW - 9 * D)));
  ok("⑥ b/y = 首条记录（-12d）", state.models["b/y"].limitedSince === NOW - 12 * D);
  ok("⑥ c/z = 回落 lastProbedAt", state.models["c/z"].limitedSince === NOW - 5 * D);
  ok("⑥ d/w = blockedAt", state.models["d/w"].limitedSince === NOW - 4 * D);
  ok("⑥ e/v 不回填", state.models["e/v"].limitedSince === undefined && state.models["e/v"].alertAt === undefined);
  ok("⑥ f/u alertAt 回填 = predictedAvailableAt", state.models["f/u"].alertAt === NOW - 2 * D);
  ok("⑥ g/t 已有 alertAt 不覆盖", state.models["g/t"].alertAt === NOW - 3 * D);
  const n2 = await mc.migrateLimitedSince(state, dir);
  ok("⑥ 幂等（第二次 0）", n2 === 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑦ 迁移后的端到端：opencode-go 情形（长期 + 预测已过点 → 立即提醒）────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcheck-recover2-"));
  fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
  const lines = [
    { ts: NOW - 7 * D, provider: "opencode-go", model: "deepseek-flash", ok: true, status: 200 },
    { ts: NOW - 6 * D, provider: "opencode-go", model: "deepseek-flash", ok: false, status: 429 },
    { ts: NOW - 5 * D, provider: "opencode-go", model: "deepseek-flash", ok: false, status: 429 },
  ];
  fs.writeFileSync(path.join(dir, "cache", "history.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const state = { models: {
    "opencode-go/deepseek-flash": { provider: "opencode-go", model: "deepseek-flash", lastProbedAt: NOW - 5 * D, rateLimited: true, predictedAvailableAt: NOW - 2 * D, history: [] },
  } };
  await mc.migrateLimitedSince(state, dir);
  ok("⑦ 迁移回填 limitedSince（-6d）", state.models["opencode-go/deepseek-flash"].limitedSince === NOW - 6 * D);
  ok("⑦ 存量 alertAt 回填（无字段→从 predicted 登记）", state.models["opencode-go/deepseek-flash"].alertAt === NOW - 2 * D);
  const due = mc.dueRecoverAlerts(state, baseCfg(), NOW);
  ok("⑦ 迁移+到期 → 立即可提醒", due.length === 1 && due[0].model === "deepseek-flash" && due[0].limitedSince === NOW - 6 * D);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── ⑧ 摘要输出 ─────────────────────────────────────────────────
{
  const cfg = baseCfg();
  const state = { models: {} };
  probe(state, cfg, { ts: NOW - 5 * D, ok: false, status: 429, error: "429", predictedAvailableAt: NOW - D });
  const txt = mc.buildRecoverSummary(state, cfg, NOW);
  ok("⑧ 摘要含待验证", txt.includes("待验证") && txt.includes("p/m1"), txt.split("\n")[0]);
  const empty = mc.buildRecoverSummary({ models: {} }, cfg, NOW);
  ok("⑧ 空摘要", empty.includes("（无："));
}

// ── ⑩ loadUserConfig（写回用原始配置，不合并默认）──────────────────
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "mcheck-uc-"));
  fs.writeFileSync(path.join(dir2, "config.json"), JSON.stringify({ probe: { concurrency: 3 }, recover: { providers: { p: false } } }));
  const raw = mc.loadUserConfig(dir2);
  ok("⑩ loadUserConfig 不合并默认", !("modelsPath" in raw) && raw.probe.concurrency === 3 && raw.recover.providers.p === false);
  const merged = mc.loadConfig(dir2);
  ok("⑩ loadConfig 合并默认（对照）", merged.probe.concurrency === 3 && merged.probe.timeoutMs === 15000);
  fs.rmSync(dir2, { recursive: true, force: true });
}

finish("recover.test · 限流到期提醒");
