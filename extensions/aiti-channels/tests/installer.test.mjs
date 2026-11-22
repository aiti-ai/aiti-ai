/**
 * aiti-channels · installer Windows 适配单测（2026-09-18 方案 §2/§3）
 *
 * 覆盖：托管 bin 命名（win 带 .exe）、yauzl zip 解包（含路径穿越防御）、
 * findBinRecursive、resolveJustgetCli env 优先、parseCimTable（PowerShell 全表 TSV）。
 * 零网络零真进程——下载/托管全链路走 155 真机验收（方案 §7.4）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-channels/tests/installer.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const installer = await import("../lib/installer.ts");
const manager = await import("../lib/manager.ts");

const IS_WIN = process.platform === "win32";

/** 构造 STORE（不压缩）zip——Windows 裸机没有 zip/unzip 命令，测试自给自足。 */
function makeStoreZip(files) {
  assert.ok(typeof zlib.crc32 === "function", "需要 node ≥22.2（zlib.crc32）");
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = Number(zlib.crc32(f.data) >>> 0);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 8); // method=store
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(f.data.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    chunks.push(lfh, name, f.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += lfh.length + name.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-channels-test-"));
  return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("托管 bin 命名：win32 带 .exe；managedBin 在托管目录下", () => {
  assert.equal(installer.managedBinName(), IS_WIN ? "cc-connect.exe" : "cc-connect");
  assert.ok(installer.managedBin().startsWith(installer.managedBinDir()));
  assert.ok(installer.managedBin().endsWith(installer.managedBinName()));
});

test("extractZipToDir：解出 cc-connect.exe 内容一致；目录条目跳过", () =>
  withTmp(async (dir) => {
    const bin = Buffer.concat([Buffer.from("MZ-fake-exe-header"), Buffer.alloc(4096, 0x41)]);
    const zipPath = path.join(dir, "pkg.zip");
    fs.writeFileSync(zipPath, makeStoreZip([
      { name: "cc-connect-v1.5.0-windows-amd64/", data: Buffer.alloc(0) },
      { name: "cc-connect-v1.5.0-windows-amd64/cc-connect.exe", data: bin },
      { name: "cc-connect-v1.5.0-windows-amd64/README.txt", data: Buffer.from("hi") },
    ]));
    const dest = path.join(dir, "out");
    fs.mkdirSync(dest);
    await installer.extractZipToDir(zipPath, dest);
    const found = installer.findBinRecursive(dest);
    assert.equal(path.basename(found || ""), "cc-connect.exe");
    assert.deepEqual(fs.readFileSync(found), bin);
  }));

test("extractZipToDir：路径穿越条目拒绝（..），不写出 dest 外文件", () =>
  withTmp(async (dir) => {
    const zipPath = path.join(dir, "evil.zip");
    fs.writeFileSync(zipPath, makeStoreZip([{ name: "../escaped.txt", data: Buffer.from("x") }]));
    const dest = path.join(dir, "out2");
    fs.mkdirSync(dest);
    // yauzl 自带 invalid relative path 拦截 + 我们的 .. 防御双保险，任一即算拦住
    await assert.rejects(() => installer.extractZipToDir(zipPath, dest), /非法路径|invalid relative path/);
    assert.ok(!fs.existsSync(path.join(dir, "escaped.txt")));
  }));

test("findBinRecursive：优先精确名，忽略校验/压缩包尾巴文件", () =>
  withTmp(async (dir) => {
    fs.writeFileSync(path.join(dir, "cc-connect-checksums.txt"), "x");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "cc-connect"), "#!/bin/sh\n");
    const found = installer.findBinRecursive(dir);
    assert.ok(found);
    assert.equal(path.basename(found), "cc-connect");
  }));

test("resolveJustgetCli：JUSTGET_CLI 指向存在文件时优先返回", () =>
  withTmp(async (dir) => {
    const cli = path.join(dir, "cli.js");
    fs.writeFileSync(cli, "// fake");
    const prev = process.env.JUSTGET_CLI;
    process.env.JUSTGET_CLI = cli;
    try {
      assert.equal(installer.resolveJustgetCli(), cli);
    } finally {
      if (prev === undefined) delete process.env.JUSTGET_CLI;
      else process.env.JUSTGET_CLI = prev;
    }
    assert.equal(typeof installer.resolveJustgetCli(), "string");
  }));

test("parseCimTable：TSV 行解析（空 cmdline / CRLF / 非数字 pid 垃圾行 / 名字大小写）", () => {
  const out = [
    "4\tSystem\t",
    "1234\tcc-connect.exe\t\"C:\\Users\\me\\.pi\\web\\data\\aiti-channels\\cache\\bin\\cc-connect.exe\" -config D:\\cfg\\a.toml",
    "5678\tpowershell.exe\t",
    "bogus-line",
    "9\tCC-CONNECT\t",
  ].join("\r\n");
  const rows = manager.parseCimTable(out);
  assert.equal(rows.length, 4); // bogus-line 无 \t 被丢
  assert.deepEqual(rows[1], {
    pid: 1234,
    name: "cc-connect.exe",
    cmdline: "\"C:\\Users\\me\\.pi\\web\\data\\aiti-channels\\cache\\bin\\cc-connect.exe\" -config D:\\cfg\\a.toml",
  });
  assert.match(rows[1].name, /^cc-connect(\.exe)?$/i);
  assert.match(rows[3].name, /^cc-connect(\.exe)?$/i); // 大小写不敏感命中
  assert.equal(rows[0].cmdline, ""); // 其他用户/系统进程 cmdline 受限形态
});

test("DEFAULTS.bin 走 managedBin 单一出口（win32 必带 .exe；POSIX 无托管件时回退系统 bin）", () => {
  if (process.env.CC_CONNECT_BIN) return; // 本机 env 覆盖态不强断
  if (IS_WIN) {
    assert.equal(manager.DEFAULTS.bin, installer.managedBin());
  } else {
    assert.ok(
      manager.DEFAULTS.bin === installer.managedBin() || manager.DEFAULTS.bin === "/usr/local/bin/cc-connect",
      `unexpected DEFAULTS.bin: ${manager.DEFAULTS.bin}`,
    );
  }
});
