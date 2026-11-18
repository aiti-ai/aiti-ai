/**
 * Cryptography primitives for the secret vault.
 *
 * - AES-256-GCM with a random 12-byte IV per value (authenticated encryption:
 *   wrong key / tampered ciphertext fails closed).
 * - Master key lives in a 32-byte keyfile (0600). No passphrase: the design
 *   accepts that a same-uid process can read the key, and buys zero-friction
 *   unattended use. The encrypted file only protects the case "the vault file
 *   leaves this machine" (backups, sync, accidental push).
 * - All writes are atomic (temp file + rename) with 0600 permissions.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Envelope {
  iv: string;
  tag: string;
  ct: string;
}

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encryptValue(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptValue(key: Buffer, env: Envelope): string {
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("vault: malformed envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
}

/** Atomic write with 0600 (best effort on Windows where chmod is a no-op). */
export function writeFileAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, data, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // Windows: ACLs come from the parent directory
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best effort
  }
}

/** Read the keyfile; `undefined` when it does not exist. */
export function readKeyFile(path: string): Buffer | undefined {
  try {
    const raw = readFileSync(path);
    if (raw.length !== KEY_BYTES) throw new Error(`vault: keyfile ${path} must be exactly ${KEY_BYTES} bytes`);
    return raw;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Create the keyfile (0600). Returns the key. */
export function createKeyFile(path: string): Buffer {
  const key = generateKey();
  writeFileAtomic(path, key, 0o600);
  return key;
}
