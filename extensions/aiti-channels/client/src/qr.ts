/**
 * aiti-channels · QR helper — dynamic import("qrcode"), same dependency the
 * service-tunnels client bundle uses (shared root reconcile keeps it single).
 * Modeled on extensions/service-tunnels/client/src/qr.ts.
 */

type ToDataURL = (text: string, opts?: Record<string, unknown>) => Promise<string>;

async function toDataURLFn(): Promise<ToDataURL> {
  const mod = (await import(/* @vite-ignore */ "qrcode")) as {
    toDataURL?: ToDataURL;
    default?: { toDataURL?: ToDataURL };
  };
  const fn = mod.default?.toDataURL ?? mod.toDataURL;
  if (!fn) throw new Error("qrcode toDataURL unavailable");
  return fn;
}

/** QR PNG dataURL (dark-on-light; size px, margin quiet-zone modules). */
export async function qrDataUrl(text: string, opts?: { size?: number; margin?: number }): Promise<string> {
  const fn = await toDataURLFn();
  return fn(text, {
    width: opts?.size ?? 220,
    margin: opts?.margin ?? 1,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
