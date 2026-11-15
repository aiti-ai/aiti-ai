#!/usr/bin/env node
/**
 * publish-cws.mjs — Chrome Web Store Publish API 发布脚本
 *
 * 凭据：~/.aiti/store-credentials.json 的 cws 节（client_id/client_secret/refresh_token/itemId），
 *       不进 git；(itemId) 在首次后台创建 item 后补写进凭据文件。
 *
 * 用法：
 *   node scripts/publish-cws.mjs                # 上传 dist/aiti-devtools-chrome.zip + 发布
 *   node scripts/publish-cws.mjs --status       # 仅查 item 状态
 *   node scripts/publish-cws.mjs --upload-only  # 仅上传草稿，不发布
 *   node scripts/publish-cws.mjs --zip <path>   # 指定 zip 路径（默认 dist/aiti-devtools-chrome.zip）
 *   node scripts/publish-cws.mjs --target trustedTesters  # 发布目标（default=公开 / trustedTesters=内测）
 *
 * API：PUT  https://www.googleapis.com/upload/chromewebstore/v1.1/items/{itemId}   （上传，Content-Type: application/zip）
 *      POST https://www.googleapis.com/chromewebstore/v1.1/items/{itemId}/publish （发布，body {"publishTarget":...}）
 *      GET  https://www.googleapis.com/chromewebstore/v1.1/items/{itemId}?projection=DRAFT （状态）
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const credPath = join(process.env.HOME || process.env.USERPROFILE, ".aiti", "store-credentials.json");

const args = process.argv.slice(2);
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const hasFlag = (name) => args.includes(name);

if (!existsSync(credPath)) {
  console.error(`✗ 凭据文件缺失: ${credPath}`);
  process.exit(1);
}
const creds = JSON.parse(readFileSync(credPath, "utf8")).cws || {};
const { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN } = creds;
const ITEM_ID = process.env.CWS_ITEM_ID || creds.itemId;
if (!ITEM_ID) {
  console.error("✗ 缺 itemId：首次上架请在 CWS 后台手动创建 item（API 不能建新 item），然后把 itemId 写进 ~/.aiti/store-credentials.json 的 cws.itemId，或用 env CWS_ITEM_ID 传入。");
  process.exit(1);
}

const curlJson = (args_) => JSON.parse(execFileSync("curl", ["-s", ...args_], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

// 1) refresh → access_token
const tok = curlJson(["-X", "POST", "https://oauth2.googleapis.com/token",
  "-d", `client_id=${CLIENT_ID}`, "-d", `client_secret=${CLIENT_SECRET}`,
  "-d", `refresh_token=${REFRESH_TOKEN}`, "-d", "grant_type=refresh_token"]);
if (!tok.access_token) {
  console.error("✗ refresh 失败:", JSON.stringify(tok).slice(0, 300));
  process.exit(1);
}
const AT = tok.access_token;
console.log("✓ access_token OK (expires_in=%s)", tok.expires_in);

const BASE = "https://www.googleapis.com";
const AUTH = [`-H`, `Authorization: Bearer ${AT}`, `-H`, `x-goog-api-version: 2`];

// 2) status
const status = () => {
  const r = curlJson([...AUTH, "-X", "GET", `${BASE}/chromewebstore/v1.1/items/${ITEM_ID}?projection=DRAFT`]);
  console.log(JSON.stringify(r, null, 2));
};

if (hasFlag("--status")) { status(); process.exit(0); }

// 3) upload
const zipPath = resolve(getArg("--zip", join(root, "dist", "aiti-devtools-chrome.zip")));
if (!existsSync(zipPath)) {
  console.error(`✗ zip 不存在: ${zipPath}（先 npm run build && npm run package）`);
  process.exit(1);
}
const up = curlJson([...AUTH, "-X", "PUT",
  "-H", "Content-Type: application/zip",
  "--data-binary", `@${zipPath}`,
  `${BASE}/upload/chromewebstore/v1.1/items/${ITEM_ID}`]);
if (up.error) {
  console.error("✗ 上传失败:", JSON.stringify(up).slice(0, 500));
  process.exit(1);
}
console.log("✓ 上传成功: itemVersion=%s", up.itemVersion);

if (hasFlag("--upload-only")) { console.log("→ --upload-only，止于草稿"); process.exit(0); }

// 4) publish
const target = getArg("--target", "default");
const pub = curlJson([...AUTH, "-X", "POST", "-H", "Content-Type: application/json",
  "-d", JSON.stringify({ publishTarget: target }),
  `${BASE}/chromewebstore/v1.1/items/${ITEM_ID}/publish`]);
if (pub.error) {
  console.error("✗ 发布失败:", JSON.stringify(pub).slice(0, 500));
  process.exit(1);
}
console.log("✓ 发布提交成功: status=%s", JSON.stringify(pub.statusInfo || pub.status));
console.log("→ 审核结果稍后在后台查看（/devconsole）");
