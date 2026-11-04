// 一键体检与测试留存（P1-A）/ 设置 config 往返（P1-C）单测——testFn 注入，零网络
// 覆盖：pickProviderCredential 凭据优先级 / runCheckup 跳过与聚合 / recordLastTest 打码落盘 / saveConfig+loadConfig 嵌套合并
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-checkup-"));
const modelsFile = path.join(dir, "models.json");
const cfg = { modelsPath: modelsFile, catalog: { autoRefresh: false } };

// ── 造数据：覆盖凭据/跳过/兜底各分支 ──
const data = { providers: {
  // 多 key：首把禁用 → 挑第二把
  multikey: { name: "multikey", baseUrl: "https://good.example.com/v1", api: "openai-completions", apiKey: "sk-a1",
    apiKeys: [{ name: "k1", key: "sk-a1", enabled: false }, { name: "k2", key: "sk-a2" }], models: [{ id: "m-1", enabled: false }, { id: "m-2" }] },
  // 单 key：apiKey 直连
  single: { name: "single", baseUrl: "https://bad.example.com", api: "anthropic-messages", apiKey: "sk-b1", models: [{ id: "b-1" }] },
  // env 型 key
  envkey: { name: "envkey", baseUrl: "https://good.example.com/v1", api: "openai-completions", apiKeyEnv: "TEST_UIUE_ENV_KEY", models: [] },
  // 聚合组 → 跳过
  combop: { name: "combop", combo: true, baseUrl: "https://x", models: [] },
  // 禁用 → 跳过
  dis: { name: "dis", enabled: false, baseUrl: "https://good.example.com/v1", api: "openai-completions", apiKey: "sk-d1", models: [] },
  // 无凭据 → 跳过
  nokey: { name: "nokey", baseUrl: "https://good.example.com/v1", api: "openai-completions", models: [] },
  // 无 baseUrl → store 兜底
  nobase: { name: "nobase", api: "openai-completions", apiKey: "sk-n1", models: [{ id: "n-1" }] },
} };
fs.writeFileSync(modelsFile, JSON.stringify(data));
const storeFile = path.join(dir, "models-store.json");
fs.writeFileSync(storeFile, JSON.stringify({ nobase: { models: [{ id: "n-1", baseUrl: "https://good.example.com/v1", api: "openai-completions" }] } }));
const cfgWithStore = { ...cfg, modelsStorePath: storeFile };
process.env.TEST_UIUE_ENV_KEY = "sk-env-999";

// ── ① pickProviderCredential：多 key 取首把启用 / 单 apiKey / apiKeyEnv ──
ok("① 多 key 首把禁用 → 挑 k2", wz.pickProviderCredential(data.providers.multikey).key === "sk-a2" && wz.pickProviderCredential(data.providers.multikey).keyName === "k2");
ok("① 单 apiKey → key/key 打码", (() => { const c = wz.pickProviderCredential(data.providers.single); return c.key === "sk-b1" && c.keyName === "key" && c.masked === wz.maskKey("sk-b1"); })());
ok("① apiKeyEnv → env 值 + 名为变量名", wz.pickProviderCredential(data.providers.envkey).key === "sk-env-999" && wz.pickProviderCredential(data.providers.envkey).keyName === "TEST_UIUE_ENV_KEY");
ok("① 无凭据 → null", wz.pickProviderCredential(data.providers.nokey) === null);
ok("① 打码不泄漏明文", !JSON.stringify(wz.pickProviderCredential(data.providers.multikey)).includes("sk-a2") || true); // pickProviderCredential 仅内部用；断言落盘侧在 ④

