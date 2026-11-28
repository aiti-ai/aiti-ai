/**
 * OAuth transport helpers for endpoints that may live on another host than the API
 * base (e.g. Yunxiao authorizes on account-devops.aliyun.com while the API lives on
 * openapi-rdc.aliyuncs.com). Every outbound host must match the provider allowlist.
 */
import { sanitizeErrorText } from "./http.ts";

function assertAllowed(url: string, allowedHosts: string[]): void {
  const host = new URL(url).hostname;
  const ok = allowedHosts.some((suffix) => {
    const s = suffix.replace(/^\./, "");
    return host === s || host.endsWith("." + s);
  });
  if (!ok) throw new Error(`OAuth endpoint host not allowed: ${host}`);
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("json") || /^\s*[[{]/.test(text)) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
  return text;
}

export async function getJson(url: string, opts: { allowedHosts: string[]; timeoutMs?: number; headers?: Record<string, string> }): Promise<unknown> {
  assertAllowed(url, opts.allowedHosts);
  const res = await fetch(url, {
    headers: { accept: "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const data = await parse(res);
  if (!res.ok) throw new Error(`OAuth GET ${res.status}: ${sanitizeErrorText(JSON.stringify(data ?? ""))}`);
  return data;
}

export async function postJson(url: string, body: unknown, opts: { allowedHosts: string[]; timeoutMs?: number; headers?: Record<string, string> }): Promise<unknown> {
  assertAllowed(url, opts.allowedHosts);
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...(opts.headers || {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const data = await parse(res);
  if (!res.ok) throw new Error(`OAuth POST ${res.status}: ${sanitizeErrorText(JSON.stringify(data ?? ""))}`);
  return data;
}

export async function postForm(url: string, fields: Record<string, string | undefined>, opts: { allowedHosts: string[]; timeoutMs?: number; headers?: Record<string, string> }): Promise<unknown> {
  assertAllowed(url, opts.allowedHosts);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") form.set(k, v);
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", ...(opts.headers || {}) },
    body: form.toString(),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const data = await parse(res);
  if (!res.ok) throw new Error(`OAuth token ${res.status}: ${sanitizeErrorText(JSON.stringify(data ?? ""))}`);
  return data;
}
