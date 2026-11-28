import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSignedRequest, canonicalQuery, OPENAPI_HOST } from "./sigv4.ts";
import { readConfig, writeConfig, isConfigured, maskSecret, isVolcengineApiHost, DEFAULT_PROVIDER_IDS } from "./config.ts";
import { normalizeArkPlanPayload, createArkPlanAdapter, canonicalWindowLabel, isAuthHardStop } from "./adapter.ts";
import { ArkApiError } from "./ark-api.ts";
import ext from "../index.ts";

const CTX = { providerId: "ark-plan", auth: {} };

// ---------- sigv4 ----------

const FIXED_NOW = new Date("2026-11-28T08:09:10Z");

test("sigv4 builds a deterministic signed request for a fixed clock", () => {
  const signed = buildSignedRequest({
    accessKeyId: "AKTEST",
    secretAccessKey: "SKTEST",
    action: "GetCodingPlanUsage",
    now: FIXED_NOW,
  });
  assert.equal(signed.url, `https://${OPENAPI_HOST}/?Action=GetCodingPlanUsage&Region=cn-beijing&Version=2024-01-01`);
  assert.equal(signed.headers["X-Date"], "20261128T080910Z");
  assert.equal(signed.headers["X-Content-Sha256"], // sha256 of empty body
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const auth = signed.headers.Authorization;
  assert.match(auth, /^HMAC-SHA256 Credential=AKTEST\/20261128\/cn-beijing\/ark\/request, /);
  assert.match(auth, /SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=[0-9a-f]{64}$/);
  // Deterministic: same inputs → same signature.
  const again = buildSignedRequest({ accessKeyId: "AKTEST", secretAccessKey: "SKTEST", action: "GetCodingPlanUsage", now: FIXED_NOW });
  assert.equal(again.headers.Authorization, auth);
});

test("sigv4 signature changes with the secret key and region", () => {
  const a = buildSignedRequest({ accessKeyId: "AK", secretAccessKey: "SK1", action: "GetAFPUsage", now: FIXED_NOW });
  const b = buildSignedRequest({ accessKeyId: "AK", secretAccessKey: "SK2", action: "GetAFPUsage", now: FIXED_NOW });
  const c = buildSignedRequest({ accessKeyId: "AK", secretAccessKey: "SK1", action: "GetAFPUsage", region: "cn-guangzhou", now: FIXED_NOW });
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
  assert.notEqual(a.headers.Authorization, c.headers.Authorization);
  assert.match(c.url, /Region=cn-guangzhou/);
});

test("canonical query sorts keys alphabetically", () => {
  assert.equal(canonicalQuery({ action: "A", region: "r", version: "v" }), "Action=A&Region=r&Version=v");
});

// ---------- config ----------

test("config roundtrip, masking, and host pinning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-usage-test-"));
  try {
    assert.deepEqual(readConfig(dir), {});
    assert.equal(isConfigured(readConfig(dir)), false);
    writeConfig(dir, { accessKeyId: "AKIDexample1234", secretAccessKey: "SKSECRETvalue1234", region: "cn-beijing", gatewayHost: "open.volcengineapi.com", product: "auto", providerIds: ["ark-plan"] });
    const cfg = readConfig(dir);
    assert.equal(cfg.accessKeyId, "AKIDexample1234");
    assert.equal(isConfigured(cfg), true);
    assert.equal(maskSecret("AKIDexample1234"), "AKID…1234");
    // Stat: file must be 0600 (it carries secrets).
    const { statSync } = await import("node:fs");
    const mode = statSync(join(dir, "config.json")).mode & 0o777;
    assert.equal(mode, 0o600);
    // Host pinning: non-volcengine hosts are dropped by the normalizer.
    const bad = writeConfig(dir, { gatewayHost: "evil.example.com" });
    assert.equal(bad.gatewayHost, undefined);
    assert.equal(isVolcengineApiHost("ark.cn-beijing.volcengineapi.com"), true);
    assert.equal(isVolcengineApiHost("evil.example.com"), false);
    // Region sanitation: malformed values are dropped.
    const badRegion = writeConfig(dir, { region: "not a region!" });
    assert.equal(badRegion.region, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default provider ids target ark-plan", () => {
  assert.deepEqual(DEFAULT_PROVIDER_IDS, ["ark-plan"]);
});

