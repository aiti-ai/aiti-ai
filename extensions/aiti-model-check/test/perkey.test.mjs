// 分 key 探测单测：probeOne 多 key 聚合 / applyToState 分 key 状态 / 全部 429 → 限流
// 用临时 models.json + 假 LLM 上游（key-A 429, key-B 200），不碰真实配置。
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { makeUpstream, Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const mc = require("../core.cjs");
const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcheck-"));
const modelsFile = path.join(dir, "models.json");
const cfg = { modelsPath: modelsFile, modelsStorePath: path.join(dir, "store.json"), probe: { timeoutMs: 5000, concurrency: 2, maxTokens: 8, perKey: true } };

const writeModels = (o) => fs.writeFileSync(modelsFile, JSON.stringify(o));

// 假上游：key-A 永远 429，key-B 永远 200
const hits = [];
const up = await makeUpstream((req, res) => {
  const k = (req.headers.authorization || "").slice(7); hits.push(k);
  if (k === "sk-A") { res.writeHead(429, { "content-type": "application/json", "retry-after": "5" }); res.end(JSON.stringify({ error: { message: "rate limited" } })); }
  else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }] })); }
});

writeModels({ providers: { p: { baseUrl: `http://127.0.0.1:${up.address().port}/v1`, api: "openai-completions", apiKeys: [{ name: "A", key: "sk-A" }, { name: "B", key: "sk-B" }], models: [{ id: "m1" }] } } });

// ① loadModels → entries 带 keys
const lm = mc.loadModels(cfg);
ok("① loadModels 带 keys", lm.ok && lm.entries[0].keys.map((k) => k.name).join(",") === "A,B", `runtime=${lm.runtime}`);

// ② probeOne 分 key：A=429, B=200 → 整体 ok
const r = await mc.probeOne(lm.entries[0], cfg);
ok("② 整体 ok（任一 key 成功）", r.ok === true && r.status === 200 && r.kind === "ok");
ok("② perKey 两条（A 429 / B 200）", r.perKey.length === 2 && r.perKey[0].status === 429 && r.perKey[1].ok === true);
ok("② 命中顺序先 A 后 B", JSON.stringify(hits) === '["sk-A","sk-B"]');

// ③ applyToState → m.keys 分 key 状态
const state = { models: {} };
mc.applyToState(state, r, cfg);
const m = state.models["p/m1"];
ok("③ state.keys 存在且分 key", !!m.keys && m.keys.A.status === 429 && m.keys.B.ok === true);
ok("③ key-A 标记限流（rate）", m.keys.A.kind === "rate");

// ④ 全部 429 → 聚合限流
const up2 = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "5" }); res.end("{}"); });
writeModels({ providers: { p2: { baseUrl: `http://127.0.0.1:${up2.address().port}/v1`, api: "openai-completions", apiKeys: [{ name: "X", key: "sk-X" }, { name: "Y", key: "sk-Y" }], models: [{ id: "m2" }] } } });
const r2 = await mc.probeOne(mc.loadModels(cfg).entries[0], cfg);
ok("④ 全部 429 → 聚合限流", r2.ok === false && r2.kind === "rate" && /全部.*key.*429/.test(r2.label), r2.label);
ok("④ perKey 均 429", r2.perKey.length === 2 && r2.perKey.every((k) => k.status === 429));

// ⑤ perKey=false → 关分 key，单 key 探测（用 models.json 的 apiKey=sk-A → 429）
const cfg2 = { ...cfg, probe: { ...cfg.probe, perKey: false } };
const r3 = await mc.probeOne(mc.loadModels(cfg).entries[0], cfg2);
ok("⑤ perKey=false → 单 key 路径（无 perKey 字段，用 apiKey=sk-A→429）", !Array.isArray(r3.perKey) && r3.status === 429);

up.close(); up2.close();
fs.rmSync(dir, { recursive: true, force: true });
finish("perkey.test · 分 key 探测");
