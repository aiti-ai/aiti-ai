/**
 * aiti-acp-agent — 后端注册表单测 + 装机直播握手（codex / cursor，2026-11-08 接入）。
 *
 * 钉死：
 *   1. 注册表含 codex（bin codex-acp，resolve 解析）与 cursor（bin cursor-agent，args acp）；
 *   2. 注册表卫生：name 唯一、每条要么有 resolve 要么有 bin；
 *   3. resolveCodexAcp：PATH 有 codex-acp → 直连；无 → npx 兜底或 null（不 throw）；
 *   4. 直播握手（环境依赖，二进制缺失自动跳过——视为环境问题非代码问题）：
 *      codex-acp / cursor-agent acp 的 initialize 应答 protocolVersion=1。
 *
 * Run: node --test pi-web-ext/aiti-acp-agent/acp-registry.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

const { ACP_AGENTS, resolveCodexAcp } = await import("./index.ts");

const HOME_BIN_DIRS = [
  process.env.HOME ? join(process.env.HOME, ".npm-global", "bin") : "",
  process.env.HOME ? join(process.env.HOME, ".local", "bin") : "",
  "/usr/local/bin",
].filter(Boolean);

function findBin(bin) {
  for (const dir of [...process.env.PATH.split(":"), ...HOME_BIN_DIRS]) {
    try {
      const p = join(dir, bin);
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* not here */ }
  }
  return null;
}

test("注册表含 codex + cursor 条目（2026-11-08 接入）", () => {
  const codex = ACP_AGENTS.find((a) => a.name === "codex");
  assert.ok(codex, "codex 后端存在");
  assert.equal(codex.bin, "codex-acp");
  assert.equal(codex.agentKey, "codex");
  assert.equal(typeof codex.resolve, "function", "codex 走 resolve（PATH 直装 + npx 兜底）");

  const cursor = ACP_AGENTS.find((a) => a.name === "cursor");
  assert.ok(cursor, "cursor 后端存在");
  assert.equal(cursor.bin, "cursor-agent");
  assert.deepEqual(cursor.args, ["acp"], "cursor-agent acp 子命令（非 flag）");
  assert.equal(cursor.agentKey, "cursor");
});

test("注册表卫生：name 唯一，每条有 resolve 或 bin", () => {
  const names = ACP_AGENTS.map((a) => a.name);
  assert.equal(new Set(names).size, names.length, "name 不重复");
  for (const a of ACP_AGENTS) {
    assert.ok(typeof a.resolve === "function" || (typeof a.bin === "string" && a.bin), `${a.name}: resolve 或 bin 必备`);
    assert.ok(Array.isArray(a.args), `${a.name}: args 数组`);
  }
});

test("resolveCodexAcp：PATH 直装优先，缺装走 npx 兜底或 null（不 throw）", () => {
  const resolved = resolveCodexAcp();
  const direct = findBin("codex-acp");
  if (direct) {
    assert.ok(resolved, "codex-acp 已装 → 必须解析成功");
    assert.equal(resolved.args.length, 0);
    assert.ok(resolved.bin.endsWith("codex-acp"), `直连路径 ${resolved.bin}`);
  } else {
    // 未装：npx 兜底（node <npx-cli> -y @agentclientprotocol/codex-acp）或 null
    if (resolved) {
      assert.ok(resolved.args.includes("-y"), "npx 兜底带 -y");
      assert.ok(resolved.args.includes("@agentclientprotocol/codex-acp"), "npx 兜底指向官方包");
    }
  }
});

/** 直播 initialize 握手（20s 宽限；二进制缺失 → skip，环境依赖非代码问题）。 */
function liveInitialize(binPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("initialize timeout (20s)"))), 20_000);
    child.stdout.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        const i = buf.indexOf(0x0a);
        if (i === -1) break;
        const line = buf.subarray(0, i).toString("utf8");
        buf = buf.subarray(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) done(() => resolve(msg));
        } catch { /* non-json line（启动 banner 等）忽略 */ }
      }
    });
    child.stderr.on("data", () => { /* 噪音日志忽略 */ });
    child.on("error", (err) => done(() => reject(err)));
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    }) + "\n");
  });
}

test("直播握手：codex-acp initialize 应答 protocolVersion=1（环境依赖）", async (t) => {
  const binPath = findBin("codex-acp") ?? (() => {
    const r = resolveCodexAcp();
    return r && r.args.includes("@agentclientprotocol/codex-acp") ? null : r?.bin ?? null;
  })();
  if (!binPath) return t.skip("codex-acp 未安装（装机才接）");
  const msg = await liveInitialize(binPath, []);
  assert.equal(msg.result?.protocolVersion, 1);
  assert.ok(msg.result?.agentCapabilities, "应宣告 agentCapabilities");
});

test("直播握手：cursor-agent acp initialize 应答 protocolVersion=1（环境依赖）", async (t) => {
  const binPath = findBin("cursor-agent");
  if (!binPath) return t.skip("cursor-agent 未安装（装机才接）");
  const msg = await liveInitialize(binPath, ["acp"]);
  assert.equal(msg.result?.protocolVersion, 1);
  assert.equal(msg.result?.agentCapabilities?.loadSession, true, "cursor 宣告 loadSession");
});
