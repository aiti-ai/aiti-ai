#!/usr/bin/env node
/**
 * aiti-acp-connector 故障语义测试
 *
 * 覆盖连接器在 pi-web 异常场景下的行为承诺（见 bin/aiti-acp-connector.mjs 头注）：
 *   I2-A socket 未就绪：500ms×60 重试窗内进程存活、stdin 字节缓冲不丢不炸；
 *        30s 重试耗尽 → exit(1)（cc-connect 收到子进程退出并报错，无孤儿 pi 进程）。
 *   I2-B 已连通后 socket 被对端关闭 → teardown 退出（不悬挂）。
 *
 * 用法：node tests/connector-fail.mjs
 * 耗时：~35s（I2-A 的重试耗尽分支需要完整等待）。
 * 退出码：0=全绿；1=失败。
 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONNECTOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "aiti-acp-connector.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "connector-fail-"));
let failed = 0;
const step = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${!ok && detail ? " — " + detail : ""}`);
  if (!ok) failed++;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
console.log("▶ I2-A socket 未就绪：重试窗内存活 + 缓冲；耗尽后 exit(1)");
{
  const missing = path.join(TMP, "never-listening.sock");
  const proc = spawn(process.execPath, [CONNECTOR, "--socket", missing], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr += d.toString(); });
  await new Promise((r) => setTimeout(r, 2000));
  step("2s 时仍在重试（未崩溃未退出）", alive(proc.pid), `stderr=${stderr.slice(0, 80)}`);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 300));
  step("重试期间 stdin 写入不炸（缓冲）", alive(proc.pid));
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 35000);
    proc.on("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  step(`重试耗尽（30s 窗）后退出 code=1`, code === 1, `code=${code}`);
  step("放弃前打了重试日志", stderr.includes("未就绪") || stderr.includes("重试"), stderr.slice(-120));
}

// ---------------------------------------------------------------------------
console.log("▶ I2-B 已连通后 socket 被对端关闭 → stdout EOF，宿主关 stdin → 连接器自然退出");
{
  const sockPath = path.join(TMP, "closing.sock");
  const server = net.createServer((c) => {
    // 收到首帧后立即断开，模拟 pi-web 停机
    c.once("data", () => c.destroy());
  });
  await new Promise((r) => server.listen(sockPath, r));
  const proc = spawn(process.execPath, [CONNECTOR, "--socket", sockPath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdoutEnded = false;
  proc.stdout.on("end", () => { stdoutEnded = true; });
  await new Promise((r) => setTimeout(r, 500)); // 等 connect
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await new Promise((r) => setTimeout(r, 300));
  // 宿主（cc-connect）看到 agent stdout EOF 后的标准动作：关掉子进程 stdin
  proc.stdin.end();
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), 5000);
    proc.on("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  step("socket 断开 → stdout EOF 传到宿主", stdoutEnded);
  step("宿主关 stdin 后连接器自然退出（不悬挂）", code === 0, `code=${code}`);
  server.close();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? "══ connector-fail：失败" : "══ connector-fail：全绿");
process.exit(failed ? 1 : 0);
