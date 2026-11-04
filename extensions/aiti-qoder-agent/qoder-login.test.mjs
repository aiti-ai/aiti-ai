/**
 * aiti-qoder-agent — 登录 driver 单测（D6）。
 *
 * qoder 协议核心在 qoder-core.mjs（WASM 解密/REST，网络面）；可离线钉死的协议关键面
 * 是受控登录 driver（双区域 bin / URL 提取 / 结果判定）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-login.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { qoderLoginBin, resolveQoderCli, extractQoderLoginUrl, interpretQoderLogin, qoderLoginDriver } = await import("./login-driver.ts");

test("qoderLoginBin：intl= qodercli / cn= qoderclicn", () => {
  assert.equal(qoderLoginBin("intl"), "qodercli");
  assert.equal(qoderLoginBin("cn"), "qoderclicn");
});

test("resolveQoderCli：env 绝对路径命中直返", () => {
  const prev = process.env.QODER_CLI_PATH;
  process.env.QODER_CLI_PATH = process.execPath; // 真实可执行文件
  try {
    assert.equal(resolveQoderCli("intl"), process.execPath);
  } finally {
    if (prev === undefined) delete process.env.QODER_CLI_PATH;
    else process.env.QODER_CLI_PATH = prev;
  }
});

test("resolveQoderCli：PATH 未命中时安装位兜底（Windows 装态：~/.qoder-cn/bin/qoderclicn/）", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "qoder-cli-home-"));
  try {
    const exe = process.platform === "win32" ? "qoderclicn.exe" : "qoderclicn";
    const installDir = join(fakeHome, ".qoder-cn", "bin", "qoderclicn");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, exe), "#!/bin/sh\n");
    const prev = process.env.QODER_CLI_CN_PATH;
    process.env.QODER_CLI_CN_PATH = "qoderclicn-not-on-this-path"; // 绕开本机真实 PATH 命中
    try {
      const resolved = resolveQoderCli("cn", fakeHome);
      // 约定的 env 名不会命中安装位——清掉 env 后按裸名兜底
      assert.equal(resolved, null);
      delete process.env.QODER_CLI_CN_PATH;
      const hit = resolveQoderCli("cn", fakeHome);
      assert.ok(hit && hit.endsWith(exe), `期望兜底到安装位，实得 ${hit}`);
    } finally {
      if (prev !== undefined) process.env.QODER_CLI_CN_PATH = prev;
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("extractQoderLoginUrl：提取登录 URL（含 query）；无 URL → null", () => {
  const url = extractQoderLoginUrl("请打开 https://qoder.com/device/selectAccounts?token=abc&x=1 完成登录");
  assert.equal(url, "https://qoder.com/device/selectAccounts?token=abc&x=1");
  assert.equal(extractQoderLoginUrl("nothing here"), null);
});

test("interpretQoderLogin：退出码 0=success；其余 failed（stderr 尾行优先）", () => {
  assert.deepEqual(interpretQoderLogin(0, "", ""), { state: "success" });
  const failed = interpretQoderLogin(1, "stdout tail", "stderr: login timeout");
  assert.equal(failed.state, "failed");
  assert.ok(String(failed.error).includes("login timeout"));
});

test("qoderLoginDriver 契约：agentId/mode/extractUrl/interpret 齐全（controlled-login 共享层约定）", () => {
  assert.equal(qoderLoginDriver.agentId, "qoder");
  assert.equal(qoderLoginDriver.mode, "url"); // qoder 登录走 URL 展示（非 paste 回填）
  assert.equal(typeof qoderLoginDriver.extractUrl, "function");
  assert.equal(typeof qoderLoginDriver.interpret, "function");
  assert.equal(typeof qoderLoginDriver.buildLogin, "function");
});
