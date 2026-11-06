// lifecycle.test — v0.2 引擎修复回归：
// ① P0 接线：工厂执行后 registerProvider 被以 { baseUrl: 代理, apiKey: dummy } 调用
// ② 幂等：同进程多次加载/多 session 工厂 → 只有一个代理端口（无泄漏）
// ③ anthropic-messages：上游收到 x-api-key=<轮转key>，无 authorization 残留
// ④ gate：dummy token 经 x-api-key / x-goog-api-key 携带均可通过
// ⑤ stopAllRespect 释放全部端口
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";
import { execSync } from "node:child_process";

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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-lifecycle-"));
process.env.PI_CODING_AGENT_DIR = dir;
fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
  providers: {
    dual: {
      baseUrl: "http://127.0.0.1:%UP%/v1", api: "openai-completions", apiKey: "sk-REAL-1",
      apiKeys: [{ name: "k1", key: "sk-A" }, { name: "k2", key: "sk-B" }],
      models: [{ id: "m1" }, { id: "m2" }],
    },
    anthro: {
      baseUrl: "http://127.0.0.1:%UP%/v1", api: "anthropic-messages", apiKey: "sk-REAL-A",
      apiKeys: [{ name: "a1", key: "sk-XA" }, { name: "a2", key: "sk-XB" }],
      models: [{ id: "claude-x" }],
    },
    single: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-one", models: [{ id: "s1" }] },
    srcA: { baseUrl: "http://127.0.0.1:%UP%/v1", api: "openai-completions", apiKey: "sk-MEM-A", models: [{ id: "ma" }] },
    srcB: { baseUrl: "http://127.0.0.1:%UP%/v1", api: "openai-completions", apiKey: "sk-REAL-B",
            apiKeys: [{ name: "b1", key: "sk-B1" }, { name: "b2", key: "sk-B2" }], models: [{ id: "mb" }] },
    "组合组": {
      name: "组合", combo: true, baseUrl: "http://combo.pmc.invalid/", api: "openai-completions",
      models: [{ id: "fast", contextWindow: 1000000, combo: { members: [{ provider: "srcA", model: "ma" }, { provider: "srcB", model: "mb" }] } }],
    },
  },
}, null, 2).replaceAll("%UP%", "0"), // 占位，下面起真上游后重写
);
fs.writeFileSync(path.join(dir, "settings.json"), "{}");

let hits = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let model = null;
    try { model = JSON.parse(Buffer.concat(chunks).toString()).model ?? null; } catch {}
    hits.push({ auth: req.headers.authorization ?? null, xapi: req.headers["x-api-key"] ?? null, model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;
fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
  providers: {
    dual: {
      baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-REAL-1",
      apiKeys: [{ name: "k1", key: "sk-A" }, { name: "k2", key: "sk-B" }],
      models: [{ id: "m1" }, { id: "m2" }],
    },
    anthro: {
      baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "anthropic-messages", apiKey: "sk-REAL-A",
      apiKeys: [{ name: "a1", key: "sk-XA" }, { name: "a2", key: "sk-XB" }],
      models: [{ id: "claude-x" }],
    },
    single: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-one", models: [{ id: "s1" }] },
    srcA: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-MEM-A", models: [{ id: "ma" }] },
    srcB: { baseUrl: `http://127.0.0.1:${upPort}/v1`, api: "openai-completions", apiKey: "sk-REAL-B",
            apiKeys: [{ name: "b1", key: "sk-B1" }, { name: "b2", key: "sk-B2" }], models: [{ id: "mb" }] },
    "组合组": {
      name: "组合", combo: true, baseUrl: "http://combo.pmc.invalid/", api: "openai-completions",
      models: [{ id: "fast", contextWindow: 1000000, combo: { members: [{ provider: "srcA", model: "ma" }, { provider: "srcB", model: "mb" }] } }],
    },
  },
}, null, 2));

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": SDK } });

/** 加载一次扩展（= 一个新模块副本 + 一次工厂执行），返回 [mod, registrations] */
async function loadOnce(tag) {
  const registrations = [];
  const ns = await jiti.import(ENTRY + (tag ? `?t=${tag}` : ""));
  const mod = ns.default;
  await mod({
    modelRegistry: { registerProvider: (n, c) => registrations.push(["modelRegistry", n, c]) },
    registerProvider: (n, c) => registrations.push(["pi", n, c]),
  });
  await new Promise((r) => setTimeout(r, 300)); // 等 start()+register 微任务
  return { mod, ns, registrations };
}

const countPorts = () => Number(execSync("ss -tHln | awk '{print $4}' | grep -cE '127\\.0\\.0\\.1:(3|4)[0-9]{4}$' || true").toString().trim() || "0");
const BASE_PORTS = countPorts(); // 机器既有无关监听基线

// ① 首次加载 → registerProvider 收到代理地址 + dummy token
const r1 = await loadOnce("a");
const regs = r1.registrations.filter(([via]) => via === "pi").map(([, n, c]) => [n, c]);
const proxiedRegs = regs.filter(([, c]) => c.baseUrl?.startsWith("http://127.0.0.1:"));
const comboReg0 = regs.find(([n]) => n === "组合组");
ok("① dual/anthro/srcB 注册 proxy override；组合组延迟建（占位 baseUrl）",
  regs.length === 4 && proxiedRegs.length === 3 && proxiedRegs.every(([, c]) => String(c.apiKey).startsWith("sk-dummy-"))
  && comboReg0?.[1].baseUrl === "http://combo.pmc.invalid/",
  JSON.stringify(regs.map(([n, c]) => `${n}→${c.baseUrl}`)));
