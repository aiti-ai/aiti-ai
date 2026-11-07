/**
 * aiti-onlyoffice · HMAC 一次性 token + 文件类型判定（纯函数，node --test 可直测）。
 *
 * token 格式：`<filePath>.<exp-base36>.<HMAC-SHA256-base64url>`
 * ⚠ 回归钉（2026-09-07）：签名输入是**原始路径**（不 encodeURIComponent）——
 * searchParams.get("t") 取到的 token 已被 URL 解码一次，签发/校验两侧必须同为
 * 解码后形态；曾经签发侧对编码后路径签名导致校验恒 403（download 失败）。
 * URL 拼接侧由调用方 encodeURIComponent(token)，与解码对称。
 */
import { createHmac } from "node:crypto";

export function hmacToken(secret: string, filePath: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const body = filePath + "." + exp.toString(36);
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return body + "." + sig;
}

export function verifyToken(secret: string, token: string): { filePath: string } | null {
  const i = token.lastIndexOf(".");
  const j = token.lastIndexOf(".", i - 1);
  if (i < 0 || j < 0) return null;
  const fp = token.slice(0, j);
  const exp = parseInt(token.slice(j + 1, i), 36);
  const sig = token.slice(i + 1);
  const body = token.slice(0, i);
  const want = createHmac("sha256", secret).update(body).digest("base64url");
  if (sig.length !== want.length || !sig.split("").every((c, k) => c === want[k])) return null;
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  return { filePath: fp };
}

/** 文件类型 → DS documentType（download/callback 白名单共用；含 DS 原生支持的老格式） */
export function documentTypeOf(filePath: string): "word" | "cell" | "slide" | null {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  if (ext === "docx" || ext === "doc" || ext === "odt") return "word";
  if (ext === "xlsx" || ext === "xlsm" || ext === "xls" || ext === "ods") return "cell";
  if (ext === "pptx" || ext === "ppt" || ext === "odp") return "slide";
  return null;
}
