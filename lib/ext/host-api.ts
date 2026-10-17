/**
 * Extension host public API (thin core registry, not messages).
 *
 * AppShell registers "as-is capabilities" (no adaptation for extensions —
 * adaptations like the fileName fallback live in the framework ctx wrapper);
 * extensions call them synchronously via ctx.openFile/revealDir/appendText.
 * Mostly synchronous, returning void; if async capabilities are needed (file
 * validation/session queries etc.) signatures can be extended to
 * `void | Promise<T>`, with ctx passing the return value through.
 */
/**
 * Options for opening a file tab (passed through by extensions via ctx.openFile;
 * core as-is capability, not interpreted).
 * select:false = open in background (add tab only, no activate/no panel expand);
 * default true.
 */
export interface OpenFileOptions {
  sourceSessionId?: string | null;
  modeHint?: "diff";
  select?: boolean;
}

/** Options for opening a folder tab (passed through by extensions via ctx.openFolder; select:false = open in background without activating). */
export interface OpenFolderOptions {
  select?: boolean;
}

export interface HostApi {
  /** Open a file tab (AppShell as-is capability: filePath + fileName required, options passed through) */
  openFile?: (filePath: string, fileName: string, options?: OpenFileOptions) => void | Promise<void>;
  /** Open a folder tab (right panel FolderViewer; display-only, does not affect cwd) */
  openFolder?: (folderPath: string, folderName: string, options?: OpenFolderOptions) => void | Promise<void>;
  /** Reveal a directory in the sidebar file tree */
  revealDir?: (absPath: string) => void | Promise<void>;
  /** Currently open tabs ({ id, filePath, kind, pinned }, array order = open order; read-only primitive, no policy). */
  getFileTabs?: () => { id: string; filePath: string; kind?: "file" | "folder" | "dock" | "agent"; pinned?: boolean }[];
  /** Close tabs by id (primitive: only removes from state + reorders activation; dirty-confirm/pinning policies are the caller's responsibility) */
  closeFileTabs?: (ids: string[]) => void;
  /** Append text to the composer (does not send; used for quote-reply prefill) */
  appendText?: (text: string) => void | Promise<void>;
  /** Programmatic value write (composer contract controlled path: state → DOM sync effect, tracker in sync) */
  writeComposerValue?: (text: string) => boolean | Promise<boolean>;
  /** Fully restore a draft into the composer (text + images, raw without hooks — same as core's first-message restore).
   *  Returns whether a restore actually happened (false when the composer is not mounted — the caller must not consume the draft). */
  restoreComposerDraft?: (draft: { value: string; images: { data: string; mimeType: string }[] }) => boolean | Promise<boolean>;
}

const hostApi: HostApi = {};

/** AppShell registration (one call in the component body, as-is functions only). */
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
