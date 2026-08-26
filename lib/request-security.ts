import { isIP } from "node:net";

// service-tunnels 扩展（self-expose 配置）写入的 globalThis 状态：
// __piWebExposeConfig = PI_WEB_EXPOSE 解析结果（allowHost 等）、
// __piWebAllowHostsOverride = 运行时 allowHost 覆盖（扩展 API 写入）。
// 本模块（core 门禁）只读，不随扩展加载状态漂移（未设置 = 无例外）。
declare global {
  var __piWebAllowHostsOverride: string[] | undefined;
  var __piWebExposeConfig: Record<string, unknown> | undefined;
}

function normalizeHostname(value: string): string {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return unbracketed.toLowerCase().replace(/\.$/, "");
}

function hostnameFromAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function normalizeAuthority(value: string): string | null {
  if (!value || /[\s/@\\]/.test(value)) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    const hostname = normalizeHostname(parsed.hostname);
    return parsed.port ? `${hostname}:${parsed.port}` : hostname;
  } catch {
    return null;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? normalizeHostname(trimmed) : hostnameFromAuthority(trimmed);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function configuredHostnamesFromEnvironment(): string[] {
  const out = [
    process.env.PI_WEB_HOSTNAME,
    process.env.PI_WEB_BASE_DOMAIN,
    ...(process.env.PI_WEB_ALLOWED_HOSTS?.split(",") ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
  // allowlocal exception hosts (PI_WEB_EXPOSE allowHost / runtime overrides) —
  // operator-protected front domains that pass the host gate even when
  // allowlocal=false.
  if (Array.isArray(globalThis.__piWebAllowHostsOverride)) {
    out.push(...globalThis.__piWebAllowHostsOverride);
  }
  const cfg = globalThis.__piWebExposeConfig;
  const ah = cfg?.allowHost;
  if (Array.isArray(ah)) out.push(...ah.map(String));
  else if (typeof ah === "string") out.push(ah);
  return out;
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getRequestOrigin(request: Request): string | null {
  const requestUrl = new URL(request.url);
  // 中间件 self-forward 重写后 host=127.0.0.1:port、requestUrl 为内部目标;
  // 浏览器实际连的是 vhost(nginx 置 X-Forwarded-Host/Proto)。用转发头还原
  // 真实预期 origin,否则 Origin(https://vhost) 与 http://127.0.0.1 永远不匹配。
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? requestUrl.protocol.replace(":", "");
  return host ? canonicalOrigin(`${proto}://${host}`) : null;
}

function isUserInitiatedSessionExportNavigation(request: Request): boolean {
  if (
    request.method !== "GET"
    || request.headers.get("sec-fetch-mode") !== "navigate"
    || request.headers.get("sec-fetch-dest") !== "document"
    || request.headers.get("sec-fetch-user") !== "?1"
  ) {
    return false;
  }

  try {
    return /^\/api\/sessions\/[^/]+\/export$/.test(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

/** 配置的 base domain(如 example.com):服务 vhost(*.example.com)是其子域,
 *  经中间件 resolve + 认证后才到达 API,视为可信。 */
function baseDomainHostnames(): string[] {
  const out: string[] = [];
  for (const v of [process.env.PI_WEB_BASE_DOMAIN, process.env.PI_WEB_HOSTNAME]) {
    const h = normalizeConfiguredHostname(v);
    if (h && !isIP(h)) out.push(h);
  }
  return out;
}

function isBaseDomainSubdomain(hostname: string): boolean {
  return baseDomainHostnames().some((b) => hostname === b || hostname.endsWith(`.${b}`));
}

/** 操作者信任的主机:回环/IP 字面量、配置的 base domain 及其子域、以及显式配置
 *  的主机(PI_WEB_HOSTNAME / PI_WEB_BASE_DOMAIN / PI_WEB_ALLOWED_HOSTS / 运行时
 *  allowHost)。IP 字面量保留 LAN 访问且无法被 DNS rebinding。 */
function isTrustedHostname(hostname: string, configuredHostnames: string[]): boolean {
  if (isLoopbackHostname(hostname) || isIP(hostname)) return true;
  // 服务 vhost(*.example.com)为 operator 域名子域——中间件已 resolve+认证
  if (isBaseDomainSubdomain(hostname)) return true;
  return configuredHostnames.some(
    (configured) => normalizeConfiguredHostname(configured) === hostname,
  );
}

/**
 * Only trust local names, IP literals, or the hostname explicitly selected by
 * the operator. IP literals preserve LAN access but cannot be DNS-rebound
 * because the browser keeps the literal address in the Host header.
 */
export function isApiRequestHostAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  const host = request.headers.get("host");
  const hostname = host ? hostnameFromAuthority(host) : null;
  if (!hostname) return false;
  return isTrustedHostname(hostname, configuredHostnames);
}

/**
 * A relay can report the external scheme in `x-forwarded-proto` while rewriting
 * `Origin` onto the backend authority, so the two disagree on the scheme alone
 * for a request that really is same-origin (Azure Dev Tunnels does this). Accept
 * that pairing only when the Origin's authority still equals the Host header,
 * a proxy is in front, and Fetch Metadata still reports a same-origin request.
 */
function isProxyRewrittenSameOrigin(request: Request, origin: string): boolean {
  if (
    request.headers.get("sec-fetch-site") !== "same-origin"
    || !request.headers.get("x-forwarded-proto")
  ) return false;

  const host = request.headers.get("host");
  if (!host) return false;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  const originAuthority = normalizeAuthority(originHost);
  return originAuthority !== null && originAuthority === normalizeAuthority(host);
}

/** Reject browser cross-site API requests while preserving non-browser clients. */
export function isApiRequestOriginAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  // 显式配置的额外允许 origin（API_ALLOW_ORIGINS，逗号分隔；支持 `*` 或 `scheme://host` 精确/前缀匹配）。
  // 用途：aiti-devtools 注入页（service-tunnels vhost）跨域直连桥——部署时配置注入页域；
  // 本地开发配 localhost。显式配置，非硬编码白名单；配置匹配即放行（含 cross-site）。
  const allowOrigins = (process.env.API_ALLOW_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin) {
    for (const a of allowOrigins) {
      if (a === "*") return true;
      if (origin.startsWith(a.replace(/\/+$/, ""))) return true;
    }
  }

  if (fetchSite === "cross-site") return false;
  if (!origin) return true;

  const requestOrigin = getRequestOrigin(request);
  // 预期 origin 若来自 x-forwarded-host(而非实际 host),转发头必须本身可信
  // (回环/IP/operator 域名子域或显式配置主机),否则恶意页可用伪造 XFH 匹配
  // 自己的 Origin 绕过 CSRF 门禁。此门前置于一切放行路径。
  if (request.headers.get("x-forwarded-host")) {
    const fh = request.headers.get("x-forwarded-host");
    const hostname = fh ? hostnameFromAuthority(fh) : null;
    if (hostname && !isTrustedHostname(hostname, configuredHostnames)) {
      return false;
    }
  }
  if (requestOrigin !== null && canonicalOrigin(origin) === requestOrigin) return true;

  // 上游：代理改写 Origin 的同源配对（Azure Dev Tunnels 等）——依赖浏览器才有的
  // Fetch Metadata（sec-fetch-site），非浏览器客户端已在前面被 cross-site 门拦截。
  return isProxyRewrittenSameOrigin(request, origin);
}

export function shouldCheckApiRequestOrigin(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

export function isApiRequestAllowed(
  request: Request,
  configuredHostnames = configuredHostnamesFromEnvironment(),
): boolean {
  if (!isApiRequestHostAllowed(request, configuredHostnames)) return false;
  if (isUserInitiatedSessionExportNavigation(request)) return true;
  return !shouldCheckApiRequestOrigin(request) || isApiRequestOriginAllowed(request, configuredHostnames);
}

export function hasJsonContentType(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json"
    || Boolean(mediaType?.startsWith("application/") && mediaType.endsWith("+json"));
}
