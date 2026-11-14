/**
 * aiti-sheet-univer · 服务端（薄壳）。
 *
 * 职责（方案 §2.1）：仅一个 save-blob route（二进制写盘，共享 blob-save-route 工厂）。
 * exceljs / Univer / @e965/xlsx 全部是 client vendor 依赖——服务端零数据面依赖。
 * 读文件复用核心 /api/files（经 aiti-editor 票据端点）与 aiti-editor /t/<ticket>/file。
 */
import { createBlobSaveRoute } from "./blob-save-route";
import { createConvertSaveAsRoute } from "./convert-saveas";
import { locateSoffice, locateSofficeAsync, setSofficeDataDir, invalidateSofficeCache, SOFFICE_INSTALL_HINTS } from "./soffice-locate";

// 老格式 → 可编辑 xlsx（另存派生，不覆盖：-fromxls / -fromods / (n) 递增）
const convertSaveAsRoute = createConvertSaveAsRoute({
  extId: "aiti-sheet-univer",
  conversions: {
    xls: { toExt: "xlsx", filter: "xlsx:Calc MS Excel 2007 XML" },
    ods: { toExt: "xlsx", filter: "xlsx:Calc MS Excel 2007 XML" },
  },
  sofficePath: () => locateSoffice().path,
});

const saveBlobRoute = createBlobSaveRoute({
  extId: "aiti-sheet-univer",
  allowedExts: [".xlsx", ".xlsm"],
  maxBytes: 30 * 1024 * 1024, // §五 风险表：maxBytes 30MB
});

export default {
  id: "aiti-sheet-univer",
  name: "aiti-sheet-univer",
  description: "Excel 表格编辑器（exceljs 数据面 + Univer 视图面）：.xlsx/.xlsm 预览+编辑，.xls/.ods 只读预览",
  client: "dist/aiti-sheet-univer-client.mjs",
  clientImmediately: true,
  icon: "icon.svg",
  features: [
    { id: "sheet.edit", label: "Excel 编辑保存", description: "开启后 .xlsx/.xlsm 提供 edit 能力（保存走 save-blob）；关闭仅预览", default: true },
  ],
  server: {
    startup(ctx: any) {
      if (ctx.configDir) setSofficeDataDir(ctx.configDir); // soffice 定位读同一份 features.json
      console.log("[aiti-sheet-univer] 就绪");
    },
    async api(req: Request, ctx: any) {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const p = new URL(req.url).pathname.split("/").filter(Boolean);
      if (p[p.length - 1] === "save-blob" && req.method === "POST") {
        return await saveBlobRoute(req);
      }
      if (p[p.length - 1] === "convert-saveas" && req.method === "POST") {
        return await convertSaveAsRoute(req);
      }
      // GET /soffice-status → LibreOffice 定位（客户端降级面板用）
      if (p[p.length - 1] === "soffice-status" && req.method === "GET") {
        if (new URL(req.url).searchParams.get("refresh") === "1") invalidateSofficeCache();
        const r = await locateSofficeAsync();
        return json({ ok: true, available: !!r.path, path: r.path, source: r.source, version: r.version || null, installHints: SOFFICE_INSTALL_HINTS });
      }
      return new Response(JSON.stringify({ ok: false, error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
};
