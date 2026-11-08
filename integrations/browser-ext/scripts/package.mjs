#!/usr/bin/env node
/**
 * package.mjs —— 把 dist/{chrome,edge,firefox} 打包为 zip；firefox 额外产出 .xpi。
 * 用法：node scripts/package.mjs [targets...]（缺省全部）
 *
 * xpi 本质 = manifest.json 在 zip 根的包（内容与 zip 完全一致，仅扩展名不同）：
 *   - Firefox ESR / DevEdition / Nightly：about:config 开 xpinstall.signatures.required=false
 *     后可直接「从文件安装」该 xpi（永久，重启不消失）
 *   - Firefox for Android / 正式版：需 AMO 签名后才可永久安装——
 *     web-ext sign --channel=unlisted（需 AMO API Key/Secret）或 AMO 后台上传本 xpi 走 unlisted 签名；
 *     临时载入（about:debugging）不需要签名
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");
const targets = process.argv.slice(2).filter((t) => !t.startsWith("-"));
const all = targets.length ? targets : ["chrome", "edge", "firefox"];

for (const t of all) {
  const dir = join(dist, t);
  if (!existsSync(dir)) { console.error("✗ dist/" + t + " not found (run npm run build first)"); continue; }
  const zip = join(dist, "aiti-devtools-" + t + ".zip");
  rmSync(zip, { force: true });
  try {
    // the zip must not contain an outer dist/<t>/ directory (extracting yields manifest.json at root)
    execFileSync("zip", ["-r", "-q", zip, "."], { cwd: dir });
    console.log("✓ " + zip);
  } catch (e) {
    console.error("✗ zip packaging failed (system zip required): " + (e && e.message));
    continue;
  }
  if (t === "firefox") {
    // firefox emits the .xpi directly (same content as the zip; Android/release permanent installs need AMO signing, ESR/Nightly/DevEdition are signature-free)
    const xpi = join(dist, "aiti-devtools-firefox.xpi");
    rmSync(xpi, { force: true });
    copyFileSync(zip, xpi);
    console.log("✓ " + xpi);
  }
}
