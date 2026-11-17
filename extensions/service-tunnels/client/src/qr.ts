/**
 * 共用 QR 工具（方案 §3.5）——`import("qrcode")` 动态导入，与 UsersTab TOTP
 * 出码同一依赖（已在 client bundle，零新依赖）。新代码统一走这里；UsersTab
 * 保持原样不动（避免无谓回归）。
 */

type ToDataURL = (text: string, opts?: Record<string, unknown>) => Promise<string>;

async function toDataURLFn(): Promise<ToDataURL> {
  const mod = (await import("qrcode")) as {
    toDataURL?: ToDataURL;
    default?: { toDataURL?: ToDataURL };
  };
  const fn = mod.default?.toDataURL ?? mod.toDataURL;
  if (!fn) throw new Error("qrcode toDataURL unavailable");
  return fn;
}

/** QR PNG dataURL（黑码白底；size 像素，margin 静区格数）。 */
export async function qrDataUrl(text: string, opts?: { size?: number; margin?: number }): Promise<string> {
  const fn = await toDataURLFn();
  return fn(text, {
    width: opts?.size ?? 176,
    margin: opts?.margin ?? 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

/** 触发浏览器下载一张 PNG 二维码（就绪卡「下载二维码」）。 */
export function downloadQrPng(dataUrl: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
