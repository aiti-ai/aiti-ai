// probeByProvider 单测：逐个 provider 串行探测 + 每 provider 完成后回调 onProviderDone（即时落盘语义）
// 用临时 models.json + 假 LLM 上游（三个 provider 各自 200，返回不同文本以追踪命中顺序），不碰真实配置。
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { makeUpstream, Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const mc = require("../core.cjs");
const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpbp-"));
const modelsFile = path.join(dir, "models.json");
const cfg = { modelsPath: modelsFile, modelsStorePath: path.join(dir, "store.json"), probe: { timeoutMs: 5000, concurrency: 2, maxTokens: 8, perKey: true }, fallbackToStore: false, subscriptions: { enabled: false } };

const writeModels = (o) => fs.writeFileSync(modelsFile, JSON.stringify(o));

// 假上游：所有模型 200，按 provider 名返回不同文本（追踪先后）
const hitOrder = [];
const up = await makeUpstream((req, res) => {
  const body = JSON.parse(req.rawBody || "{}");
  const model = String(body.model || "");
  hitOrder.push(model);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: "ok:" + model } }] }));
});

// 三个 provider（名字乱序，验证 localeCompare 排序）：pB 单模型 / pA 双模型 / pC 双模型
writeModels({
  providers: {
    pB: { baseUrl: `http://127.0.0.1:${up.address().port}/v1`, api: "openai-completions", models: [{ id: "mB1" }] },
    pA: { baseUrl: `http://127.0.0.1:${up.address().port}/v1`, api: "openai-completions", models: [{ id: "mA1" }, { id: "mA2" }] },
    pC: { baseUrl: `http://127.0.0.1:${up.address().port}/v1`, api: "openai-completions", models: [{ id: "mC1" }, { id: "mC2" }] },
  },
});

const lm = mc.loadModels(cfg);
const entries = lm.entries;

// ① 按 provider 分组正确
ok("① entries 覆盖 3 provider / 5 模型", entries.length === 5 && new Set(entries.map((e) => e.provider)).size === 3);

// ② probeByProvider：串行 + 每 provider 回调 onProviderDone（收自己的结果）
const doneSeq = [];       // 回调到的 provider 顺序
const doneCounts = [];    // 每个回调收到的条数
const all = await mc.probeByProvider(entries, cfg, {
  onProviderDone: (p, pResults) => { doneSeq.push(p); doneCounts.push(pResults.length); },
});

// 回调按 provider 字母序（localeCompare）：pA → pB → pC
ok("② onProviderDone 按 provider 逐个触发（pA→pB→pC）", JSON.stringify(doneSeq) === '["pA","pB","pC"]', JSON.stringify(doneSeq));
ok("② 每个回调只含该 provider 的结果（2/1/2）", JSON.stringify(doneCounts) === "[2,1,2]", JSON.stringify(doneCounts));

// ③ 命中顺序：pA 的模型先于 pB、pB 先于 pC（串行，无跨 provider 交叉）
const idxA = Math.min(hitOrder.indexOf("mA1"), hitOrder.indexOf("mA2"));
const idxB = hitOrder.indexOf("mB1");
const idxC = Math.min(hitOrder.indexOf("mC1"), hitOrder.indexOf("mC2"));
ok("③ 串行：pA 全部先于 pB 全部", idxA >= 0 && idxB > Math.max(hitOrder.indexOf("mA1"), hitOrder.indexOf("mA2")), hitOrder.join(","));
ok("③ 串行：pB 先于 pC", idxB >= 0 && idxC > idxB, hitOrder.join(","));

// ④ 返回全部结果（5 条），按 provider+model 排序
ok("④ 返回全部 5 条且均 ok", all.length === 5 && all.every((r) => r.ok));
ok("④ 排序 pA/mA1 在前", all[0].provider === "pA" && all[0].model === "mA1", all.map((r) => r.provider + "/" + r.model).join(","));

up.close();
fs.rmSync(dir, { recursive: true, force: true });
finish("probeByProvider · 逐个 provider 探测");
