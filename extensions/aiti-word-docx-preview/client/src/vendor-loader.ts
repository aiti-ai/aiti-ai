/**
 * vendor UMD 受控执行加载器（aiti-editor loadVendorGlobal 同款惯例的单文件副本——
 * 实现扩展 client 不 import aiti-editor 源码，构建期零跨扩展依赖）。
 *
 * 不能用 <script> 直插：页面存在 Monaco AMD loader（window.define.amd）时，
 * UMD 库会注册成 AMD 匿名模块而非挂载全局 → window.xxx 永远不存在。
 * 受控执行屏蔽 exports/module/define，强制走 globalThis 挂载分支。
 */
const _vendorPromises: Record<string, Promise<any>> = {};

export function loadVendorGlobal(url: string, globalName: string, factory?: (g: any) => any): Promise<any> {
  const w = window as any;
  if (w[globalName]) return Promise.resolve(w[globalName]);
  const key = globalName + "|" + url;
  if (_vendorPromises[key]) return _vendorPromises[key];
  const p = new Promise((resolve, reject) => {
    fetch(url, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error("vendor 加载失败: " + url); return r.text(); })
      .then((code) => {
        try { new Function("exports", "module", "define", code)(undefined, undefined, undefined); } catch {}
        if (w[globalName]) resolve(factory ? factory(w[globalName]) : w[globalName]);
        else reject(new Error("vendor 全局未挂载: " + globalName));
      })
      .catch(reject);
  });
  p.catch(() => { delete _vendorPromises[key]; }); // 失败不永久缓存
  return p;
}
