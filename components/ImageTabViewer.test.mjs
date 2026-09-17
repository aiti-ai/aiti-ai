import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ImageTabViewer.tsx", import.meta.url), "utf8");
const loaderSource = await readFile(new URL("./ext-client-loader.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const storeSource = await readFile(new URL("../lib/ext-ui-store.ts", import.meta.url), "utf8");

test("takes over via the imageViewer slot (fileViewer-style match jumper)", () => {
  // 跳板：store 订阅（服务端稳定空快照）+ 交互时刻物化（声明了 imageViewer 的懒扩展）
  assert.match(source, /useSyncExternalStore\(\s*subscribeExtUi,\s*\(\) => getExtUiItems\("imageViewer"\),\s*\(\) => IMAGE_VIEWER_NO_ITEMS,/);
  assert.match(source, /void ensureExtSlotMaterialized\("imageViewer"\)/);
  // 接管判定：meta.match(src, { alt })，带 render 的注册项才参与（静态声明项跳过）
  assert.match(source, /const match = item\.meta\?\.match;\s*return typeof match === "function" && match\(src, \{ alt \}\);/);
  // 接管渲染：ExtItemBoundary 包裹（扩展渲染异常不炸 tab）+ 相对定位容器（查看器 absolute inset:0）
  assert.match(source, /<ExtItemBoundary extId=\{takeover\.extId\} slot="imageViewer" itemId=\{takeover\.id\}>/);
  assert.match(source, /position: "relative", overflow: "hidden"/);
});

test("keeps the core fallback preview (no takeover → fit + download, zero regression)", () => {
  // 未接管时核心简版：棋盘格 + 自然尺寸 + 下载（原行为）
  assert.match(source, /guessExtension\(src\)/);
  assert.match(source, /download=\{alt\?\.includes\("\."\) \? alt : `image\.\$\{ext\}`\}/);
  assert.match(source, /backgroundImage:/);
  // 空 src 兜底（接管判定的 match 收到空 src 时接管方自保；核心路径保持原样）
  assert.match(source, /files\.imageTabEmpty/);
});

test("imageViewer is an interactive lazy-load slot (declare → materialize on tab open)", () => {
  assert.match(loaderSource, /INTERACTIVE_SLOTS: ReadonlySet<string> = new Set\(\[[\s\S]*?"imageViewer"/);
});

test("slot contract is declared (ExtSlotName + ExtUiDefinition + match signature)", () => {
  assert.match(typesSource, /\| "imageViewer"/);
  assert.match(typesSource, /imageViewer\?: ExtUiItem\[\]/);
  // match 复用 fileViewer 判定签名泛化：subject 由插槽决定（文件路径 / 图片 src）
  assert.match(storeSource, /match\?: \(subject: string, opts: \{ cwd\?: string; kind\?: "file" \| "folder"; alt\?: string \}\) => boolean;/);
});
