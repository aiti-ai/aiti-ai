#!/usr/bin/env node
/**
 * aiti-configs · git clean/smudge/merge filter（密文 commit 核心）
 *
 * 用法（由 .git/config 的 filter/merge 配置调用，git 在 add/checkout/merge 时执行）：
 *   filter.mjs enc                     读 stdin 明文 → stdout 密文（git add 时 clean）
 *   filter.mjs dec                     读 stdin 密文 → stdout 明文（git checkout 时 smudge）
 *   filter.mjs merge %A %O %B          三方合并（密文 → 解密明文合并 → 明文冲突标记写回 %A）
 *
 * 密钥：AITI_CONFIGS_KEY_FILE 环境变量或默认 ~/.pi/agent/.configs-key（base64 32B）
 * 格式与 core.cjs 的 encryptText/decryptText 一致（ENC1:<iv>:<tag>:<ct>，确定性 IV）
 * 纯 Node 零依赖，可在任意 git 进程独立运行（无需 pi-web 进程活着）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

function keyFile() {
  return process.env.AITI_CONFIGS_KEY_FILE || path.join(os.homedir(), ".pi", "agent", ".configs-key");
}
function loadKey() {
  try { return Buffer.from(fs.readFileSync(keyFile(), "utf8").trim(), "base64"); } catch (e) { return null; }
}
function enc(key, s) {
  const iv = crypto.createHmac("sha256", key).update(String(s)).digest().subarray(0, 12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(s), "utf8"), c.final()]);
  return "ENC1:" + iv.toString("base64") + ":" + c.getAuthTag().toString("base64") + ":" + ct.toString("base64");
}
function dec(key, s) {
  if (typeof s !== "string" || !s.startsWith("ENC1:")) return s;
  try {
    const [, ivB, tagB, ctB] = s.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  } catch (e) { return s; }
}
function readStdin() { return fs.readFileSync(0, "utf8"); }

const cmd = process.argv[2];
const key = loadKey();

if (cmd === "enc") {
  if (!key) process.exit(1); // 无 key 拒绝（防误入明文）
  process.stdout.write(enc(key, readStdin()));
} else if (cmd === "dec") {
  if (!key) { process.stdout.write(readStdin()); process.exit(0); } // 无 key：透传（工作区保持原样）
  process.stdout.write(dec(key, readStdin()));
} else if (cmd === "merge") {
  // %A ours %O base %B theirs（均为密文）→ 解密 → git merge-file 明文三方合并 → 写回 %A（明文冲突标记）
  const [A, O, B] = process.argv.slice(3);
  if (!key || !A || !B) process.exit(1);
  try {
    const a = dec(key, fs.readFileSync(A, "utf8"));
    const o = O && fs.existsSync(O) ? dec(key, fs.readFileSync(O, "utf8")) : "";
    const b = dec(key, fs.readFileSync(B, "utf8"));
    fs.writeFileSync(A, a);
    fs.writeFileSync(A + ".o", o);
    fs.writeFileSync(A + ".b", b);
    try {
      execFileSync("git", ["merge-file", A, A + ".o", A + ".b"], { stdio: "ignore" });
      fs.unlinkSync(A + ".o"); fs.unlinkSync(A + ".b");
      process.exit(0); // 无冲突
    } catch (e) {
      // 有冲突：%A 已含明文冲突标记（git 会标记该文件为冲突，工作区可明文解决）
      try { fs.unlinkSync(A + ".o"); } catch {}
      try { fs.unlinkSync(A + ".b"); } catch {}
      process.exit(1);
    }
  } catch (e) { process.exit(1); }
} else if (cmd === "textconv") {
  // git diff textconv：读文件（密文）→ stdout 明文（版本对比/restore 预览可读明文 diff）
  const file = process.argv[3];
  if (!file || !key) process.exit(0);
  try { process.stdout.write(dec(key, fs.readFileSync(file, "utf8"))); } catch (e) { process.exit(0); }
} else {
  process.exit(2);
}
