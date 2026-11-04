// 三包联调测试：aiti-model-wizard 写入多 key → aiti-model-check 读同一份 keys → 代理用这批 key 轮转。
// 全部走临时目录，不碰真实 ~/.pi/agent/models.json。
// 依赖：pi-web-ext 的两个 core.cjs（可用环境变量覆盖路径）。
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { fileURLToPath } from "node:url";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, Tester } from "./util.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // aiti-ai/
const WIZ = process.env.AITI_WIZARD_CORE || path.join(root, "pi-web-ext", "aiti-model-wizard", "core.cjs");
const CHK = process.env.AITI_CHECK_CORE || path.join(root, "pi-web-ext", "aiti-model-check", "core.cjs");

let wz, mc;
try { wz = require(WIZ); } catch (e) { console.error("找不到 aiti-model-wizard core：" + WIZ + "\n" + e.message); process.exit(1); }
try { mc = require(CHK); } catch (e) { console.error("找不到 aiti-model-check core：" + CHK + "\n" + e.message); process.exit(1); }

const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-integ-"));
const modelsFile = path.join(dir, "models.json");
const cfg = { modelsPath: modelsFile };

// ① wizard 保存 provider + 3 key（重复名 k2→k2-2、空 key 过滤、rpm、minIntervalMs）
const save = await wz.upsertProvider(dir, cfg, {
  provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions",
  keys: [{ name: "k1", key: "sk-aaa", rpm: 60, minIntervalMs: "auto" }, { name: "k2", key: "sk-bbb" }, { name: "k2", key: "sk-ccc" }, { name: "", key: "" }],
  models: [{ id: "openai/gpt-4o" }],
});
ok("① wizard upsertProvider ok", !!save.ok);
const mj = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
const pk = mj.providers.openrouter.apiKeys;
ok("① apiKeys 写入 models.json（3 个）", Array.isArray(pk) && pk.length === 3, JSON.stringify(pk.map((k) => k.name)));
ok("① 重复名自动去重 k2→k2-2", pk[1].name === "k2" && pk[2].name === "k2-2");
ok("① 空 key 被过滤（无空 key）", pk.every((k) => k.key));
ok("① apiKey 恒 = 第一个 key", mj.providers.openrouter.apiKey === "sk-aaa");
ok("① rpm 保留", pk[0].rpm === 60);
ok("① minIntervalMs:auto 保留（wizard 不剥未知字段）", pk[0].minIntervalMs === "auto", JSON.stringify(pk[0]));
ok("① 未配 minIntervalMs 的 key 不补字段", pk[1].minIntervalMs === undefined);

// ② model-check 读到同一份 keys（名字/rpm/minIntervalMs 与 models.json 完全一致）
const ck = mc.getProviderKeys(cfg, "openrouter");
const same = JSON.stringify(ck.map((k) => [k.name, k.key, k.rpm, k.minIntervalMs])) === JSON.stringify(pk.map((k) => [k.name, k.key, k.rpm, k.minIntervalMs]));
ok("② check 读到与 models.json 一致的 keys", same, ck.map((k) => k.name).join(","));
ok("② rpm 一致", ck[0].rpm === 60);
ok("② minIntervalMs 一致（auto → check 同样读到）", ck[0].minIntervalMs === "auto", JSON.stringify(ck[0]));

// ③ 用这批 key 起代理：sk-aaa 429 → 轮转 sk-bbb 200
const hits = [];
const { createServer } = await import("node:http");
const upstream = createServer((req, res) => { req.on("data", () => {}); req.on("end", () => { const k = req.headers.authorization.slice(7); hits.push(k); if (k === "sk-aaa") { res.writeHead(429, { "retry-after": "1" }); res.end("{}"); } else { res.writeHead(200, {}); res.end(JSON.stringify({ ok: true, key: k })); } }); });
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const authToken = "sk-dummy-" + (await import("node:crypto")).randomBytes(8).toString("hex");
const proxy = new ProxyServer({ provider: "openrouter", upstream: `http://127.0.0.1:${upstream.address().port}`, apiKeys: ck, port: await freeP(), authToken });
await proxy.start();
const r = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
const j = await r.json();
ok("③ 代理用 wizard 写入/check 读到的 key 轮转：429→200", r.status === 200 && j.key === "sk-bbb", `hits=${JSON.stringify(hits)}`);
ok("③ 命中顺序 [sk-aaa, sk-bbb]（先限流 key 后正常 key）", JSON.stringify(hits) === '["sk-aaa","sk-bbb"]');
proxy.stop(); upstream.close();

// ④ wizard 清空多 key → apiKeys/apiKey 一并删除
const clear = wz.setProviderKeys(dir, cfg, "openrouter", []);
const mj2 = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
ok("④ setProviderKeys([]) 清空：apiKeys 删除", !("apiKeys" in mj2.providers.openrouter));
ok("④ 清空后 apiKey 同步删除", !("apiKey" in mj2.providers.openrouter));
ok("④ check 读到空", mc.getProviderKeys(cfg, "openrouter").length === 0);

fs.rmSync(dir, { recursive: true, force: true });
finish("integration.test · wizard → check → 代理 联调");
