/**
 * 扩展宿主公共接口（core 薄注册表，非消息）。
 *
 * AppShell 注册「原样能力」（不理解为扩展做适配——fileName 兜底等适配在
 * 框架层 ctx 包装处）；扩展经 ctx.openFile/revealDir/appendText 直接同步调用。
 * 同步为主，返回 void；如需异步能力（文件校验/会话查询等）接口可扩展为
 * `void | Promise<T>`，ctx 透传返回值。
 */
/**
 * 打开文件标签页的选项（扩展经 ctx.openFile 透传；core 原样能力，不解释）。
 * select:false = 后台打开（只加标签页，不激活/不展开面板）；缺省 true。
 */
export interface OpenFileOptions {
  sourceSessionId?: string | null;
  modeHint?: "diff";
  select?: boolean;
}

/** 打开文件夹标签页的选项（扩展经 ctx.openFolder 透传；select:false = 后台打开不激活）。 */
export interface OpenFolderOptions {
  select?: boolean;
}

export interface HostApi {
  /** 打开文件标签页（AppShell 原样能力：filePath + fileName 必填，options 透传） */
  openFile?: (filePath: string, fileName: string, options?: OpenFileOptions) => void | Promise<void>;
  /** 打开文件夹标签页（右侧面板 FolderViewer；display-only，不影响 cwd） */
  openFolder?: (folderPath: string, folderName: string, options?: OpenFolderOptions) => void | Promise<void>;
  /** 侧栏文件树定位目录 */
  revealDir?: (absPath: string) => void | Promise<void>;
  /** 当前打开的标签页清单（{ id, filePath, kind, pinned }，数组序=打开序；仅读原语，无策略。
   *  kind "image" = 消息图片预览 tab（filePath 为空串，内容走 tab 自带 imageSrc）） */
  getFileTabs?: () => { id: string; filePath: string; kind?: "file" | "folder" | "dock" | "image"; pinned?: boolean }[];
  /** 关闭指定 id 的标签页（原语：只从状态移除+重排激活位；脏确认/钉住等策略由调用方负责） */
  closeFileTabs?: (ids: string[]) => void;
  /** 输入框追加文本（不发送；引用回复预填用） */
  appendText?: (text: string) => void | Promise<void>;
  /** 程序化写值（composer 契约受控路径：state → DOM 同步 effect，tracker 同步） */
  writeComposerValue?: (text: string) => boolean | Promise<boolean>;
  /** 完整还原草稿进输入框（文本 + 图片，raw 不跑钩子——与 core 恢复第一条一致）。
   *  返回是否真正还原（composer 未挂载时 false——调用方不应消费草稿）。 */
  restoreComposerDraft?: (draft: { value: string; images: { data: string; mimeType: string }[] }) => boolean | Promise<boolean>;
}

const hostApi: HostApi = {};

/** AppShell 注册（组件体调用一行，只给原样函数）。 */
export function registerHostApi(api: HostApi): void {
  if (api.openFile) hostApi.openFile = api.openFile;
  if (api.openFolder) hostApi.openFolder = api.openFolder;
  if (api.revealDir) hostApi.revealDir = api.revealDir;
  if (api.getFileTabs) hostApi.getFileTabs = api.getFileTabs;
  if (api.closeFileTabs) hostApi.closeFileTabs = api.closeFileTabs;
  if (api.appendText) hostApi.appendText = api.appendText;
  if (api.writeComposerValue) hostApi.writeComposerValue = api.writeComposerValue;
  if (api.restoreComposerDraft) hostApi.restoreComposerDraft = api.restoreComposerDraft;
}

export function getHostApi(): HostApi {
  return hostApi;
}
