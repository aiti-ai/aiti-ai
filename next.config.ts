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

/** Deployment domains → dev cross-origin allow list (host:port stripped; domains plus subdomain wildcards). */
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
    hosts.add(`*.${host}`); // service vhost subdomains (<port>-pi-web.<domain> etc.)
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  // Docker image slimming switch: setting NEXT_OUTPUT_STANDALONE=1 at build time produces a .next/standalone
  // minimal dependency tree (replacing the whole node_modules; -1.4GB on the core image). Host/dev don't set
  // this env, behavior unchanged.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" as const } : {}),
  // Disable Next's built-in gzip (the default compress:true compresses responses forwarded by middleware
  // rewrites, SSE included — gzip buffers chunks and the first frame only flushes on the next write; in
  // tunnel scenarios 15s+ and the page can't reach the bridge). Edge compression is nginx's job (see the
  // "response re-compression" section of conf.d/pi-web.conf); compression at the Next layer is pure redundancy.
  compress: false,
  // Disable the Next debug floating indicator (compile status/route info) in the dev-mode bottom-right corner.
  devIndicators: false,
  // Optional sub-path deployment, e.g. PI_WEB_BASE_PATH=/dev serves the app
  // at https://host/dev/. Client code reads NEXT_PUBLIC_BASE_PATH via
  // lib/base-path.ts. Empty (default) = root deployment.
  basePath: basePath || undefined,
  // Disable Next's built-in trailing-slash redirect (by default /dev → 308 → /dev/): it also applies to the
  // basePath root of tunnel vhosts and runs before middleware, which would turn our /dev → /dev/ canonical
  // redirect into a loop, and would append trailing slashes to /dev/api/* when trailingSlash:true.
  // Trailing-slash normalization is handled uniformly by proxy.ts (middleware).
  skipTrailingSlashRedirect: true,
  // middleware (proxy.ts) uses the client's original URL (initURL) for request.url directly, skipping Next's
  // manual assembly (initProtocol://fetchHostname:port + urlQueryToSearchParams normalization).
  // The assembly branch can produce malformed URLs on vhost requests (Invalid URL 500), and it normalizes
  // valueless query params (?vue&lang.scss) into ?vue=&lang.scss= — vite returns plain CSS for empty-valued
  // params carrying =. The middleware must keep the client's original URL.
  skipProxyUrlNormalize: true,
  // Dev server runs against its own build directory (.next-dev) so it can
  // coexist with the production `next start` (.next) on a different port.
  distDir: process.env.PI_WEB_DIST_DIR || (process.env.PI_WEB_DEV_DIST ? ".next-dev" : ".next"),
  outputFileTracingRoot: configDir,
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
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
    // The eager extension client-bundle batch packaging (lib/ext/client-bundle.ts) needs the esbuild
    // native binary at runtime (must not be rewritten by Server Components bundling).
    "esbuild",
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
  // Friendly root-path hop in basePath mode: visiting / 307s to /dev/ (otherwise a bare 404).
  // A redirects source gets the basePath prefix prepended automatically; basePath:false must be explicit
  // to match the real / (the destination likewise takes no prefix — write the full target). Root deployments
  // (empty basePath) return an empty array, behavior unchanged. Query strings pass through automatically via Next.
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
  // Low-memory host local-build fallback (PI_WEB_BUILD_LOW_MEM=1): the webpack compile worker is a single
  // process but its memory cache can reach several GB — even an 8192 heap OOMs on a 15.7G machine (e.g. the
  // Windows 155 box). With the memory cache off + parallelism limited + the separate compile worker removed
  // (compiling in the main process), a single process with a 6-8G heap gets through (slower builds expected).
  // Don't set this on normal machines; the cache is a clear speedup. Background: §8 of the host repo's
  // Windows deployment doc.
  ...(process.env.PI_WEB_BUILD_LOW_MEM === "1"
    ? {
        experimental: {
          // Next 16 puts webpack compilation in a separate worker process by default; multiple processes +
          // virtual memory boundaries repeatedly exit 134 (AddressSpaceReservation failure) on low-memory
          // Windows hosts — remove the worker and compile single-threaded in the main process.
          webpackBuildWorker: false,
        },
        webpack: (config: Record<string, unknown>) => {
          config.parallelism = 1;
          config.cache = false;
          return config;
        },
      }
    : {}),
};

export default nextConfig;
