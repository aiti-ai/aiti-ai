/**
 * 表格引擎加载器。
 *
 * - exceljs：vendor UMD 受控执行（aiti-editor loadVendorGlobal 惯例，防 Monaco AMD 劫持）
 * - Univer：vite 动态 import chunk（react/react-dom/redi/univer 全家单实例打包，
 *   打开表格文件才拉取；DI 标识符单 bundle 内天然一致）
 */
import { loadVendorGlobal } from "./vendor-loader";
import type { SheetEngine } from "./univer-engine";

const base = () => {
  // 优先：register(ctx) 注入的 basePath 感知 apiUrl（多实例 /dev 前缀安全）
  const api = (window as any).__aitiSheetUniverApiUrl;
  if (typeof api === "function") {
    try { return api("/api/extensions/aiti-sheet-univer/assets/"); } catch { /* 兜底 */ }
  }
  // 兜底：bundle 自身 URL（含 basePath 与 /assets/ 前缀；产物目录 dist/，旧部署 client/ 兼容）
  const m = import.meta.url.match(/^(.*\/assets\/)(?:dist|client)\//);
  if (m) return m[1];
  return "/api/extensions/aiti-sheet-univer/assets/";
};

const v = (f: string) => base() + "vendor/" + f;

/** exceljs（.xlsx/.xlsm 数据面） */
export function loadExcelJS(): Promise<any> {
  return loadVendorGlobal(v("exceljs.min.js"), "ExcelJS");
}

/** @e965/xlsx（.xls/.ods 只读解析兜底） */
export function loadXlsx(): Promise<any> {
  return loadVendorGlobal(v("xlsx.full.min.js"), "XLSX");
}

let cssInjected = false;
/** Univer 样式（assetFileNames 加前缀：aiti-sheet-univer-aiti-sheet-univer.css） */
function injectCss(): void {
  if (cssInjected) return;
  const m = import.meta.url.match(/^(.*\/assets\/)(?:dist|client)\//);
  if (!m) return;
  cssInjected = true;
  const link = document.createElement("link");
  link.id = "aiti-sheet-univer-css";
  link.rel = "stylesheet";
  link.href = m[1] + "dist/aiti-sheet-univer-aiti-sheet-univer.css";
  document.head.appendChild(link);
}

let enginePromise: Promise<typeof import("./univer-engine")> | null = null;

/** Univer 引擎（动态 chunk；失败可重试） */
export function loadUniverEngine(): Promise<typeof import("./univer-engine")> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const mod = await import("./univer-engine");
    injectCss();
    return mod;
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

export interface SheetEditorInstance {
  snapshot: () => any;
  setEditable: (editable: boolean) => void;
  dispose: () => void;
}

/** 创建 Univer sheet 编辑器实例（挂进 container 只是个占位契约；Univer 自渲染 canvas） */
export async function createSheetEditor(
  container: HTMLElement,
  snapshot: any,
  opts: { editable: boolean; onMutation?: () => void },
): Promise<SheetEditorInstance> {
  const engine = await loadUniverEngine();
  const inst = await engine.bootSheetEngine(container, snapshot, opts);
  return {
    snapshot: () => {
      try { return inst.fWorkbook.getSnapshot(); } catch { return null; }
    },
    setEditable: (editable: boolean) => {
      try { inst.fWorkbook.setEditable(editable); } catch { /* 忽略 */ }
    },
    dispose: () => { try { inst.dispose(); } catch { /* 忽略 */ } },
  };
}