// ---------- normalize ----------

test("normalize parses Coding Plan percent windows into stable labels", () => {
  const payload = {
    ResponseMetadata: { Action: "GetCodingPlanUsage", Region: "cn-beijing", Version: "2024-01-01", Service: "ark" },
    Result: {
      Status: "ok",
      UpdateTimestamp: 1_764_000_000,
      HasReward: true,
      QuotaUsage: [
        { Level: "5h", Percent: 32, ResetTime: 1_764_003_600 },
        { Level: "1w", Percent: 45.5, ResetTime: 1_764_600_000 },
        { Level: "1mo", Percent: 60, ResetTime: 1_767_225_600 },
      ],
    },
  };
  const report = normalizeArkPlanPayload(payload, CTX);
  assert.equal(report.providerId, "ark-plan");
  assert.equal(report.providerName, "Volcano Ark Plan");
  assert.deepEqual(report.buckets.map((b) => b.label), ["5h", "1w", "1mo"]);
  const fiveHour = report.buckets[0];
  assert.equal(fiveHour.unit, "percent");
  assert.equal(fiveHour.used, 32);
  assert.equal(fiveHour.remaining, 68);
  assert.equal(fiveHour.limit, 100);
  assert.equal(fiveHour.resetsAt, 1_764_003_600);
  assert.equal(report.exhausted, undefined);
  assert.deepEqual(report.metrics[0], { id: "plan", label: "Plan", value: "Coding Plan" });
  assert.ok(report.metrics.some((m) => m.id === "reward" && m.value === "included"));
});

test("normalize parses Agent Plan absolute windows with exhaustion", () => {
  const payload = {
    ResponseMetadata: { Action: "GetAFPUsage" },
    Result: {
      Status: "ok",
      AFPFiveHour: { Quota: 100, Used: 30, ResetTime: 1_764_003_600 },
      AFPDaily: { Quota: 50, Used: 0, ResetTime: 1_764_108_000 },
      AFPWeekly: { Quota: 700, Used: 700, ResetTime: 1_764_600_000 },
      AFPMonthly: { Quota: 3000, Used: 1000, ResetTime: 1_767_225_600 },
    },
  };
  const report = normalizeArkPlanPayload(payload, CTX);
  // Daily window (live API surface, 2026-11-28) sorts between 5h and weekly.
  assert.deepEqual(report.buckets.map((b) => b.label), ["5h", "1d", "1w", "1mo"]);
  assert.equal(report.buckets[1].limit, 50);
  const weekly = report.buckets[2];
  assert.equal(weekly.unit, "count");
  assert.equal(weekly.used, 700);
  assert.equal(weekly.remaining, 0);
  assert.equal(weekly.limit, 700);
  assert.equal(weekly.status, "exhausted");
  assert.equal(report.exhausted, true);
  assert.deepEqual(report.metrics[0], { id: "plan", label: "Plan", value: "Agent Plan" });
});

test("normalize prefers real totals on Coding Plan rows that carry absolutes", () => {
  const payload = {
    Result: { QuotaUsage: [{ Level: "1mo", Percent: 40, Used: 400, Total: 1000, ResetTime: 1767225600 }] },
  };
  const report = normalizeArkPlanPayload(payload, CTX);
  assert.equal(report.buckets[0].unit, "count");
  assert.equal(report.buckets[0].limit, 1000);
  assert.equal(report.buckets[0].remaining, 600);
});

