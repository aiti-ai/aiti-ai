import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VERSION,
  assetName,
  ensureBinary,
  parseChecksum,
  platformKey,
  releaseUrls,
} from "../index.mjs";

/**
 * Offline tests for the npm launcher. A tiny Range-capable HTTP server stands in
 * for GitHub/Gitee release assets, so the justget download/caching/checksum path
 * is exercised without network access.
 */

const asset = assetName();
const binary = Buffer.from(`fake-aiti-widget-binary-${process.pid}`);
const checksum = createHash("sha256").update(binary).digest("hex");

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function startReleaseServer({ body = binary, checksums = `${checksum}  ${asset}\n` } = {}) {
  const stats = { requests: 0, asset: 0, checksums: 0 };
  const server = createServer((req, res) => {
    stats.requests += 1;
    const path = String(req.url || "").split("?")[0];
    const isChecksums = path.endsWith("/checksums.txt");
    const isAsset = path.endsWith(`/${asset}`);
    if (!isChecksums && !isAsset) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (isChecksums) stats.checksums += 1;
    if (isAsset) stats.asset += 1;
    const data = isChecksums ? Buffer.from(checksums) : body;
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(data.length),
      "accept-ranges": "bytes",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (!range) {
      res.writeHead(200, headers);
      res.end(data);
      return;
    }
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    if (start > end || start >= data.length) {
      res.writeHead(416, { "content-range": `bytes */${data.length}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${data.length}`,
      "accept-ranges": "bytes",
    });
    res.end(data.subarray(start, end + 1));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        stats,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function withCache(fn) {
  const dir = mkdtempSync(join(tmpdir(), "aiti-widget-npm-"));
  const prevCache = process.env.AITI_WIDGET_CACHE_DIR;
  const prevBase = process.env.AITI_WIDGET_RELEASE_BASE;
  process.env.AITI_WIDGET_CACHE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevCache === undefined) delete process.env.AITI_WIDGET_CACHE_DIR;
    else process.env.AITI_WIDGET_CACHE_DIR = prevCache;
    if (prevBase === undefined) delete process.env.AITI_WIDGET_RELEASE_BASE;
    else process.env.AITI_WIDGET_RELEASE_BASE = prevBase;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("platform mapping and asset names", () => {
  assert.equal(platformKey("linux", "x64"), "linux-x64");
  assert.equal(assetName("linux", "x64"), "aiti-widget-linux-x64");
  assert.equal(assetName("linux", "arm64"), "aiti-widget-linux-arm64");
  assert.equal(assetName("darwin", "arm64"), "aiti-widget-darwin-arm64");
  assert.equal(assetName("win32", "x64"), "aiti-widget-win32-x64.exe");
  assert.equal(assetName("win32", "arm64"), "aiti-widget-win32-arm64.exe");
  assert.equal(platformKey("sunos", "x64"), null);
  assert.throws(() => assetName("sunos", "x64"), /unsupported platform/);
});

test("release URLs prefer GitHub then Gitee and proxies", () => {
  delete process.env.AITI_WIDGET_RELEASE_BASE;
  const urls = releaseUrls();
  assert.equal(urls.tag, `aiti-widget-v${VERSION}`);
  assert.equal(urls.asset, asset);
  assert.match(urls.binary[0], /^https:\/\/github\.com\/aiti-ai\/aiti-ai\/releases\/download\/aiti-widget-v/);
  assert.match(urls.binary[1], /^https:\/\/gitee\.com\/aiti-ai\/aiti-ai\/releases\/download\//);
  assert.ok(urls.binary.length >= 3);
  assert.equal(urls.mirrors.length, urls.binary.length - 1);
});

test("checksum parser accepts sha256sum formats", () => {
  assert.equal(parseChecksum(`deadbeef  other\n${"a".repeat(64)}  ./${asset}\n`, asset), "a".repeat(64));
  assert.equal(parseChecksum(`${"b".repeat(64)} *${asset}\n`, asset), "b".repeat(64));
  assert.equal(parseChecksum("nope", asset), null);
});

test("downloads via justget, verifies checksum and caches", async () => {
  const server = await startReleaseServer();
  process.env.AITI_WIDGET_RELEASE_BASE = `http://127.0.0.1:${server.port}/aiti-widget-v${VERSION}`;
  try {
    await withCache(async (dir) => {
      const path = await ensureBinary({ log: () => {} });
      assert.ok(path.startsWith(dir));
      assert.deepEqual(readFileSync(path), binary);
      if (process.platform !== "win32") assert.ok((statSync(path).mode & 0o111) !== 0);
      const firstAssetRequests = server.stats.asset;
      const again = await ensureBinary({ log: () => {} });
      assert.equal(again, path);
      assert.equal(server.stats.asset, firstAssetRequests, "second call must reuse the cache");
    });
  } finally {
    await server.close();
  }
});

test("checksum mismatch fails and leaves no cached binary", async () => {
  const server = await startReleaseServer({ checksums: `${sha256Hex("other")}  ${asset}\n` });
  process.env.AITI_WIDGET_RELEASE_BASE = `http://127.0.0.1:${server.port}/aiti-widget-v${VERSION}`;
  try {
    await withCache(async () => {
      await assert.rejects(() => ensureBinary({ log: () => {} }), /checksum|verif|mismatch/i);
      const { binaryPath } = await import("../index.mjs");
      assert.equal(existsSync(binaryPath()), false);
    });
  } finally {
    await server.close();
  }
});

test("AITI_WIDGET_BIN overrides the download", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-widget-bin-"));
  const fake = join(dir, process.platform === "win32" ? "aiti-widget.exe" : "aiti-widget");
  writeFileSync(fake, "x");
  const prev = process.env.AITI_WIDGET_BIN;
  process.env.AITI_WIDGET_BIN = fake;
  try {
    assert.equal(await ensureBinary({ log: () => {} }), fake);
  } finally {
    if (prev === undefined) delete process.env.AITI_WIDGET_BIN;
    else process.env.AITI_WIDGET_BIN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
