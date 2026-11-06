/**
 * sync-mirror.test.mjs —— aiti-ai 镜像脚本功能级测试（夹具端到端）。
 *
 * 覆盖发布链路的机械脱敏/排除契约（2026-11-06 两处真实泄露的回归闸）：
 *   - TEXT_EXT 含 .py：python 源码必须过 transform（/home/pi → /home/pi），
 *     此前 .py 原样拷贝把真实用户路径带进发布仓（fix 7754e2d5）；
 *   - EXCLUDE_NAMES 含 __pycache__、EXCLUDE_SUFFIX 含 .pyc：任意嵌套层级的
 *     字节码缓存不得进镜像（文件系统拷贝绕过 gitignore，fix 1f36caca 前置）；
 *   - 私源 URL（npm.example.com → registry.npmjs.org）与内网段（192.168.122.N →
 *     192.168.122.N）两条核心脱敏规则在非 ts/js 文本上同样生效；
 *   - .log 落地产物排除。
 *
 * 机制：AITI_AI_REPO 指向临时 DST + --only 夹具扩展，不触碰真实 aiti-ai 仓。
 * Run: node --test pi-web-ext/_shared/sync-mirror.test.mjs
 */
import { spawnSync } from "node:child_process";
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
const FIXTURE = "zz-sync-fixture-tmp";

test("镜像脚本：.py 脱敏、pycache/log 排除、私源与内网段改写（夹具端到端）", () => {
  const work = mkdtempSync(join(tmpdir(), "sync-mirror-test-"));
  const dst = join(work, "aiti-ai-clone");
  const fixtureSrc = join(extRoot, FIXTURE);
  try {
    // ---- 夹具扩展：每条规则一个样本文件 ----
    mkdirSync(join(fixtureSrc, "src", "deep", "__pycache__"), { recursive: true });
    mkdirSync(join(fixtureSrc, "vendor"), { recursive: true });
    writeFileSync(join(fixtureSrc, "package.json"), JSON.stringify({
      name: "@aiti-ai/zz-sync-fixture-tmp",
      version: "0.0.1",
      aitiExtProtocol: "1.0",
    }));
    writeFileSync(join(fixtureSrc, "src", "demo.py"), 'CACHE = "/home/pi/.cache/models"\n');
    writeFileSync(join(fixtureSrc, "src", "deep", "__pycache__", "junk.cpython-313.pyc"), "bytecode");
    writeFileSync(join(fixtureSrc, "src", "run.log"), "log line");
    writeFileSync(join(fixtureSrc, "README.md"), "install from https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz\n");
    writeFileSync(join(fixtureSrc, "src", "conf.ts"), 'const PEER = "http://192.168.122.7:8080";\n');

    // ---- 运行镜像（临时 DST；--only 夹具）----
    const run = spawnSync(process.execPath, [script, "--only", FIXTURE], {
      cwd: workRoot,
      env: { ...process.env, AITI_AI_REPO: dst },
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `镜像脚本失败: ${run.stderr?.slice(0, 400)}`);

    // ---- 断言：脱敏生效 ----
    const mirroredPy = join(dst, "extensions", FIXTURE, "src", "demo.py");
    assert.ok(existsSync(mirroredPy), ".py 应作为文本镜像");
    const py = readFileSync(mirroredPy, "utf8");
    assert.ok(!py.includes("/home/pi"), ".py 内不应残留 /home/pi");
    assert.ok(py.includes("/home/pi"), ".py 应脱敏为 /home/pi");

    // ---- 断言：排除契约 ----
    assert.equal(existsSync(join(dst, "extensions", FIXTURE, "src", "deep", "__pycache__")), false, "__pycache__ 不得进镜像");
    assert.equal(existsSync(join(dst, "extensions", FIXTURE, "src", "run.log")), false, ".log 不得进镜像");

    // ---- 断言：核心脱敏规则（md/ts 文本）----
    const md = readFileSync(join(dst, "extensions", FIXTURE, "README.md"), "utf8");
    assert.ok(!md.includes("npm.example.com"), "私源 URL 应改写");
    assert.ok(md.includes("https://registry.npmjs.org/pkg/"), "私源应替换为 registry.npmjs.org");
    const ts = readFileSync(join(dst, "extensions", FIXTURE, "src", "conf.ts"), "utf8");
    assert.ok(!ts.includes("192.168.122.7"), "内网 IP 应改写");
    assert.ok(ts.includes("192.168.122.7"), "内网段应替换为 192.168.122.N");
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(fixtureSrc, { recursive: true, force: true });
  }
});