test("normalize rejects error envelopes and window-less results", () => {
  assert.throws(() => normalizeArkPlanPayload({ ResponseMetadata: { Error: { Code: "NotSubscribed", Message: "no plan" } } }, CTX));
  assert.throws(() => normalizeArkPlanPayload({ Result: { Status: "ok" } }, CTX), /no plan quota windows/);
  assert.throws(() => normalizeArkPlanPayload({}, CTX));
});

test("canonicalWindowLabel maps provider spellings onto stable names", () => {
  assert.equal(canonicalWindowLabel("5h"), "5h");
  assert.equal(canonicalWindowLabel("Five Hour"), "5h");
  assert.equal(canonicalWindowLabel("session"), "5h");
  assert.equal(canonicalWindowLabel("daily"), "1d");
  assert.equal(canonicalWindowLabel("1d"), "1d");
  assert.equal(canonicalWindowLabel("weekly"), "1w");
  assert.equal(canonicalWindowLabel("7d"), "1w");
  assert.equal(canonicalWindowLabel("Monthly"), "1mo");
  assert.equal(canonicalWindowLabel("30d"), "1mo");
  assert.equal(canonicalWindowLabel("weird-window"), "weird-window");
});

test("auth-shaped failures hard-stop the plan fallback (dsh-aligned matching)", () => {
  const mk = (code, status) => {
    const e = new ArkApiError("probe");
    if (code !== undefined) e.code = code;
    if (status !== undefined) e.status = status;
    return e;
  };
  assert.equal(isAuthHardStop(mk("SignatureDoesNotMatch")), true);
  assert.equal(isAuthHardStop(mk("InvalidAccessKeyId")), true);
  assert.equal(isAuthHardStop(mk("AccessDenied")), true);
  assert.equal(isAuthHardStop(mk("InvalidToken")), true);
  assert.equal(isAuthHardStop(mk("InternalError", 401)), true);
  assert.equal(isAuthHardStop(mk("InternalError", 403)), true);
  assert.equal(isAuthHardStop(mk("InternalError", 500)), false);
  assert.equal(isAuthHardStop(mk(undefined)), false);
  assert.equal(isAuthHardStop(new Error("plain")), false);
});

// ---------- adapter / registration chain ----------

test("adapter query fails honestly without AK/SK config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-usage-empty-"));
  try {
    const adapter = createArkPlanAdapter(dir, "ark-plan");
    await assert.rejects(adapter.query(CTX), /AK\/SK is not configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup registers one adapter per provider id (default ark-plan)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-usage-startup-"));
  try {
    const registered = [];
    const fakeCtx = { configDir: dir, usageAdapters: { register: (adapter) => { registered.push(adapter); return { ok: true }; } } };
    ext.server.startup(fakeCtx);
    assert.equal(registered.length, 1);
    const adapter = registered[0];
    assert.equal(adapter.id, "ark-plan");
    assert.equal(adapter.displayName, "Volcano Ark Plan");
    assert.equal(adapter.exactIdOnly, true);
    assert.deepEqual(adapter.origins, [`https://${OPENAPI_HOST}`]);
    assert.equal(typeof adapter.query, "function");
    assert.equal(typeof adapter.normalize, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup registers additional provider ids from config and rejects duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "ark-usage-ids-"));
  try {
    writeConfig(dir, { providerIds: ["ark-plan", "ark-coding"] });
    const seen = [];
    const rejections = [];
    const fakeCtx = { configDir: dir, usageAdapters: { register: (adapter) => {
      if (seen.some((a) => a.id === adapter.id)) { rejections.push(adapter.id); return { ok: false, reason: "builtin-conflict" }; }
      seen.push(adapter);
      return { ok: true };
    } } };
    ext.server.startup(fakeCtx);
    assert.deepEqual(seen.map((a) => a.id), ["ark-plan", "ark-coding"]);
    assert.deepEqual(rejections, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup without a host slot or config dir is a no-op (no throw)", () => {
  ext.server.startup({});
  ext.server.startup(undefined);
});
