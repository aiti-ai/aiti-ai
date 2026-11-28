/**
 * Shared HTTP helper for provider adapters.
 *
 * - one place for timeouts, JSON parsing, error mapping and rate-limit reporting;
 * - outbound URLs are restricted to the configured base origin (pagination links from
 *   the provider are accepted only when they point at the same origin);
 * - error text is sanitized before it reaches logs / the client (no tokens).
 */
import type { Http, HttpRequestOptions, HttpResponse } from "./contract.ts";

export class ForgeHttpError extends Error {
  status?: number;
  code: "auth" | "forbidden" | "rate_limited" | "not_found" | "bad_request" | "network" | "server" | "unknown";
  retryAt?: number;
  body?: unknown;

  constructor(message: string, opts: { status?: number; code?: ForgeHttpError["code"]; retryAt?: number; body?: unknown }) {
    super(message);
    this.name = "ForgeHttpError";
    this.status = opts.status;
    this.code = opts.code || "unknown";
    this.retryAt = opts.retryAt;
    this.body = opts.body;
  }
}

/** Shape-based redaction for provider error text (tokens never reach the browser). */
export function sanitizeErrorText(input: string): string {
  let s = String(input || "");
  const rules: Array<[RegExp, string]> = [
    [/\b(?:oat|ort)-[A-Za-z0-9._~+/=-]{8,}/g, "oat-***"],
    [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "gh*_***"],
    [/\bglpat-[A-Za-z0-9._-]{10,}/g, "glpat-***"],
    [/\bx-yunxiao-token\s*[:=]\s*\S+/gi, "x-yunxiao-token: ***"],
    [/\bAuthorization\s*[:=]\s*[^\s,;]+/gi, "Authorization: ***"],
    [/\bPRIVATE-TOKEN\s*[:=]\s*[^\s,;]+/gi, "PRIVATE-TOKEN: ***"],
    [/\baccess_token=[^&\s]+/g, "access_token=***"],
  ];
  for (const [re, rep] of rules) s = s.replace(re, rep);
  return s.slice(0, 600);
}

function statusCode(status: number): ForgeHttpError["code"] {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

function retryAtFrom(headers: Headers): number | undefined {
  const reset = headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const n = Number(reset);
    // GitHub sends epoch seconds; GitLab sends relative seconds in RateLimit-Reset.
    return n > 1e12 ? n : n > 1e9 ? n * 1000 : Date.now() + n * 1000;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Date.now() + Number(retryAfter) * 1000;
  return undefined;
}

function errorMessageOf(data: unknown, status: number): string {
  if (typeof data === "string" && data.trim()) return sanitizeErrorText(data);
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["errorMessage", "message", "error_description", "error", "msg"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return sanitizeErrorText(v);
      if (v && typeof v === "object") {
        const nested = (v as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim()) return sanitizeErrorText(nested);
      }
    }
    try {
      return sanitizeErrorText(JSON.stringify(data));
    } catch {
      /* fall through */
    }
  }
  return `HTTP ${status}`;
}

export interface CreateHttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Extra origins accepted for absolute URLs (rarely needed; pagination must stay same-origin). */
  allowOrigins?: string[];
}

export function createHttp(baseUrl: string, opts: CreateHttpOptions = {}): Http {
  const base = baseUrl.replace(/\/+$/, "");
  const baseOrigin = new URL(base).origin;
  const allowed = new Set([baseOrigin, ...(opts.allowOrigins || [])]);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const buildUrl = (path: string, query?: HttpRequestOptions["query"]): URL => {
    let url: URL;
    if (/^https?:\/\//i.test(path)) {
      url = new URL(path);
      if (!allowed.has(url.origin)) throw new ForgeHttpError("outbound URL outside the provider origin", { code: "bad_request" });
    } else {
      url = new URL(base + (path.startsWith("/") ? path : `/${path}`));
    }
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    return url;
  };

  const req = async <T = unknown>(path: string, ro: HttpRequestOptions = {}): Promise<HttpResponse<T>> => {
    const url = buildUrl(path, ro.query);
    const method = ro.method || "GET";
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(opts.headers || {}),
      ...(ro.headers || {}),
    };
    let body: string | undefined;
    if (ro.body !== undefined) {
      if (typeof ro.body === "string") {
        body = ro.body;
      } else {
        headers["content-type"] = headers["content-type"] || "application/json";
        body = JSON.stringify(ro.body);
      }
    }
    const timeout = ro.timeoutMs ?? timeoutMs;
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
        redirect: "follow",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ForgeHttpError(`network error: ${sanitizeErrorText(msg)}`, { code: "network" });
    }

    const text = await res.text().catch(() => "");
    let data: unknown = text;
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("json") || /^\s*[[{]/.test(text)) {
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const code = statusCode(res.status);
      const retryAt = retryAtFrom(res.headers);
      // Gitee returns 403 with a message for missing tokens; map it to auth when it looks like one.
      const msg = errorMessageOf(data, res.status);
      throw new ForgeHttpError(msg, { status: res.status, code, retryAt, body: data });
    }

    return { data: data as T, status: res.status, headers: res.headers };
  };

  return {
    baseUrl: base,
    req,
    async json<T = unknown>(path: string, ro?: HttpRequestOptions): Promise<T> {
      const r = await req<T>(path, ro);
      return r.data;
    },
  };
}

/** Parse an RFC 5988 Link header (GitHub / Gitee / GitLab pagination). */
export function parseLinkNext(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m && m[2].split(" ").includes("next")) return m[1];
  }
  return null;
}

/** Last page number from a GitHub Link header (rel="last"), for exact totals without paging. */
export function parseLinkLastPage(link: string | null): number | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());
    if (m && m[2].split(" ").includes("last")) {
      const page = /(?:^|[?&])page=(\d+)/.exec(m[1]);
      return page ? Number(page[1]) : undefined;
    }
  }
  return undefined;
}

/** Numeric header helper (x-total / x-total-pages). */
export function intHeader(headers: Headers, ...names: string[]): number | undefined {
  for (const n of names) {
    const v = headers.get(n);
    if (v && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return undefined;
}
