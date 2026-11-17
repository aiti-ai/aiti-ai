/**
 * 「手机访问」纯逻辑单测（方案 §7 用例 9-16 的逻辑面；DOM 面由真机 A-I 覆盖）。
 * mobile-logic.ts 零 react/DOM 依赖，esbuild 打包为可测 bundle。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "../../../_shared/esbuild-bin.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "st-mobile-logic-"));

const esbuildBin = join(here, "..", "..", "node_modules", "esbuild", "bin", "esbuild");
const outfile = join(tmp, "mobile-logic.mjs");
await runEsbuild(esbuildBin, [join(here, "mobile-logic.ts"), "--bundle", "--format=esm", "--platform=neutral",
  "--outfile=" + outfile, "--log-level=error"]);
const logic = await import(pathToFileURL(outfile));

const recoBase = { port: 3000, hasUsers: false, self: { exposing: false, channels: [] } };

test("tierParams：三档 → policy/providerParams/标记（§3.4）", () => {
  assert.deepEqual(logic.tierParams("password"), { policy: "one_factor" });
  const face = logic.tierParams("face");
  assert.equal(face.policy, "two_factor");
  assert.deepEqual(face.providerParams, { biometrics: true });
  assert.equal(face.needFace, true);
  const totp = logic.tierParams("totp");
  assert.equal(totp.policy, "two_factor");
  assert.deepEqual(totp.providerParams, { biometrics: false });
  assert.equal(totp.needTotp, true);
});

test("confirmNeeded：唯一无认证候选 lan 必弹确认；portal 候选不弹（§3.3）", () => {
  assert.equal(logic.confirmNeeded({ id: "lan", available: true, risk: true, auth: "none" }), true);
  assert.equal(logic.confirmNeeded({ id: "portmap", available: true, auth: "portal", risk: true }), true);
  assert.equal(logic.confirmNeeded({ id: "vhost", available: true, auth: "portal" }), false);
});

test("pickCandidate：记住方案可用即用；失效回落 recommended 且标记 rememberedGone", () => {
  const reco = {
    ...recoBase,
    candidates: [
      { id: "vhost", available: true, recommended: true, auth: "portal" },
      { id: "tunnel", available: true, auth: "portal" },
      { id: "lan", available: true, risk: true, auth: "none" },
    ],
  };
  const hit = logic.pickCandidate(reco, { id: "tunnel" });
  assert.equal(hit.candidate.id, "tunnel");
  assert.equal(hit.rememberedGone, false);

  const gone = logic.pickCandidate(reco, { id: "ipv6" });
  assert.equal(gone.candidate.id, "vhost");
  assert.equal(gone.rememberedGone, true);

  // 无记住 → recommended（vhost）；lan 风险永不入选
  const fresh = logic.pickCandidate(reco, null);
  assert.equal(fresh.candidate.id, "vhost");
});

test("pickCandidate：全安全候选缺失 → null（fail-closed，S6 左）", () => {
  const reco = {
    ...recoBase,
    candidates: [
      { id: "lan", available: false, risk: true, auth: "none", reason: "allowlocal-off" },
      { id: "portmap", available: false, reason: "gateway-no-upnp" },
    ],
  };
  assert.equal(logic.pickCandidate(reco, { id: "vhost" }).candidate, null);
});

test("resolveReadyUrl：优先已暴露通道（不新开不停旧）；无认证通道不出码", () => {
  const exposing = {
    ...recoBase,
    self: { exposing: true, channels: [{ url: "https://t.example.com", noAuth: false }, { url: "http://1.2.3.4:80", noAuth: true }] },
    candidates: [{ id: "tunnel", available: true, url: "http://stale.example.com" }],
  };
  assert.equal(logic.resolveReadyUrl(exposing, exposing.candidates[0]), "https://t.example.com");

  const bare = { ...recoBase, candidates: [{ id: "vhost", available: true, url: "http://3000-pi-web.pi.localhost" }] };
  assert.equal(logic.resolveReadyUrl(bare, bare.candidates[0]), "http://3000-pi-web.pi.localhost");
});

test("schemeKey：候选 id → i18n 键（schemeVhost / schemePortmap）", () => {
  assert.equal(logic.schemeKey("vhost"), "mobile.schemeVhost");
  assert.equal(logic.schemeKey("portmap"), "mobile.schemePortmap");
});

test("MOBILE_KEY 与入口 key 契约", () => {
  assert.equal(logic.MOBILE_KEY, "service-tunnels:mobile");
  assert.equal(logic.REMEMBER_KEY, "pi:st:mobile-scheme:v1");
  assert.equal(logic.SOURCE_KEY, "pi:st:mobile-source:v1");
});

// ---- source switch + parametrized popup (sources-and-service plan §6, cases 1-3) ----

test("appendQuery：合并/同名覆盖/无 query 原样/带 ? 前缀/坏 URL", () => {
  const base = "https://pi.example.com:8443/dev/";
  assert.equal(logic.appendQuery(base, "pair=1"), "https://pi.example.com:8443/dev/?pair=1");
  assert.equal(logic.appendQuery(base, "?pair=1&x=2"), "https://pi.example.com:8443/dev/?pair=1&x=2");
  // same-name override (caller semantics win), the rest kept
  assert.equal(logic.appendQuery("https://x.example.com/?session=abc", "session=zzz"), "https://x.example.com/?session=zzz");
  assert.equal(logic.appendQuery("https://x.example.com/?a=1", "b=2"), "https://x.example.com/?a=1&b=2");
  // no/empty query passed through as-is; bad URL passed through as-is
  assert.equal(logic.appendQuery(base, ""), base);
  assert.equal(logic.appendQuery(base, undefined), base);
  assert.equal(logic.appendQuery("not a url", "a=1"), "not a url");
  assert.equal(logic.appendQuery(null, "a=1"), null);
});

test("launchUrlSafe：协议白名单 http/https，其余拒绝", () => {
  assert.equal(logic.launchUrlSafe("https://pi.example.com/?pair=1"), "https://pi.example.com/?pair=1");
  assert.equal(logic.launchUrlSafe("http://192.168.122.52:3001/dev"), "http://192.168.122.52:3001/dev");
  assert.equal(logic.launchUrlSafe("javascript:alert(1)"), null);
  assert.equal(logic.launchUrlSafe("file:///etc/passwd"), null);
  assert.equal(logic.launchUrlSafe("not a url"), null);
  assert.equal(logic.launchUrlSafe(undefined), null);
});

test("exposeToUrls：PortsTab 同序（url→localUrl→baseUrl→domainUrl→altUrls）去重保序、空值过滤", () => {
  const urls = logic.exposeToUrls({
    url: "https://a.example.com", localUrl: "http://127.0.0.1:5173",
    baseUrl: "https://a.example.com", // duplicates url → deduped
    domainUrl: null, altUrls: ["http://5173.st.localhost", "https://a.example.com"],
  });
  assert.deepEqual(urls, ["https://a.example.com", "http://127.0.0.1:5173", "http://5173.st.localhost"]);
  assert.deepEqual(logic.exposeToUrls({ url: null, altUrls: null }), []);
});

test("来源记忆：读写回环；非法 source/坏 JSON → null；ports 带 portUrl", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(logic.loadSourceMemory(storage), null);
  logic.saveSourceMemory(storage, { source: "ports", portUrl: "https://a.example.com" });
  assert.deepEqual(logic.loadSourceMemory(storage), { source: "ports", portUrl: "https://a.example.com" });
  logic.saveSourceMemory(storage, { source: "page" });
  assert.deepEqual(logic.loadSourceMemory(storage), { source: "page", portUrl: null });
  // legacy v1 value "self" migrated to "entry" (same semantics: expose the wizard tab); link is never memorized
  logic.saveSourceMemory(storage, { source: "self" });
  assert.deepEqual(logic.loadSourceMemory(storage), { source: "entry", portUrl: null });
  logic.saveSourceMemory(storage, { source: "link" });
  assert.equal(logic.loadSourceMemory(storage), null);
  // bad JSON
  mem.set(logic.SOURCE_KEY, "{{bad");
  assert.equal(logic.loadSourceMemory(storage), null);
  // no storage
  assert.equal(logic.loadSourceMemory(null), null);
  logic.saveSourceMemory(null, { source: "page" }); // must not throw
});

test("pickTunnelTool：记忆工具可用即用；失效回落候选默认/首个；非隧道候选 null", () => {
  const c = { id: "tunnel", tunnel: "cloudflared", tunnelOptions: ["cloudflared", "ngrok", "frpc"] };
  assert.equal(logic.pickTunnelTool(c, "ngrok"), "ngrok");
  assert.equal(logic.pickTunnelTool(c, null), "cloudflared");
  assert.equal(logic.pickTunnelTool(c, "gone"), "cloudflared"); // stale memory
  const noDefault = { id: "tunnel", tunnel: null, tunnelOptions: ["frpc", "ngrok"] };
  assert.equal(logic.pickTunnelTool(noDefault, null), "frpc");
  assert.equal(logic.pickTunnelTool({ id: "vhost" }, "ngrok"), null);
  assert.equal(logic.pickTunnelTool(null, "ngrok"), null);
});

test("pageReachability：回环/局域网/公网三档（v2 当前页源可达性提示）", () => {
  assert.equal(logic.pageReachability("http://127.0.0.1:3001/dev/"), "loopback");
  assert.equal(logic.pageReachability("http://localhost:3001/dev/"), "loopback");
  assert.equal(logic.pageReachability("http://foo.localhost:3001/"), "loopback");
  assert.equal(logic.pageReachability("http://192.168.122.52:3001/dev/"), "lan");
  assert.equal(logic.pageReachability("http://10.0.0.3/"), "lan");
  assert.equal(logic.pageReachability("http://172.16.3.1/"), "lan");
  assert.equal(logic.pageReachability("http://172.32.3.1/"), "public"); // 172.32 is outside the private ranges
  assert.equal(logic.pageReachability("https://pi.example.com:8443/dev/?session=x"), "public");
  assert.equal(logic.pageReachability("https://3001-pi-web.pi.example.com:8443/dev/"), "public");
  assert.equal(logic.pageReachability("not a url"), "public"); // fallback never false-positives
  assert.equal(logic.pageReachability(null), "public");
});

test("清理", () => { rmSync(tmp, { recursive: true, force: true }); });
