/**
 * Account instances (multi-account layer).
 *
 * A "provider" is the platform adapter (yunxiao / github / gitee / gitlab). An
 * "instance" is one configured account on that platform. Instance ids are stable and
 * filesystem-safe:
 *
 *   default instance  ->  <platform>              (e.g. "yunxiao")
 *   extra instances   ->  <platform>~<slug>       (e.g. "yunxiao~work")
 *
 * "~" is RFC 3986 unreserved, so ids are legal in file names on every OS (Windows
 * forbids ":"), need no URL encoding, and never collide with a platform id.
 *
 * The alias is the only user-facing name; it is editable while the id never changes.
 */
import { randomBytes } from "node:crypto";
import type { ProviderConfig, ProviderInstance } from "./contract.ts";
import { ForgeHttpError } from "./http.ts";

export const INSTANCE_SEP = "~";
export const MAX_INSTANCES_PER_PLATFORM = 20;
export const MAX_ALIAS_LENGTH = 40;
const MAX_SLUG_LENGTH = 24;

const ID_RE = /^[a-z0-9][a-z0-9-]*(~[a-z0-9][a-z0-9-]*)?$/;

/** Platform part of an instance id ("yunxiao~work" -> "yunxiao"). */
export function platformOf(id: string): string {
  const s = String(id || "");
  const i = s.indexOf(INSTANCE_SEP);
  return i < 0 ? s : s.slice(0, i);
}

/** Slug part of an instance id; empty for the default instance. */
export function slugOf(id: string): string {
  const s = String(id || "");
  const i = s.indexOf(INSTANCE_SEP);
  return i < 0 ? "" : s.slice(i + 1);
}

export function instanceIdOf(platform: string, slug?: string): string {
  const p = String(platform || "").trim();
  const s = String(slug || "").trim();
  return s ? `${p}${INSTANCE_SEP}${s}` : p;
}

export function isDefaultInstanceId(id: string): boolean {
  return !String(id || "").includes(INSTANCE_SEP);
}

export function isValidInstanceId(id: string): boolean {
  const s = String(id || "");
  return s.length > 0 && s.length <= 64 && ID_RE.test(s);
}

/**
 * Turn an alias into a slug. Non-latin aliases return null: the caller
 * falls back to a random suffix, because a half-transliterated slug is worse than an
 * opaque one (the alias stays readable in every UI surface).
 */
export function slugFromAlias(alias: string): string | null {
  const s = String(alias || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return /^[a-z0-9][a-z0-9-]*$/.test(s) ? s : null;
}

function randomSlug(): string {
  return `inst-${randomBytes(3).toString("base64").replace(/\+/g, "a").replace(/\//g, "b").replace(/=+$/g, "").toLowerCase().slice(0, 4)}`;
}

/** Derive a free instance id for a platform, avoiding ids already in `taken`. */
export function deriveInstanceId(platform: string, alias: string, taken: Set<string>): string {
  const base = slugFromAlias(alias) || randomSlug();
  let id = instanceIdOf(platform, base);
  for (let i = 2; taken.has(id); i += 1) {
    id = instanceIdOf(platform, `${base}-${i}`);
    if (i > 99) {
      id = instanceIdOf(platform, randomSlug());
      break;
    }
  }
  return id;
}

/** Trim + length/control-character checks. Empty aliases are rejected. */
export function normalizeAlias(raw: string): string {
  const alias = String(raw ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (!alias) throw new ForgeHttpError("Account alias must not be empty", { status: 400, code: "bad_request" });
  if (alias.length > MAX_ALIAS_LENGTH) throw new ForgeHttpError(`Account alias is limited to ${MAX_ALIAS_LENGTH} characters`, { status: 400, code: "bad_request" });
  return alias;
}

export function sameAlias(a: string, b: string): boolean {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

/** Display label: alias, else the platform label (default instance), else "<label> <slug>". */
export function instanceLabel(inst: { id: string; platform: string; alias?: string }, platformLabel: string): string {
  const alias = String(inst.alias || "").trim();
  if (alias) return alias;
  if (isDefaultInstanceId(inst.id)) return platformLabel;
  const slug = slugOf(inst.id);
  return slug ? `${platformLabel} ${slug}` : platformLabel;
}

/** Instance metadata derived from an id + stored config (used when scanning files). */
export function instanceFromConfig(id: string, cfg: ProviderConfig, createdAt: number): ProviderInstance {
  return {
    id,
    platform: platformOf(id),
    alias: String(cfg.alias || ""),
    createdAt: Number(cfg.createdAt) || createdAt,
  };
}
