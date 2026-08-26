import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { dataRoot } from "@/lib/ext/data-dir";

/**
 * 稳态路径令牌（确定性假名化）——供 <img>/<video> src 与 EventSource 等只能用 GET URL 的
 * 消费者隐藏真实路径（防落入隧道/代理 access log）。
 *
 *   token = "P1" ‖ AES-256-CBC(key, 零IV, PKCS7(path)) ‖ HMAC-SHA256(key, 密文)[0..8)
 *
 * - 确定性：同一路径永远得到同一 token → 浏览器缓存跨会话复用，URL 可进 <img src>/EventSource
 * - 自包含可逆：服务端持钥即解码，零服务端状态、重启不失活
 * - 完整性：encrypt-then-MAC，篡改即拒
 * - 已知取舍：① 同前缀路径的首个密文块相同（等值关联的弱化形式）；② 令牌永久有效——
 *   解码后仍走 allowedRoots 实时鉴权，换钥（删 key 文件重启）即全量作废。
 *
 * 密钥：dataRoot()/core/path-token.key（600），首次使用自动生成；PI_WEB_DATA_DIR 迁移时随目录走。
 */

const HEADER = Buffer.from([0x50, 0x31]); // "P1"
const MAC_BYTES = 8;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const dir = join(dataRoot(), "core");
  const file = join(dir, "path-token.key");
  if (existsSync(file)) {
    const key = readFileSync(file);
    if (key.length === 32) {
      cachedKey = key;
      return key;
    }
  }
  const key = randomBytes(32);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  cachedKey = key;
  return key;
}

/** 路径 → 稳态令牌（base64url）。同一路径输出恒定。 */
export function encodePathToken(filePath: string): string {
  const key = getKey();
  const cipher = createCipheriv("aes-256-cbc", key, Buffer.alloc(16, 0));
  const ct = Buffer.concat([cipher.update(filePath, "utf8"), cipher.final()]);
  const mac = createHmac("sha256", key).update(ct).digest().subarray(0, MAC_BYTES);
  return Buffer.concat([HEADER, ct, mac]).toString("base64url");
}

/** 令牌 → 路径。无效/被篡改返回 null。 */
export function decodePathToken(token: string): string | null {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < HEADER.length + 16 + MAC_BYTES || !raw.subarray(0, 2).equals(HEADER)) return null;
    const ct = raw.subarray(2, raw.length - MAC_BYTES);
    const mac = raw.subarray(raw.length - MAC_BYTES);
    const key = getKey();
    const expect = createHmac("sha256", key).update(ct).digest().subarray(0, MAC_BYTES);
    if (!mac.equals(expect)) return null;
    const decipher = createDecipheriv("aes-256-cbc", key, Buffer.alloc(16, 0));
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
