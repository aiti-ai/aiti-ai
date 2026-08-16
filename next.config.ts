import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(configDir, "node_modules/@earendil-works/pi-coding-agent/package.json");
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

/** 部署域名 → dev 跨域允许列表（host:port 剥离；域名加子域通配）。 */
function deploymentDevOrigins(): string[] {
  const raw = [
    process.env.PI_WEB_ALLOWED_HOSTS,
    process.env.PI_WEB_BASE_DOMAIN,
    process.env.PI_WEB_HOSTNAME,
  ]
    .filter((v): v is string => Boolean(v?.trim()))
    .flatMap((v) => v.split(","));
  const hosts = new Set<string>();
  for (const h of raw) {
    const host = h.trim().split(":")[0];
    if (!host || host === "127.0.0.1" || host === "localhost") continue;
    hosts.add(host);
    hosts.add(`*.${host}`); // service vhost 子域（<port>-pi-web.<domain> 等）
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  // 关闭 Next 内置 gzip（默认 compress:true 会压缩 middleware rewrite 转发的响应，
  // 含 SSE——gzip 缓冲攒块，首帧延迟到下个写入才 flush，隧道场景 15s+，页面连不上桥）。
  // 边缘压缩由 nginx 负责（见 conf.d/pi-web.conf 的「响应重压」段），Next 层压缩纯冗余。
  compress: false,
  // Optional sub-path deployment, e.g. PI_WEB_BASE_PATH=/dev serves the app
  // at https://host/dev/. Client code reads NEXT_PUBLIC_BASE_PATH via
  // lib/base-path.ts. Empty (default) = root deployment.
  basePath: basePath || undefined,
  // 关闭 Next 内置的尾斜杠重定向（默认 /dev/ → 308 → /dev）：它对隧道 vhost 的
  // basePath 根路径也生效，且发生在 middleware 之前，会把我们的 /dev → /dev/ 规范
  // 重定向变成死循环，也会让 /dev/api/* 在 trailingSlash:true 时被加尾斜杠。
  // 尾斜杠规范化由 proxy.ts（middleware）统一处理。
  skipTrailingSlashRedirect: true,
  // middleware (proxy.ts) 的 request.url 直接用客户端原始 URL（initURL），跳过 Next 的
  // 手工组装（initProtocol://fetchHostname:port + urlQueryToSearchParams 规范化）。
  // 组装分支在 vhost 请求下可能拼出畸形 URL（Invalid URL 500），且会把无值 query
  // 参数（?vue&lang.scss）规范化成 ?vue=&lang.scss=——vite 对带 = 的空值参数返回
  // 纯 CSS。中间层必须保持客户端原始 URL。
  skipProxyUrlNormalize: true,
  // Dev server runs against its own build directory (.next-dev) so it can
  // coexist with the production `next start` (.next) on a different port.
  distDir: process.env.PI_WEB_DIST_DIR || (process.env.PI_WEB_DEV_DIST ? ".next-dev" : ".next"),
  outputFileTracingRoot: configDir,
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    // Extensions are transpiled at runtime with jiti — must not be bundled.
    "jiti",
  ],
  // Next dev cross-origin guard (allowedDevOrigins): 16.3+ rejects dev
  // resources (_next/static chunks) whose Origin is not allow-listed. Beyond
  // loopback/LAN we also trust the operator's deployment hostnames from env
  // (PI_WEB_ALLOWED_HOSTS / PI_WEB_BASE_DOMAIN, host:port stripped) plus their
  // subdomains (service vhosts, e.g. <port>-pi-web.<domain>) — no hardcoded
  // hostnames in the repo. Production `next start` ignores this setting.
  allowedDevOrigins: [
    "127.0.0.1",
    "192.168.*.*",
    "localhost",
    ...deploymentDevOrigins(),
  ],
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
