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
    "node-pty",
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    // Extensions are transpiled at runtime with jiti — must not be bundled.
    "jiti",
  ],
  // Next dev cross-origin guard (allowedDevOrigins): 16.3+ rejects dev
  // resources (_next/static chunks) whose Origin is not allow-listed. Beyond
  // loopback/LAN (RFC1918 ranges keep the dev server reachable from other
  // machines on the same LAN) we also trust the operator's deployment
  // hostnames from env (PI_WEB_ALLOWED_HOSTS / PI_WEB_BASE_DOMAIN /
  // PI_WEB_HOSTNAME, host:port stripped) plus their subdomains (service
  // vhosts, e.g. <port>-pi-web.<domain>) — no hardcoded hostnames in the
  // repo. Production `next start` ignores this setting.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
    ...deploymentDevOrigins(),
  ],
  // basePath 模式下根路径友好跳转：访问 / 时 307 到 /dev/（否则是裸 404）。
  // redirects 的 source 默认会被自动加上 basePath 前缀，必须显式 basePath:false
  // 才能匹配真正的 /（destination 同样不加前缀，直接写完整目标）。根部署
  // （basePath 为空）返回空数组，行为不变。查询串由 Next 自动透传。
  async redirects() {
    if (!basePath) return [];
    return [
      {
        source: "/",
        destination: `${basePath}/`,
        permanent: false,
        basePath: false,
      },
    ];
  },
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
  // 低内存主机本地 build 兜底（PI_WEB_BUILD_LOW_MEM=1）：webpack 编译 worker 是单进程但
  // 内存 cache 可达数 GB——15.7G 机器（如 Windows 155）8192 堆也会 OOM。关内存 cache +
  // 限制并行度后 6-8G 堆可过（build 变慢属预期）。正常机器不要设，cache 加速明显。
  // 背景见 aiti-ai/docs/pi-web-win-deployment.md §8。
  ...(process.env.PI_WEB_BUILD_LOW_MEM === "1"
    ? {
        webpack: (config: Record<string, unknown>) => {
          config.parallelism = 1;
          config.cache = false;
          return config;
        },
      }
    : {}),
};

export default nextConfig;
