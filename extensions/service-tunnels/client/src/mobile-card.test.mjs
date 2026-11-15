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
});

test("清理", () => { rmSync(tmp, { recursive: true, force: true }); });
