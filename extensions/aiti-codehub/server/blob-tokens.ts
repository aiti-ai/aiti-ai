/**
 * Opaque short-lived tokens for authenticated blob URLs.
 *
 * The client never puts a repo/file path in a URL: it asks for a token via a POST
 * body, then <img>/download uses /api/extensions/aiti-codehub/code/blob/<token>.
 */
import { randomBytes } from "node:crypto";
import type { ForgeRepo } from "./contract.ts";

export interface BlobTarget {
  provider: string;
  repo: ForgeRepo;
  ref?: string;
  path: string;
  download: boolean;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const tokens = new Map<string, BlobTarget>();

export function issueBlobToken(target: Omit<BlobTarget, "expiresAt">): { token: string; expiresAt: number } {
  prune();
  const token = randomBytes(24).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const expiresAt = Date.now() + TTL_MS;
  tokens.set(token, { ...target, expiresAt });
  return { token, expiresAt };
}

export function resolveBlobToken(token: string): BlobTarget | undefined {
  prune();
  const t = tokens.get(token);
  if (!t) return undefined;
  if (Date.now() > t.expiresAt) {
    tokens.delete(token);
    return undefined;
  }
  return t;
}

function prune(): void {
  const now = Date.now();
  for (const [k, v] of tokens) if (now > v.expiresAt) tokens.delete(k);
}
