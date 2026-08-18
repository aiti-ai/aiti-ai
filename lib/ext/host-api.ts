/**
 * 扩展宿主公共接口（core 薄注册表，非消息）。
 *
 * AppShell 注册「原样能力」（不理解为扩展做适配——fileName 兜底等适配在
 * 框架层 ctx 包装处）；扩展经 ctx.openFile/revealDir/appendText 直接同步调用。
 * 同步为主，返回 void；如需异步能力（文件校验/会话查询等）接口可扩展为
 * `void | Promise<T>`，ctx 透传返回值。
 */
export interface HostApi {
  /** 打开文件标签页（AppShell 原样能力：filePath + fileName 必填） */
  openFile?: (filePath: string, fileName: string) => void | Promise<void>;
  /** 侧栏文件树定位目录 */
  revealDir?: (absPath: string) => void | Promise<void>;
  /** 输入框追加文本（不发送；引用回复预填用） */
  appendText?: (text: string) => void | Promise<void>;
}

const hostApi: HostApi = {};

/** AppShell 注册（组件体调用一行，只给原样函数）。 */
export function registerHostApi(api: HostApi): void {
  if (api.openFile) hostApi.openFile = api.openFile;
  if (api.revealDir) hostApi.revealDir = api.revealDir;
  if (api.appendText) hostApi.appendText = api.appendText;
}

export function getHostApi(): HostApi {
  return hostApi;
}
