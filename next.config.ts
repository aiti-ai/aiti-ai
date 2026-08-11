import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

// Optional sub-path deployment, e.g. PI_WEB_BASE_PATH=/dev serves the app at
// https://host/dev/. Empty string = root deployment.
//
// Safety: a production build must never accidentally inherit the dev server's
// basePath (builds spawned from the dev process env do). If PI_WEB_BASE_PATH
// is set during a production build, it is ignored unless the operator
// explicitly opts in with PI_WEB_BUILD_BASEPATH=1.
const envBasePath = (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "");
const isProdBuild = process.env.NODE_ENV === "production" && !process.env.PI_WEB_DEV_DIST;
const allowProdBasePath = process.env.PI_WEB_BUILD_BASEPATH === "1";
const basePath =
  isProdBuild && envBasePath && !allowProdBasePath
    ? (console.warn(
        `[pi-web] Ignoring PI_WEB_BASE_PATH="${envBasePath}" for the production build (set PI_WEB_BUILD_BASEPATH=1 to allow it).`,
      ),
      "")
    : envBasePath;

const nextConfig: NextConfig = {
  // Optional sub-path deployment, e.g. PI_WEB_BASE_PATH=/dev serves the app
  // at https://host/dev/. Client code reads NEXT_PUBLIC_BASE_PATH via
  // lib/base-path.ts. Empty (default) = root deployment.
  basePath: basePath || undefined,
  // 关闭 Next 内置的尾斜杠重定向（默认 /dev/ → 308 → /dev）：它对隧道 vhost 的
  // basePath 根路径也生效，且发生在 middleware 之前，会把我们的 /dev → /dev/ 规范
  // 重定向变成死循环，也会让 /dev/api/* 在 trailingSlash:true 时被加尾斜杠。
  // 尾斜杠规范化由 proxy.ts（middleware）统一处理。
  skipTrailingSlashRedirect: true,
  // Dev server runs against its own build directory (.next-dev) so it can
  // coexist with the production `next start` (.next) on a different port.
  distDir: process.env.PI_WEB_DIST_DIR || (process.env.PI_WEB_DEV_DIST ? ".next-dev" : ".next"),
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    // Extensions are transpiled at runtime with jiti — must not be bundled.
    "jiti",
    // service-tunnels loads runtime plugin files (configDir/providers/*.js)
    // and probes http/https via computed import() — must not be bundled.
    // Safe to externalize: server-only runtime; client code uses type imports
    // only; the middleware (proxy.ts) never imports it (shared globalThis).
    "service-tunnels",
  ],
  allowedDevOrigins: ['192.168.*.*', '127.0.0.1', 'localhost'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  // dist is compiled JS now; transpiling the file: tgz made turbopack resolve
  // the package's .ts source instead (which it cannot compile under
  // node_modules) → Can't resolve. Keep it off.

  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
