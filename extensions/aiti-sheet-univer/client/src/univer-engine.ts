/**
 * Univer 启动器（ESM 懒加载 chunk）。
 *
 * 全部 Univer 依赖（含 react/react-dom/redi，ESM 单实例）经 vite 动态 import 打进
 * 独立 chunk——只有打开表格文件才会拉取。DI 标识符/类身份在单 bundle 内天然一致
 * （UMD 拼装方案的 preset 内联插件与外部包类身份分裂问题在此根除）。
 *
 * exceljs 仍走 vendor UMD（已验证可用，避免 nodejs dist 进 bundle）。
 */
import { LocaleType, Univer } from "@univerjs/core";
import { FUniver } from "@univerjs/core/facade";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import { defaultTheme } from "@univerjs/themes";
import presetLocaleZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";

export interface SheetEngine {
  fWorkbook: any;
  addCommandListener: (cb: (id: string) => void) => void;
  dispose: () => void;
}

export async function bootSheetEngine(
  container: HTMLElement,
  snapshot: any,
  opts: { editable: boolean; onMutation?: () => void },
): Promise<SheetEngine> {
  // Univer 挂载容器：preset 的 UI 插件默认找 id="app"，给唯一 id 显式指定
  const mountId = "aiti-sheet-univer-mount-" + Math.random().toString(36).slice(2, 8);
  const mount = document.createElement("div");
  mount.id = mountId;
  mount.style.cssText = "position:absolute;inset:0;";
  container.appendChild(mount);

  const univer = new Univer({
    theme: defaultTheme,
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: presetLocaleZhCN },
  });
  try {
    const pluginTuples = UniverSheetsCorePreset({ container: mountId }).plugins.map(
      (p: any) => (Array.isArray(p) ? p : [p, undefined]),
    );
    univer.registerPlugins(pluginTuples);
  } catch (e) {
    console.error("[aiti-sheet-univer] registerPlugins 失败:", e);
    throw e;
  }
  const univerAPI = FUniver.newAPI(univer);
  let fWorkbook: any;
  try {
    fWorkbook = univerAPI.createUniverSheet(snapshot);
  } catch (e) {
    console.error("[aiti-sheet-univer] createUniverSheet 失败:", e);
    throw e;
  }
  try { fWorkbook.setEditable(!!opts.editable); } catch { /* 忽略 */ }

  let onMutation = opts.onMutation;
  const disposable = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (ev: any) => {
    if (!onMutation) return;
    const id = String(ev?.params?.command?.id || "");
    if (id.endsWith(".mutation") || id.endsWith(".oper")) onMutation();
  });

  return {
    fWorkbook,
    addCommandListener: (cb) => { onMutation = cb; },
    dispose: () => {
      onMutation = null;
      try { disposable?.dispose?.(); } catch { /* 忽略 */ }
      try { univerAPI.dispose(); } catch { /* 忽略 */ }
      try { univer.dispose?.(); } catch { /* 忽略 */ }
      try { container.innerHTML = ""; } catch { /* 忽略 */ }
    },
  };
}

