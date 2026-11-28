/**
 * config — aiti-ark-usage config file handling (data tier: configDir root).
 *
 * The quota endpoints require Volcengine AK/SK (Access Key ID + Secret Access
 * Key) — the models.json API key cannot query plan quota. The keys live in
 * `<configDir>/config.json`, read fresh on every query (edits take effect
 * without reload; only the provider-id list is pinned at startup).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** pi provider ids (models.json keys) the adapters register under. */
export const DEFAULT_PROVIDER_IDS: readonly string[] = ["ark-plan"];

export interface ArkUsageConfig {
  accessKeyId?: string;
  secretAccessKey?: string;
  /** OpenAPI region (default cn-beijing; must match the ark data-plane region). */
  region?: string;
  /** Gateway host override; constrained to *.volcengineapi.com. */
  gatewayHost?: string;
  /** Provider ids to register under (default ark-plan; change needs a reload). */
  providerIds?: string[];
  /** Which plan API to query: auto (default) = Coding then Agent fallback. */
  product?: "auto" | "coding" | "agent";
}

const REGION_RE = /^[a-z0-9-]{2,32}$/i;
const HOST_SUFFIX = ".volcengineapi.com";

export function isVolcengineApiHost(host: string): boolean {
  const value = String(host || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return value === "volcengineapi.com" || value.endsWith(HOST_SUFFIX);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeConfig(raw: Record<string, unknown>): ArkUsageConfig {
  const cfg: ArkUsageConfig = {
    ...(str(raw.accessKeyId) ? { accessKeyId: str(raw.accessKeyId) } : {}),
    ...(str(raw.secretAccessKey) ? { secretAccessKey: str(raw.secretAccessKey) } : {}),
  };
  const region = str(raw.region);
  if (region && REGION_RE.test(region)) cfg.region = region;
  const host = str(raw.gatewayHost);
  if (host && isVolcengineApiHost(host)) cfg.gatewayHost = host.toLowerCase();
  const ids = raw.providerIds;
  if (Array.isArray(ids)) {
    const clean = ids.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
    if (clean.length > 0) cfg.providerIds = [...new Set(clean)];
  }
  const product = str(raw.product);
  if (product === "coding" || product === "agent" || product === "auto") cfg.product = product;
  return cfg;
}

/** Read + normalize the config file; missing/corrupt file → empty config (fail-honest). */
export function readConfig(configDir: string): ArkUsageConfig {
  try {
    const raw = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    return normalizeConfig(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {});
  } catch {
    return {};
  }
}

/** Merge a patch into the config file (atomic write, 0600 — it carries secrets). */
export function writeConfig(configDir: string, patch: Record<string, unknown>): ArkUsageConfig {
  const current = readConfig(configDir) as Record<string, unknown>;
  const merged = normalizeConfig({ ...current, ...patch });
  mkdirSync(configDir, { recursive: true });
  const target = join(configDir, "config.json");
  const tmp = join(configDir, `.config-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, target);
  return merged;
}

export function isConfigured(cfg: ArkUsageConfig): boolean {
  return Boolean(cfg.accessKeyId && cfg.secretAccessKey);
}

/** Never render a full secret: `abcd…wxyz`. */
export function maskSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "…";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
