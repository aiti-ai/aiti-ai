/**
 * aiti-agent-manager — agents-registry 纯模块测试（descriptor 收集 / fs 探测 / 聚合 / piHost）。
 *
 * Run: node --test pi-web-ext/aiti-agent-manager/agents-registry.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_DESCRIPTOR_SUFFIX, collectAgents, aggregateAgent, probeAuthEntries,
  readPiHostAuthProviders, toPiHostProvider,
} from "./agents-registry.ts";

const HOME = "/home/u";

test("collectAgents：动态收集（跳过未 provide/禁用/不合法），按 agent 名排序", () => {
  const status = {
    "aiti-zcode-agent": {},
    "aiti-codebuddy-agent": {},
    "aiti-extra": {},                    // 未 provide 描述符 → 跳过
    "aiti-disabled": { enabled: false }, // 禁用 → 跳过
  };
  const services = {
    get: (k) => {
      if (k === "aiti-zcode-agent" + AGENT_DESCRIPTOR_SUFFIX) return { agent: "zcode", label: "ZCode", modes: ["url"] };
      if (k === "aiti-codebuddy-agent" + AGENT_DESCRIPTOR_SUFFIX) return { agent: "codebuddy", label: "CBC", modes: ["apikey", "tui"] };
      if (k === "aiti-disabled" + AGENT_DESCRIPTOR_SUFFIX) return { agent: "x", label: "X", modes: [] };
      if (k === "aiti-extra" + AGENT_DESCRIPTOR_SUFFIX) return { label: "缺 agent" }; // 不合法 → 跳过
      return undefined;
    },
  };
  const got = collectAgents({ status, getService: services.get });
  assert.deepEqual(got.map((c) => c.def.agent), ["codebuddy", "zcode"], "按 agent 字典序");
  assert.equal(got[0].extId, "aiti-codebuddy-agent");
});

test("collectAgents：status 缺失 → 空表（集群未就绪不炸）", () => {
  assert.deepEqual(collectAgents({ status: null, getService: () => undefined }), []);
  assert.deepEqual(collectAgents({ status: undefined, getService: () => undefined }), []);
});

test("probeAuthEntries：file 命中（非空）/ 空文件跳过 / dir 存在即命中 / env 非空命中", () => {
  const root = mkdtempSync(join(tmpdir(), "am-probe-"));
  try {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", ".credentials.json"), "{}");
    mkdirSync(join(root, ".qoder"), { recursive: true });
    const fs = { existsSync: (p) => existsSync(p), statSync: (p) => statSync(p) };
    assert.equal(probeAuthEntries([{ kind: "file", path: [".claude", ".credentials.json"], label: "x" }], root, {}, fs), "ready");
    assert.equal(probeAuthEntries([{ kind: "dir", path: [".qoder"], label: "x" }], root, {}, fs), "ready");
    assert.equal(probeAuthEntries([{ kind: "file", path: [".missing", "a.json"], label: "x" }], root, {}, fs), "missing");
    assert.equal(probeAuthEntries([{ kind: "env", path: ["ZCODE_API_KEY"], label: "x" }], root, { ZCODE_API_KEY: "k" }, fs), "ready");
    assert.equal(probeAuthEntries([{ kind: "env", path: ["ZCODE_API_KEY"], label: "x" }], root, { ZCODE_API_KEY: "  " }, fs), "missing", "空白 env 不算");
    assert.equal(probeAuthEntries([], root, {}, fs), "missing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aggregateAgent：扩展智能端点（state 归一）优先于 fs", () => {
  const def = { agent: "codebuddy", label: "CBC", modes: ["apikey"], extReportsAuthState: true, auth: [{ kind: "file", path: [".codebuddy", "settings.json"], label: "x" }] };
  const hit = aggregateAgent(def, { home: HOME, env: {}, fs: { existsSync: () => true, statSync: () => ({ size: 1 }) }, extStatus: { state: "ready" } });
  assert.equal(hit.authState, "ready");
  assert.equal(hit.source, "ext");
  const miss = aggregateAgent(def, { home: HOME, env: {}, fs: { existsSync: () => true, statSync: () => ({ size: 1 }) }, extStatus: { state: "missing" } });
  assert.equal(miss.authState, "missing");
});

test("aggregateAgent：流程态 waiting → logging-in；其余 idle", () => {
  const def = { agent: "claude", label: "Claude", modes: ["paste"], auth: [{ kind: "file", path: [".claude", ".credentials.json"], label: "x" }] };
  const fs = { existsSync: (p) => p.endsWith(".credentials.json"), statSync: () => ({ size: 3 }) };
  const a = aggregateAgent(def, { home: HOME, env: {}, fs, extStatus: { state: "waiting" } });
  assert.equal(a.flowState, "logging-in");
  assert.equal(a.authState, "ready");
  assert.equal(a.source, "fs");
  const b = aggregateAgent(def, { home: HOME, env: {}, fs, extStatus: { state: "success" } });
  assert.equal(b.flowState, "idle");
});

test("aggregateAgent：无候选表且无智能端点 → unknown（fail-honest）", () => {
  const def = { agent: "qoder", label: "Qoder", modes: ["url"], auth: [] };
  const a = aggregateAgent(def, { home: HOME, env: {}, fs: { existsSync: () => false, statSync: () => ({ size: 0 }) }, extStatus: null });
  assert.equal(a.authState, "unknown");
  assert.equal(a.source, "none");
});

test("toPiHostProvider：name 优先于 email；无字段省略", () => {
  const p = toPiHostProvider("openai", { type: "oauth", name: "李永", email: "a@b.c", expires: "2099-01-01T00:00:00.000Z" });
  assert.equal(p.user, "李永");
  assert.equal(p.expired, false);
  assert.equal(toPiHostProvider("x", {}).user, undefined);
});

test("readPiHostAuthProviders：只取展示字段（token 不出服务端）+ 坏文件容错", () => {
  const doc = JSON.stringify({
    zai: { type: "oauth", email: "me@x.com", access: "SECRET-A", refresh: "SECRET-R", expires: "2099-01-01T00:00:00.000Z" },
    bad: "not-object",
  });
  const list = readPiHostAuthProviders("/agent", () => doc);
  assert.equal(list.length, 1);
  assert.equal(list[0].provider, "zai");
  assert.equal(list[0].user, "me@x.com");
  assert.equal(JSON.stringify(list).includes("SECRET"), false, "token 不返回");
  assert.deepEqual(readPiHostAuthProviders("/agent", () => null), []);
  assert.deepEqual(readPiHostAuthProviders("/agent", () => "{broken"), []);
});