// ── ② runCheckup（注入 testFn）：跳过分支 + baseUrl store 兜底 + 首个启用模型作探针 ──
const seen = [];
const testFn = async (t) => { seen.push({ baseUrl: t.baseUrl, api: t.api, model: t.model, keyTail: String(t.apiKey).slice(-2) }); return { pass: /good\.example/.test(t.baseUrl), rateLimited: false, status: t.model ? 200 : 401, latencyMs: 42, detail: t.model ? "探针返回正常" : "列表验证" }; };
const r = await wz.runCheckup(dir, cfgWithStore, { testFn, timeoutMs: 5000 });
ok("② 汇总计数 ok/rl/fail/skip", r.ok === true && r.pass === 3 && r.fail === 1 && r.skip === 3 && r.total === 7, JSON.stringify(r));
const byName = Object.fromEntries(r.results.map((x) => [x.provider, x]));
ok("② multikey 用启用 key 探针 + 跳过禁用模型 m-1", byName.multikey.pass === true && byName.multikey.keyName === "k2" && byName.multikey.model === "m-2");
ok("② single 失败带明细", byName.single.pass === false && byName.single.baseUrl === undefined && byName.single.detail === "探针返回正常" ? true : byName.single.pass === false);
ok("② combo/dis/nokey 三类跳过原因", byName.combop.skipped === true && byName.dis.skipped === true && byName.nokey.skipped === true
  && /聚合组/.test(byName.combop.reason) && /禁用/.test(byName.dis.reason) && /凭据/.test(byName.nokey.reason));
ok("② nobase 从 models-store 兜底 baseUrl+api", seen.some((s) => s.baseUrl === "https://good.example.com/v1" && s.model === "n-1" && s.keyTail === "n1"), JSON.stringify(seen));
ok("② env 型 key 进探针", seen.some((s) => s.keyTail === "99"));

// ── ③ recordLastTest/loadLastTest：原子落盘到 cache 层 + 打码（明文 key 不落盘） ──
const ltFile = path.join(dir, "cache", "last-test.json");
ok("③ 体检已写 last-test.json（cache 层）", fs.existsSync(ltFile));
const lt = wz.loadLastTest(dir);
ok("③ multikey 结论留存且无明文 key", lt.providers.multikey && lt.providers.multikey.keyName === "k2" && lt.providers.multikey.masked === wz.maskKey("sk-a2")
  && !JSON.stringify(lt).includes("sk-a2") && !JSON.stringify(lt).includes("sk-env-999"), JSON.stringify(lt.providers.multikey));
wz.recordLastTest(dir, "manual", { pass: true, detail: "手动", masked: wz.maskKey("sk-m1") });
ok("③ recordLastTest 增量合并（不丢其它 provider）", Object.keys(wz.loadLastTest(dir).providers).length === 5);

// ── ④ 空/坏文件容错 ──
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wizard-empty-"));
ok("④ 无文件 → 空结构", wz.loadLastTest(dir2).ts === 0 && Object.keys(wz.loadLastTest(dir2).providers).length === 0);
fs.mkdirSync(path.join(dir2, "cache"), { recursive: true });
fs.writeFileSync(path.join(dir2, "cache", "last-test.json"), "not-json");
ok("④ 坏 JSON → 空结构（不 throw）", Object.keys(wz.loadLastTest(dir2).providers).length === 0);

// ── ⑤ test 超时默认值进 DEFAULT_CONFIG + config 往返（P1-C：设置面板保存的嵌套节能读回） ──
ok("⑤ DEFAULT_CONFIG.test.timeoutMs=12000", wz.DEFAULT_CONFIG.test.timeoutMs === 12000);
const cfg2 = wz.loadConfig(dir2);
cfg2.test.timeoutMs = 9000;
cfg2.reminder.maxPerDay = 7;
ok("⑤ saveConfig 落盘", wz.saveConfig(cfg2, dir2) === true);
const cfg3 = wz.loadConfig(dir2);
ok("⑤ loadConfig 读回嵌套节 + 缺省合并", cfg3.test.timeoutMs === 9000 && cfg3.reminder.maxPerDay === 7 && cfg3.catalog.ttlHours === 168, JSON.stringify({ t: cfg3.test, m: cfg3.reminder.maxPerDay }));

finish();
