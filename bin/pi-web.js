#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getUnsupportedNodeVersionMessage, isNodeVersionSupported } = require("./node-version");

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node));
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getHelpText, parseCommandLine } = require("./pi-web-options");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getNextNodeArgs } = require("./pi-web-node-args");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { wireChildProcessLifecycle } = require("./process-lifecycle");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotatePreviewSecrets, getRotationWarning } = require("./rotate-preview-secrets");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openWhenServing } = require("./browser-opener");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createRunRecordTracker, getOpenUrl, getRunDir } = require("./run-records");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getPackageVersion, runCommand } = require("./pi-web-commands");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { formatReachableAddresses } = require("./network-addresses");

let launchOptions;
try {
  launchOptions = parseCommandLine();
} catch (error) {
  fs.writeSync(
    process.stderr.fd,
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

if (launchOptions.help) {
  fs.writeSync(process.stdout.fd, getHelpText());
  process.exit(0);
}

if (launchOptions.command === "start") {
  startServer(launchOptions).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
} else {
  runCommand(launchOptions).then(
    exitWhenIdle,
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      exitWhenIdle(1);
    },
  );
}

// Leave once the event loop drains instead of calling process.exit() right
// after a fetch(): on Windows, Node.js 23 up to 24.19 / 26.6 can then abort
// with a libuv assertion (UV_HANDLE_CLOSING, win/async.c) while background
// work from the fetch is still winding down (#1174, nodejs/node#56645). The
// unref'd timer only fires if something still holds the loop open.
function exitWhenIdle(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

async function startServer({ port, hostname, openBrowser }) {

  const pkgDir = path.join(__dirname, "..");
  const nextDir = path.join(pkgDir, ".next");

  // v3 bundled 扩展依赖 reconcile：主包随包分发 extensions/，但其各自声明的运行时
  // 依赖 npm 不随主包安装——首启动（及依赖集变化后）一次性装进共享根
  // <webRoot>/node_modules（jiti walk-up 解析），与 docker 部署的 webRoot reconcile
  // 同语义。指纹匹配时零开销直通；失败不阻塞启动（扩展各自降级，下次启动重试）。
  // AITI_SKIP_BUNDLED_RECONCILE=1 可跳过（CI/离线场景）。
  if (process.env.AITI_SKIP_BUNDLED_RECONCILE !== "1") {
    try {
      const t0 = Date.now();
      const { reconcileBundledExtensions } = require("./bundled-extensions-reconcile");
      const res = reconcileBundledExtensions(pkgDir);
      if (res && res.installed) {
        console.log(`[pi-web] bundled 扩展依赖已 reconcile（${res.count} 个扩展，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      }
    } catch (error) {
      console.warn(`[pi-web] bundled 扩展依赖 reconcile 失败（不影响启动；缺失依赖的扩展将降级）: ${error.message}`);
    }
  }

  // Bundled pi plugins provision (v4): register the first-party
  // pi plugins in the user's pi settings via the official package manager so the
  // same install is shared by the pi TUI, pi-web RPC sessions and spawned pi CLI
  // sessions. npm runs only on first startup or when the manifest pins change;
  // every other startup is a fingerprint no-op. Failures never block startup.
  if (process.env.AITI_SKIP_PI_PLUGINS !== "1") {
    try {
      const t0 = Date.now();
      const { provisionPiPlugins } = require("./pi-plugins-provision");
      const res = await provisionPiPlugins({ pkgDir });
      if (res && res.changed) {
        console.log(`[pi-web] pi plugins provisioned (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      }
    } catch (error) {
      console.warn(`[pi-web] pi plugins provision failed (non-blocking; declarations and installs self-heal on the next start): ${error.message}`);
    }
  }

  // Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
  // may not exist when installed via npx).
  let nextBin;
  try {
    nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
  } catch {
    // Fallback: locate next package root and derive the bin path manually.
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
      nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
    } catch {
      nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
    }
  }

  const loopbackHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const passwordEnabled = Boolean(process.env.PI_WEB_PASSWORD);

  if (!fs.existsSync(nextDir)) {
    console.error("Build artifacts not found. Please report this issue.");
    process.exit(1);
  }

  // Replace the published preview-mode secrets with fresh random values so the
  // previewModeId baked into the npm tarball cannot be used to skip the proxy
  // (via the x-prerender-revalidate header). Must happen before `next start`.
  const rotation = rotatePreviewSecrets(nextDir);
  if (!rotation.ok) {
    console.warn(getRotationWarning(rotation.reason));
  }

  if (!loopbackHostnames.has(hostname)) {
    if (passwordEnabled) {
      console.warn(
        `Warning: pi-web is listening on ${hostname} with password authentication over HTTP. Use HTTPS or a trusted VPN to protect the password in transit.`,
      );
    } else {
      console.warn(
        `Warning: pi-web is listening on ${hostname} without authentication. Only use this on a trusted network.`,
      );
    }
  }

  const nextArgs = ["start", "-p", port];
  nextArgs.push("-H", hostname);

  // Always run next's JS entry with node directly — avoids .bin symlink issues
  // and path-with-spaces problems on Windows when shell: true is used.
  // PI_WEB_HOSTNAME is the LISTEN address only (next start -H); deployment
  // domains are configured separately via PI_WEB_BASE_DOMAIN so overriding it
  // here is safe (IP literals are never treated as virtual-host suffixes).
  const child = spawn(process.execPath, getNextNodeArgs(nextBin, nextArgs), {
    cwd: pkgDir,
    stdio: ["inherit", "pipe", "inherit"],
    // PI_WEB_PKG_DIR: root for the bundled extensions (<pkgDir>/extensions) when
    // resolving dependencies — the next process cwd can be changed by systemd or
    // other launch methods, so injecting it explicitly is safer than relying on
    // cwd semantics.
    env: { ...process.env, PI_WEB_HOSTNAME: hostname, PI_WEB_PKG_DIR: pkgDir },
  });
  wireChildProcessLifecycle(child);

  // Port 0 lets the OS pick a port we never learn, so such a server gets no record.
  const runRecord = createRunRecordTracker({
    dir: getRunDir,
    record: {
      pid: process.pid,
      nextPid: child.pid,
      port: Number(port),
      hostname,
      url: getOpenUrl(hostname, port),
      version: getPackageVersion(pkgDir),
      startedAt: new Date().toISOString(),
    },
  });

  let serverReady = false;
  const url = `http://${hostname}:${port}`;
  // Next.js repeats the `-H` value in its own "Network:" line, which a wildcard
  // bind makes unusable; name the interfaces and their addresses instead.
  const reachable = formatReachableAddresses(hostname, port);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (!serverReady && text.includes("Ready")) {
      serverReady = true;
      if (reachable) process.stdout.write(`${reachable}\n`);
      // The record needs no wait: status, stop and open list a record only
      // once its URL answers. The browser waits for the first page.
      if (port !== "0") runRecord.markReady();
      if (openBrowser) openWhenServing({ hostname, port, url });
    }
  });
}
