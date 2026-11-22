#!/usr/bin/env node
/**
 * aiti-acp-connector 冒烟测试——type=acp 兜底路径的连接器直测
 *
 * 验证 bin/aiti-acp-connector.mjs：stdio ⇄ Unix socket 纯字节双向转发，
 * 以及「cc-connect spawn 后立刻写 initialize 首帧而 socket 未就绪」的时序缓冲
 * （stdin 字节先缓冲、connect 后按序补发）——spawn 后立刻连写三帧。
 *
 * 用法：node tests/connector-smoke.mjs [socketPath]
 *   socketPath 缺省 = ~/.pi/web/data/aiti-channels/acp/default.sock
 * 退出码：0=全绿；1=失败。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONNECTOR = path.resolve(TESTS_DIR, "..", "bin", "aiti-acp-connector.mjs");
const SOCK = process.argv[2] || path.join(os.homedir(), ".pi", "web", "data", "aiti-channels", "config", "acp", "default.sock");
const CWD = path.join(os.homedir(), "workspace", "atest");

const proc = spawn(process.execPath, [CONNECTOR, "--socket", SOCK], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let failed = false;
const step = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
};

const waiters = [];   // { try(m): boolean } —— true=该消息归它、已 resolve
const seen = [];      // 全量留痕（响应可能先于 waiter 注册到达）
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    seen.push(m);
    for (let k = waiters.length - 1; k >= 0; k--) {
      if (waiters[k].try(m)) waiters.splice(k, 1);
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write("[connector:stderr] " + d));

const waitReply = (match, tag, ms = 20000) => {
  const hit = seen.find(match);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout: " + tag)), ms);
    waiters.push({ try: (m) => { if (match(m)) { clearTimeout(timer); resolve(m); return true; } return false; } });
  });
};
const rpc = (id, method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

console.log(`▶ F2 连接器 stdio⇄socket 转发（${SOCK}）`);

// 时序缓冲验证：spawn 后立刻连写三帧（此刻 socket 大概率未连通）
rpc(1, "initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "connector-smoke", version: "1.0.0" } });
rpc(2, "session/new", { cwd: CWD });
rpc(3, "session/list", {});

try {
  const init = await waitReply((m) => m.id === 1, "initialize reply");
  step("① initialize 经连接器回流（protocolVersion=1）", init.result?.protocolVersion === 1, JSON.stringify(init).slice(0, 120));

  const sn = await waitReply((m) => m.id === 2, "session/new reply");
  const sid = sn.result?.sessionId || "";
  step("② session/new 经连接器建真会话", sid.length > 10, JSON.stringify(sn).slice(0, 120));

  const ls = await waitReply((m) => m.id === 3, "session/list reply");
  step("③ session/list → -32601（未声明 list，字节双向含错误响应）", ls.error?.code === -32601, JSON.stringify(ls).slice(0, 120));

  if (sid) {
    rpc(4, "session/load", { sessionId: sid, cwd: CWD });
    const load = await waitReply((m) => m.id === 4, "session/load reply");
    step("④ session/load 经连接器重挂（同 id）", load.result?.sessionId === sid, JSON.stringify(load).slice(0, 120));
  }
} catch (e) {
  step("转发链路", false, e.message);
}

proc.stdin.end();
setTimeout(() => {
  try { proc.kill(); } catch {}
  console.log(failed ? "══ connector-smoke：失败" : "══ connector-smoke：全绿");
  process.exit(failed ? 1 : 0);
}, 500);