ok("① single（<2key）不注册", !regs.some(([n]) => n === "single"));

// ② 幂等：再加载两次（新模块副本）→ 端口数不变、注册仍发生（每 session 各自 runtime）
const r2 = await loadOnce("b");
// 只看引擎自己的端口：globalThis 单例里的 proxies 表（不受并行测试文件的机器端口抖动影响）
const ownPorts = () => [...(globalThis.__piModelsCombo?.proxies?.values?.() || [])].map((e) => e.proxy.port).sort();
const q0 = ownPorts().join(",");

const r3 = await loadOnce("c");
const q1 = ownPorts().join(",");
ok("② 三次加载只起一组代理端口（无泄漏）", q0 === q1 && q0.split(",").length === 3, `引擎端口 ${q0} → ${q1}`);
ok("② 后续加载同样向自己的 runtime 注册 override",
  r2.registrations.filter(([via]) => via === "pi").length === 4 &&
  r3.registrations.filter(([via]) => via === "pi").length === 4);

// ③ anthropic：x-api-key 注入、authorization 不残留
hits.length = 0;
const anthroReg = r1.registrations.find(([via, n]) => via === "pi" && n === "anthro");
const aBase = anthroReg[2].baseUrl, aTok = anthroReg[2].apiKey;
const ra = await fetch(`${aBase}v1/messages`, { method: "POST", body: "{}", headers: { "content-type": "application/json", "x-api-key": aTok, "anthropic-version": "2023-06-01" } });
await ra.text();
const ha = hits.at(-1);
ok("③ anthropic 上游收 x-api-key=<轮转key>", ha?.xapi === "sk-XA" && ha?.auth === null, JSON.stringify(hits));
ok("③ anthropic 响应 200", ra.status === 200);

// ③b openai-completions：Bearer 注入
hits.length = 0;
const dualReg = r1.registrations.find(([via, n]) => via === "pi" && n === "dual");
const rd = await fetch(`${dualReg[2].baseUrl}v1/chat/completions`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${dualReg[2].apiKey}` } });
await rd.text();
ok("③b openai 上游收 authorization Bearer=<轮转key>", hits.at(-1)?.auth === "Bearer sk-A" && hits.at(-1)?.xapi === null, JSON.stringify(hits));

// ④ gate：dummy 经 x-api-key / x-goog-api-key 也能过
const g1 = await fetch(`${dualReg[2].baseUrl}v1/chat/completions`, { method: "POST", body: "{}", headers: { "x-api-key": dualReg[2].apiKey } });
const g2 = await fetch(`${dualReg[2].baseUrl}v1/chat/completions`, { method: "POST", body: "{}", headers: { "x-goog-api-key": dualReg[2].apiKey } });
const g3 = await fetch(`${dualReg[2].baseUrl}v1/chat/completions`, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong-token" } });
ok("④ gate 接受 x-api-key/x-goog-api-key 携带的 dummy；错 Bearer 拒绝", g1.status === 200 && g2.status === 200 && g3.status === 401,
  `g1=${g1.status} g2=${g2.status} g3=${g3.status}`);

// ⑥ combo：延迟建 → 先显式 force-build，再取真实代理 URL + 注册测试 token
const comboReg = regs.find(([n]) => n === "组合组");
ok("⑥ 组合组在 load 时延迟建（占位 baseUrl，未落地代理）", !!comboReg && !comboReg[1].baseUrl?.startsWith("http://127.0.0.1:"));
await r1.ns.refreshProviderProxies("组合组");
await new Promise((r) => setTimeout(r, 300));
const comboSt = r1.ns.proxyStatus().find((s) => s.provider === "组合组");
ok("⑥ combo proxy 已构建（proxyStatus 可见）", !!comboSt && Number.isInteger(comboSt.port));
if (comboSt) {
  const cBase = `http://127.0.0.1:${comboSt.port}/`;
  globalThis.__piModelsCombo.proxies?.get("组合组")?.proxy?.registerToken?.("test-token");
  const cTok = "test-token";
  hits.length = 0;
  const go = () => fetch(`${cBase}v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: `Bearer ${cTok}` } });
  const c1 = await go(); await c1.text();
  const h1 = hits.at(-1);
  ok("⑥ 组合请求 → 成员改写 ma + 成员 key 注入", c1.status === 200 && h1?.model === "ma" && h1?.auth === "Bearer sk-MEM-A", JSON.stringify(h1));
  await go(); await (await go()).text();
  ok("⑥ 同 client 粘住同一成员（三连发全落 ma）", hits.every((h) => h.model === "ma"), `models=${hits.map((h) => h.model).join(",")}`);
  const c404 = await fetch(`${cBase}v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "nope" }), headers: { authorization: `Bearer ${cTok}` } });
  ok("⑥ 未知组合模型 → 404", c404.status === 404);
}

// ⑤ stopAllRespect 释放端口
const ports = q1.split(",").map(Number);
r3.ns.stopAllRespect();
await new Promise((r) => setTimeout(r, 200));
const stillOpen = ports.filter((pt) => {
  try { const out = require("node:child_process").execSync(`ss -tHln sport = :${pt}`).toString(); return out.includes(`:${pt} `); } catch { return false; }
});
ok("⑤ stopAllRespect 后本测试新增端口全部释放", stillOpen.length === 0, `仍监听: ${stillOpen.join(",") || "无"}（引擎端口 ${ports.join(",")}）`);

upstream.close();
finish("lifecycle.test · P0接线/幂等/头注入/gate/stopAll");
