/**
 * aiti-onlyoffice · client 入口（M2，docs/aiti-editor-office-plan.md §2.4）。
 *
 * 注册判据（server /status）：feature onlyoffice.enabled 开 + DocumentServer healthcheck 通过
 * → 注册 word/sheet/slide 三 provider（分开注册让用户能分别设默认）。失败 → 不注册（菜单自然无此项）。
 * 保存不经 ContentProvider（DS 内部经 callback 直写服务端），仅本次注册 editor provider。
 */
import { whenAitiEditorReady } from "../../../_shared/aiti-editor-inject.mjs";
import { renderOnlyofficeView } from "./oo-view";

interface ProviderSpec {
  id: string;
  displayName: string;
  extensions: string[];
  about: { summary: string; capabilities: string[]; limits: string[]; vendor: string };
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: "aiti-onlyoffice.docx",
    displayName: "Word（OnlyOffice）",
    extensions: [".docx", ".doc", ".odt"],
    about: {
      summary: "OnlyOffice DocumentServer 深度保真 Word 编辑（完整排版还原；.doc/.odt 老格式原生编辑）",
      capabilities: ["完整保真渲染与编辑（与桌面 Word 同引擎）", "DS 侧保存（forcesave/自动保存经 callback 直写服务端）", "批注 / 修订 / 目录 / 文本框等复杂排版", "文件变化实时跟随（mtime → key 变 → DS 重拉）"],
      limits: ["需要本机 Docker 运行 OnlyOffice DocumentServer（scripts/onlyoffice-up.sh）", "容器不可达时 provider 自动消失（菜单无此项）", "AGPL 社区版（隔离于本扩展，不装即无）"],
      vendor: "OnlyOffice DocumentServer (AGPL-3.0 社区版，Docker)",
    },
  },
  {
    id: "aiti-onlyoffice.sheet",
    displayName: "Excel（OnlyOffice）",
    extensions: [".xlsx", ".xlsm", ".xls", ".ods"],
    about: {
      summary: "OnlyOffice DocumentServer 深度保真 Excel 编辑（.xls/.ods 老格式原生编辑）",
      capabilities: ["完整保真渲染与编辑（公式 / 图表 / 透视表 / 条件格式）", "DS 侧保存（forcesave/自动保存经 callback 直写服务端）", "文件变化实时跟随"],
      limits: ["需要本机 Docker 运行 OnlyOffice DocumentServer", "容器不可达时 provider 自动消失", "AGPL 社区版（隔离于本扩展）"],
      vendor: "OnlyOffice DocumentServer (AGPL-3.0 社区版，Docker)",
    },
  },
  {
    id: "aiti-onlyoffice.slide",
    displayName: "PowerPoint（OnlyOffice）",
    extensions: [".pptx", ".ppt", ".odp"],
    about: {
      summary: "OnlyOffice DocumentServer 深度保真 PPT 编辑（.ppt/.odp 老格式原生编辑）",
      capabilities: ["完整保真渲染与编辑（母版 / 动画占位 / 形状）", "DS 侧保存（forcesave/自动保存经 callback 直写服务端）"],
      limits: ["需要本机 Docker 运行 OnlyOffice DocumentServer", "容器不可达时 provider 自动消失", "AGPL 社区版（隔离于本扩展）"],
      vendor: "OnlyOffice DocumentServer (AGPL-3.0 社区版，Docker)",
    },
  },
];

async function tryRegister(ctx: Record<string, any>): Promise<void> {
  const apiUrl = (p: string) => (typeof ctx.apiUrl === "function" ? ctx.apiUrl(p) : p);
  let status: any = null;
  try {
    status = await fetch(apiUrl("/api/extensions/aiti-onlyoffice/status"), { cache: "no-store" }).then((r) => r.json());
  } catch { return; }
  if (!status?.ok || !status.enabled || !status.available) {
    console.log("[aiti-onlyoffice] 不注册 provider：" + (status?.message || "status 不可达"));
    return;
  }
  // dsPublicUrl 传给视图（api.js 加载地址）
  (window as any).__aitiOnlyofficeDsPublicUrl = status.publicUrl || "";

  whenAitiEditorReady(() => {
    const we = (window as any).__aitiEditor;
    const disposables: Array<() => void> = (window as any).__aitiOnlyofficeDisposables || [];
    for (const off of disposables) { try { off(); } catch { /* 忽略 */ } }
    disposables.length = 0;

    for (const spec of PROVIDERS) {
      disposables.push(we.registerEditorProvider({
        id: spec.id,
        displayName: spec.displayName,
        sourceExt: "aiti-onlyoffice",
        selector: { extensions: spec.extensions },
        capabilities: ["preview", "edit"],
        defaultCapability: "edit",
        about: spec.about,
        render: (host: any, c: any) => renderOnlyofficeView(host, c),
      }));
    }
    (window as any).__aitiOnlyofficeDisposables = disposables;
  });
}

function register(ctx: Record<string, any>): void {
  // apiUrl（多实例 /dev 前缀安全）→ oo-view 的 config fetch 用
  (window as any).__aitiOnlyofficeApiUrl = (p: string) => (typeof ctx.apiUrl === "function" ? ctx.apiUrl(p) : p);
  // 状态探测（/status）推到「编辑器首次就绪」——即用户第一次打开文件/用编辑器时，
  // 开页不再打这个请求。provider 晚到注册由编辑器仲裁层重新仲裁当前文件
  // （registry.registerEditorProvider → fireActiveChange）。
  whenAitiEditorReady(() => { void tryRegister(ctx); });
}

export default register;
