// refreshProviderProxies 补建回归测试：
// ① 手工编辑 models.json 给「从未有代理」的 provider 加了多 key → refresh 应直接补建代理（不等待新会话）
// ② 已有代理的 provider 手工加了第 4 把 key → refresh 原地更新槽位（updateEntries 生效，新 key 会被用到）
// ③ refresh 全部：补建所有 ≥2key 缺失代理；provider 被删除 → 停止并移除代理
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";

import { freeP, Tester } from "./util.mjs";

const SDK = process.env.PMC_SDK_DIST || "/home/pi/workspace/pi-prod/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
// jiti 与 SDK 环境绑定（默认 48 形态）：PMC_SDK_DIST / PMC_JITI 可覆盖；都不可解析 → 干净跳过（非报错）
const req = createRequire(SDK);
const JITI_MJS = process.env.PMC_JITI || (() => { try { return req.resolve("jiti/lib/jiti.mjs"); } catch { return ""; } })();
if (!fs.existsSync(SDK) || !JITI_MJS) {
  console.log(`[skip] 需要 pi SDK + jiti（PMC_SDK_DIST / PMC_JITI 可指定）：SDK=${fs.existsSync(SDK)} jiti=${JITI_MJS || "未解析"}`);
  process.exit(0);
}
const { createJiti } = await import(pathToFileURL(JITI_MJS).href);
const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-refresh-create-"));
process.env.PI_CODING_AGENT_DIR = dir;
const modelsPath = path.join(dir, "models.json");
fs.writeFileSync(path.join(dir, "settings.json"), "{}");

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
    hits.push({ auth, xapi: req.headers["x-api-key"] ?? null, model: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()).model; } catch { return null; } })() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;
let hits = [];

function writeModels(providers) {
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2));
}
// 初始：只有 1 个 ≥2key 的 provider（存在代理）→ 之后手工改 models.json 模拟"新 provider 被加多 key"
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }], models: [{ id: "m" }] },
});

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": SDK } });
const ns = await jiti.import(ENTRY + `?t=rc${Date.now()}`);
const mod = ns.default;
await mod({ modelRegistry: {}, registerProvider: () => {} });
await new Promise((r) => setTimeout(r, 300));

const state = globalThis.__piModelsCombo;
const ownPorts = () => [...(state?.proxies?.values?.() || [])].map((e) => e.proxy.port).sort((a, b) => a - b);
const proxyPort = (pid) => { const e = state.proxies.get(pid); return e?.proxy.port; };
// 给指定 provider 的代理注册一把测试用 token（模拟会话 registerToken 接入）
const regTok = (pid, tok) => { const e = state.proxies.get(pid); if (e?.proxy?.registerToken) e.proxy.registerToken(tok); };
const send = (port, tok) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", body: JSON.stringify({ model: "m", messages: [] }), headers: { authorization: `Bearer ${tok}` },
}).then((r) => r.text()).catch(() => null);

ok("前置：initial 加载为 existing 建了代理", !!proxyPort("existing"), `port=${proxyPort("existing")}`);
const baseCount = ownPorts().length;

// ── ① 手工加一个从未有代理的 provider（4 把 key，绕过向导）→ refresh 补建 ──
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }], models: [{ id: "m" }] },
  handy: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-H1",
    apiKeys: [{ name: "h1", key: "sk-H1", rpm: 5, minIntervalMs: 0 }, { name: "h2", key: "sk-H2", rpm: 5, minIntervalMs: 0 },
              { name: "h3", key: "sk-H3", rpm: 5, minIntervalMs: 0 }, { name: "h4", key: "sk-H4", rpm: 5, minIntervalMs: 0 }], models: [{ id: "m" }] },
});
ok("① 前置：handy 还没有代理", !proxyPort("handy"));
const r1 = state.refresh("handy");
ok("① refresh(handy) 返回 refreshed 含 handy", Array.isArray(r1) && r1.includes("handy"), JSON.stringify(r1));
await new Promise((r) => setTimeout(r, 300));
ok("① refresh 补建了 handy 代理（端口新增）", !!proxyPort("handy") && ownPorts().length === baseCount + 1,
  `ports=${ownPorts().join(",")}`);
// 穿过新代理发请求 → 上游收到某把轮转 key
regTok("handy", "tok-h1");
hits.length = 0;
await send(proxyPort("handy"), "tok-h1");
ok("① handy 代理转发成功（上游收到轮转 key）", hits.length === 1 && /^sk-H[1-4]$/.test(hits[0].auth), JSON.stringify(hits));

// ── ② 已有代理的 provider 手工加第 4 把 key → refresh 原地更新（不新增端口）──
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }, { name: "e3", key: "sk-E3" }, { name: "e4", key: "sk-E4" }], models: [{ id: "m" }] },
  handy: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-H1",
    apiKeys: [{ name: "h1", key: "sk-H1", rpm: 5, minIntervalMs: 0 }, { name: "h2", key: "sk-H2", rpm: 5, minIntervalMs: 0 },
              { name: "h3", key: "sk-H3", rpm: 5, minIntervalMs: 0 }, { name: "h4", key: "sk-H4", rpm: 5, minIntervalMs: 0 }], models: [{ id: "m" }] },
});
const r2 = state.refresh("existing");
ok("② refresh(existing) 返回含 existing", Array.isArray(r2) && r2.includes("existing"));
await new Promise((r) => setTimeout(r, 200));
ok("② 更新不新增端口（原地 updateEntries）", ownPorts().length === baseCount + 1, `ports=${ownPorts().join(",")}`);
hits.length = 0;
for (let i = 0; i < 12; i++) { regTok("existing", "tok-e" + i); await send(proxyPort("existing"), "tok-e" + i); }
const seenKeys = [...new Set(hits.map((h) => h.auth))].sort();
ok("② 第 4 把 key 被纳入轮转（e4 出现）", seenKeys.includes("sk-E4"), `seen=${seenKeys.join(",")}`);

