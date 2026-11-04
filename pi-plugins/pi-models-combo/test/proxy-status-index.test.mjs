// proxyStatus()（index 层）挂载测试：
// ① 工厂执行后 globalThis.__piModelsCombo.status 可调用，且与导出的 proxyStatus() 同源
// ② 返回各 provider 代理快照：多 key（≥2）与聚合组在内，单 key 不在；无任何 key 明文
// ③ refresh 入口仍可用（回归）
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

import { Tester } from "./util.mjs";

const SDK = process.env.PMC_SDK_DIST || "/home/wind/workspace/pi-prod/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-status-"));
process.env.PI_CODING_AGENT_DIR = dir;
const base = {
  dual: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "sk-REAL-1",
          apiKeys: [{ name: "k1", key: "sk-A" }, { name: "k2", key: "sk-B" }], models: [{ id: "m1" }] },
  single: { baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-one", models: [{ id: "s1" }] },
  srcA: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "sk-MEM-A", models: [{ id: "ma" }] },
  组合组: { name: "组合", combo: true, baseUrl: "http://combo.pmc.invalid/", api: "openai-completions",
          models: [{ id: "fast", combo: { members: [{ provider: "srcA", model: "ma" }, { provider: "dual", model: "m1" }] } }] },
  懒组: { name: "懒建组", combo: true, baseUrl: "http://combo.lazy.invalid/", api: "openai-completions",
          models: [{ id: "lazy", combo: { members: [{ provider: "srcA", model: "ma" }] } }] },
  坏组: { name: "解析失败组", combo: true, baseUrl: "http://combo.bad.invalid/", api: "openai-completions",
          models: [{ id: "bad", combo: { members: [{ provider: "不存在", model: "x" }] } }] },
};
fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: base }, null, 2));
fs.writeFileSync(path.join(dir, "settings.json"), "{}");

const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": SDK } });
const ns = await jiti.import(ENTRY + "?t=status-" + Date.now());
await ns.default({
  registerProvider: () => {},
  on: () => {},
});
await new Promise((r) => setTimeout(r, 300)); // 等 start() 落定

// ① status 挂载可用
const g = globalThis;
ok("globalThis.__piModelsCombo.status 已挂载", typeof g.__piModelsCombo?.status === "function");
ok("导出 proxyStatus 与挂载同源", ns.proxyStatus === g.__piModelsCombo.status);

// ①' 未构建的懒建 combo 也应在 status 里（built:false，无 entries）——不 refresh 直接查
let arr = ns.proxyStatus();
let byPid0 = Object.fromEntries(arr.map((s) => [s.provider, s]));
ok("懒建组（未 refresh）已在 status，built:false", byPid0["懒组"]?.isCombo === true && byPid0["懒组"]?.built === false && Array.isArray(byPid0["懒组"]?.entries) && byPid0["懒组"]?.entries.length === 0,
  JSON.stringify(arr.map((s) => ({ p: s.provider, b: s.built, is: s.isCombo }))));
ok("解析失败组（成员 provider 不存在）也在 status，built:false", byPid0["坏组"]?.isCombo === true && byPid0["坏组"]?.built === false);
ok("解析失败组带 configError 提示（非误导性激活提示）", typeof byPid0["坏组"]?.configError === "string" && byPid0["坏组"].configError.length > 0, JSON.stringify(byPid0["坏组"]));
ok("正常懒建组无 configError", byPid0["懒组"]?.configError === undefined);
ok("未构建组不带 key 明文且无槽位统计", !JSON.stringify(byPid0["懒组"]).includes("sk-") && byPid0["懒组"].saturation?.length === 0);
ok("未构建组带 configModels（虚拟模型数）", byPid0["懒组"]?.configModels === 1, JSON.stringify(byPid0["懒组"]));

// ② 组合组是「延迟建」：默认会话不预建代理 → 先显式 force-build（refreshProviderProxies）再断言它在状态里
ns.refreshProviderProxies("组合组");
await new Promise((r) => setTimeout(r, 300));

arr = ns.proxyStatus();
ok("proxyStatus() 返回数组", Array.isArray(arr));
const byPid = Object.fromEntries(arr.map((s) => [s.provider, s]));
ok("多 key provider（dual）在内", !!byPid.dual, JSON.stringify(arr.map((s) => s.provider)));
ok("聚合组（组合组）在内", !!byPid["组合组"]);
ok("单 key provider（single）不在", !byPid.single);
ok("组合组带 isCombo 标记", byPid["组合组"].isCombo === true);
ok("状态快照带 port/upstream", Number.isInteger(byPid.dual.port) && typeof byPid.dual.upstream === "string");
// ②' 构建后的组合组 built:true（区别于懒建未构建态）
ok("构建后的组合组 built:true", byPid["组合组"].built === true, JSON.stringify({ b: byPid["组合组"].built }));

// ② 无 key 明文
const blob = JSON.stringify(arr);
ok("不含 key 明文（sk-A/sk-B/sk-REAL-1/sk-one 均不出现在快照）",
  !blob.includes("sk-A") && !blob.includes("sk-B") && !blob.includes("sk-REAL") && !blob.includes("sk-one"));
// ②' upstream 无 userinfo 凭据（base 里 dual 为普通地址，这里补一个带凭据的多 key provider 再查）
const sec = { baseUrl: "https://u:secretpass@example.com/v1", api: "openai-completions", apiKey: "sk-X", apiKeys: [{ name: "s1", key: "sk-X" }, { name: "s2", key: "sk-Y" }], models: [{ id: "m" }] };
fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { ...base, sec } }, null, 2));
ns.refreshProviderProxies("sec");
const arr2 = ns.proxyStatus();
const secUp = arr2.find((s) => s.provider === "sec")?.upstream ?? "";
ok("upstream userinfo 脱敏（无 secretpass）", !String(secUp).includes("secretpass") && !String(secUp).includes("u@"), String(secUp));

// ③ refresh 仍可用（回归）
const refreshed = ns.refreshProviderProxies();
ok("refreshProviderProxies 可用", Array.isArray(refreshed));

ns.stopAllRespect();
finish("proxyStatus() 挂载");
