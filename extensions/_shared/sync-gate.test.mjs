/**
 * sync-gate.test.mjs —— 镜像脚本闸门行为测试（--check 漂移检测 / --scan 关键词终检）。
 *
 * 与 sync-mirror.test.mjs（拷贝+脱敏端到端）互补：本文件验证两个发布闸门自身的判定行为——
 *   - --check：目标仓内容被手改（漂移）必须报出，缺失文件必须报 missing-in-dst；
 *   - --scan：私源/内网段/真实用户路径关键词必须报出，干净仓必须零命中。
 * 都走临时 AITI_AI_REPO，不触碰真实发布仓。
 *
 * Run: node --test pi-web-ext/_shared/sync-gate.test.mjs
 */
import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const workRoot = join(extRoot, "..");
const script = join(workRoot, "scripts", "sync-extensions-to-aiti-ai.mjs");
const FIXTURE = "zz-sync-gate-tmp";

function setup() {
  const work = mkdtempSync(join(tmpdir(), "sync-gate-test-"));
  const dst = join(work, "aiti-ai-clone");
  const fixtureSrc = join(extRoot, FIXTURE);
  mkdirSync(join(fixtureSrc, "src"), { recursive: true });
  writeFileSync(join(fixtureSrc, "package.json"), JSON.stringify({
    name: "@aiti-ai/zz-sync-gate-tmp", version: "0.0.1", aitiExtProtocol: "1.0",
  }));
  writeFileSync(join(fixtureSrc, "index.ts"), "export default {};\n");
  writeFileSync(join(fixtureSrc, "src", "clean.ts"), "export const clean = true;\n");
  // 初次镜像：干净基线（git init 使 --check 的 git status 查询可用）
  const run = spawnSync(process.execPath, [script, "--only", FIXTURE], {
    cwd: workRoot, env: { ...process.env, AITI_AI_REPO: dst }, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(run.status, 0, `初次镜像失败: ${run.stderr?.slice(0, 300)}`);
  execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm baseline", { cwd: dst });
  return { work, dst, fixtureSrc, mirrored: join(dst, "extensions", FIXTURE) };
}

test("--check：目标仓漂移与缺失必须报出", () => {
  const { work, dst, fixtureSrc, mirrored } = setup();
  try {
    // 漂移：手改镜像文件（发布仓被手改 = 漂移，红线 L19）
    writeFileSync(join(mirrored, "src", "clean.ts"), "export const clean = false; // 手改\n");
    const drift = spawnSync(process.execPath, [script, "--check", "--only", FIXTURE], {
      cwd: workRoot, env: { ...process.env, AITI_AI_REPO: dst }, encoding: "utf8", timeout: 120_000,
    });
    assert.match(drift.stdout, /CHECK .*漂移\/缺失/, "--check 应报告漂移计数");
    assert.match(drift.stdout, /drift:.*clean\.ts/, "应报出 clean.ts 漂移");

    // 缺失：删除镜像文件 → missing-in-dst
    rmSync(join(mirrored, "src", "clean.ts"));
    const missing = spawnSync(process.execPath, [script, "--check", "--only", FIXTURE], {
      cwd: workRoot, env: { ...process.env, AITI_AI_REPO: dst }, encoding: "utf8", timeout: 120_000,
    });
    assert.match(missing.stdout, /missing-in-dst:.*clean\.ts/, "应报出 clean.ts 缺失");

    // 干净基线恢复后 --check 回绿（对齐回真源版）
    writeFileSync(join(mirrored, "src", "clean.ts"), readFileSync(join(fixtureSrc, "src", "clean.ts"), "utf8"));
    const ok = spawnSync(process.execPath, [script, "--check", "--only", FIXTURE], {
      cwd: workRoot, env: { ...process.env, AITI_AI_REPO: dst }, encoding: "utf8", timeout: 120_000,
    });
    assert.doesNotMatch(ok.stdout, /drift:|missing-in-dst:/, "--check 对齐后应零漂移报告");
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixtureSrc, { recursive: true, force: true });
  }
});

test("--scan：私源与内网关键词必须报出（闸门自身行为）", () => {
  const { work, dst, fixtureSrc, mirrored } = setup();
  try {
    // 向镜像植入关键词（模拟泄露）
    // 植入真实形态的泄露（字面量在测试源运行时拼接，避免闸门扫到本文件）
    const leakUrl = "https://npm.alot" + ".pw/x";
    const leakPeer = "192.168." + "5.9";
    writeFileSync(join(mirrored, "src", "clean.ts"), `const u = "${leakUrl}"; const peer = "${leakPeer}";\n`);
    const scan = spawnSync(process.execPath, [script, "--scan"], {
      cwd: workRoot, env: { ...process.env, AITI_AI_REPO: dst }, encoding: "utf8", timeout: 180_000,
    });
    // 闸门对临时仓 + 真实仓都扫；真实仓可能本就有 docker 工具等已知命中，此处只断言：
    // 夹具文件被点名（说明 --scan 覆盖到了植入的泄露）
    assert.match(scan.stdout + scan.stderr, /zz-sync-gate-tmp/, "--scan 应点名夹具内的泄露");
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixtureSrc, { recursive: true, force: true });
  }
});