// ── ③ refresh 全部：一次补建多个缺失代理；删除 provider → 代理停止 ──
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }], models: [{ id: "m" }] },
  handy: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-H1",
    apiKeys: [{ name: "h1", key: "sk-H1" }, { name: "h2", key: "sk-H2" }], models: [{ id: "m" }] },
  brandNew: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-N1",
    apiKeys: [{ name: "n1", key: "sk-N1" }, { name: "n2", key: "sk-N2" }, { name: "n3", key: "sk-N3" }], models: [{ id: "m" }] },
  onlyOne: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-O1", models: [{ id: "m" }] },
});
const r3 = state.refresh();
ok("③ refresh 全部返回 3 个 ≥2key provider", Array.isArray(r3) && ["existing", "handy", "brandNew"].every((p) => r3.includes(p)), JSON.stringify(r3));
await new Promise((r) => setTimeout(r, 300));
ok("③ brandNew（新多 key）被补建；handy 降为 2key 后仍保持", !!proxyPort("brandNew") && !!proxyPort("handy") && !proxyPort("onlyOne"),
  `ports=${ownPorts().join(",")}`);
// 删除 handy → refresh 全部 → 代理停止移除
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }], models: [{ id: "m" }] },
  brandNew: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-N1",
    apiKeys: [{ name: "n1", key: "sk-N1" }, { name: "n2", key: "sk-N2" }, { name: "n3", key: "sk-N3" }], models: [{ id: "m" }] },
});
state.refresh();
await new Promise((r) => setTimeout(r, 200));
ok("③ 删除 provider → refresh 后代理停止移除", !proxyPort("handy") && !!proxyPort("brandNew"));

// ── ④ 临时禁用（enabled:false）── key 级不入轮转 / provider 级停代理 / 重启用恢复 ──
// ④a key 级：3 key 中 1 把 enabled:false → refresh 后槽位只含 2 把启用 key（禁用 key 永不发出）
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2", enabled: false }, { name: "e3", key: "sk-E3" }], models: [{ id: "m" }] },
  brandNew: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-N1",
    apiKeys: [{ name: "n1", key: "sk-N1" }, { name: "n2", key: "sk-N2" }, { name: "n3", key: "sk-N3" }], models: [{ id: "m" }] },
});
state.refresh("existing");
await new Promise((r) => setTimeout(r, 200));
hits.length = 0;
for (let i = 0; i < 8; i++) { regTok("existing", "tok-e" + i); await send(proxyPort("existing"), "tok-e" + i); }
const seenAfterDisable = [...new Set(hits.map((h) => h.auth))].sort();
ok("④a 禁用 key（e2）不入轮转：只发 e1/e3", seenAfterDisable.includes("sk-E1") && seenAfterDisable.includes("sk-E3") && !seenAfterDisable.includes("sk-E2"), `seen=${seenAfterDisable.join(",")}`);
// ④b provider 级 enabled:false → refresh 停代理（端口消失，配置保留）
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }], models: [{ id: "m" }] },
  brandNew: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-N1",
    apiKeys: [{ name: "n1", key: "sk-N1" }, { name: "n2", key: "sk-N2" }, { name: "n3", key: "sk-N3" }], models: [{ id: "m" }] },
  disabledProv: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-D1", enabled: false,
    apiKeys: [{ name: "d1", key: "sk-D1" }, { name: "d2", key: "sk-D2" }], models: [{ id: "m" }] },
});
const r4 = state.refresh();
ok("④b refresh 全部返回不含 disabledProv（禁用=停止非刷新，配置在但无代理）", Array.isArray(r4) && !r4.includes("disabledProv") && r4.includes("existing"), JSON.stringify(r4));
await new Promise((r) => setTimeout(r, 200));
ok("④b 禁用 provider 无代理（端口消失）", !proxyPort("disabledProv") && !!proxyPort("existing") && !!proxyPort("brandNew"), `ports=${ownPorts().join(",")}`);
// ④c 重新启用（去掉 enabled:false）→ refresh 恢复代理
writeModels({
  existing: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-E1",
    apiKeys: [{ name: "e1", key: "sk-E1" }, { name: "e2", key: "sk-E2" }], models: [{ id: "m" }] },
  brandNew: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-N1",
    apiKeys: [{ name: "n1", key: "sk-N1" }, { name: "n2", key: "sk-N2" }, { name: "n3", key: "sk-N3" }], models: [{ id: "m" }] },
  disabledProv: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-D1",
    apiKeys: [{ name: "d1", key: "sk-D1" }, { name: "d2", key: "sk-D2" }], models: [{ id: "m" }] },
});
state.refresh("disabledProv");
await new Promise((r) => setTimeout(r, 200));
ok("④c 重新启用 → 代理恢复", !!proxyPort("disabledProv"), `ports=${ownPorts().join(",")}`);

ns.stopAllRespect();
upstream.close();
finish("refresh-create.test · refresh 补建/原地更新/清理");
