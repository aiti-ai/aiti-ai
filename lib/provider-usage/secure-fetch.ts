import type { UsageAuth } from "./types";

// Hardened fetch for official provider usage endpoints: explicit UA (Cloudflare
// 1010), origin pinned by the adapter, redirect refused, 15s timeout, 64KB cap,
// key material never leaks into error messages.

const USER_AGENT = "pi-web-provider-usage/1.0";
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 65_536;

export class UsageHttpError extends Error {}

export function assertOfficialOrigin(origins: string[], url: string): void {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(url).origin;
  } catch {
    throw new UsageHttpError("Invalid usage endpoint URL.");
  }
  if (!origins.includes(requestOrigin)) {
    throw new UsageHttpError("A custom provider origin cannot be used for official usage queries.");
  }
}

export function buildAuthHeaders(auth: UsageAuth, extra?: Record<string, string>): Headers {
  const headers = new Headers({ "User-Agent": USER_AGENT, Accept: "application/json" });
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") headers.set(name, value);
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (!headers.has(name.toLowerCase())) headers.set(name, value);
  }
  if (!headers.has("authorization") && auth.apiKey) headers.set("Authorization", `Bearer ${auth.apiKey}`);
  return headers;
}

export async function fetchOfficialJson(
  origins: string[],
  url: string,
  headers: Headers,
): Promise<Record<string, unknown>> {
  assertOfficialOrigin(origins, url);
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) throw new UsageHttpError("Usage response was too large.");
  if (!response.ok) throw new UsageHttpError(`Usage endpoint returned ${response.status}.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new UsageHttpError("Usage response was not JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageHttpError("Usage response was not an object.");
  }
  return parsed as Record<string, unknown>;
}

export function bearerToken(value: string | null): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
