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

export interface HostApi {
  /** 打开文件标签页（AppShell 原样能力：filePath + fileName 必填，options 透传） */
  openFile?: (filePath: string, fileName: string, options?: OpenFileOptions) => void | Promise<void>;
  /** 打开文件夹标签页（右侧面板 FolderViewer；display-only，不影响 cwd） */
  openFolder?: (folderPath: string, folderName: string) => void | Promise<void>;
  /** 侧栏文件树定位目录 */
  revealDir?: (absPath: string) => void | Promise<void>;
  /** 输入框追加文本（不发送；引用回复预填用） */
  appendText?: (text: string) => void | Promise<void>;
}

const hostApi: HostApi = {};

/** AppShell 注册（组件体调用一行，只给原样函数）。 */
export function registerHostApi(api: HostApi): void {
  if (api.openFile) hostApi.openFile = api.openFile;
  if (api.openFolder) hostApi.openFolder = api.openFolder;
  if (api.revealDir) hostApi.revealDir = api.revealDir;
  if (api.appendText) hostApi.appendText = api.appendText;
}

export function getHostApi(): HostApi {
  return hostApi;
}
