/**
 * aiti-editor · 图片预览（统一查看器 + 图片浮层入口）测试。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-editor/client/src/image-preview.test.mjs
 *
 * 覆盖：
 *  - 纯逻辑：guessImageExt（data URL / URL / 无扩展兜底）、estimateDataUrlBytes（base64 估算）
 *  - 源码契约（字符串级）：触屏 pinch/双击、小屏工具条自适应、消息场景下载按钮、
 *    image-float 浮层（单例 + data-ext-float 契约 + 统一查看器）；entry/index 的
 *    openImagePreview 挂载与 dialogs 注册。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { guessImageExt, estimateDataUrlBytes } = await import("./lib.ts");

const imageViewerSrc = await readFile(new URL("./image-viewer.tsx", import.meta.url), "utf8");
const messageViewerSrc = await readFile(new URL("./image-float.tsx", import.meta.url), "utf8");
const entrySrc = await readFile(new URL("./entry.tsx", import.meta.url), "utf8");
const indexSrc = await readFile(new URL("../../index.ts", import.meta.url), "utf8");

test("guessImageExt：data URL mime → 扩展名", () => {
  assert.equal(guessImageExt("data:image/png;base64,iVBORw0KGgo="), "png");
  assert.equal(guessImageExt("data:image/jpeg;base64,/9j/4AAQ"), "jpeg");
  assert.equal(guessImageExt("data:image/svg+xml;base64,PHN2Zz4="), "svg");
  assert.equal(guessImageExt("data:application/octet-stream;base64,AAAA"), "octet-stream");
});

test("guessImageExt：URL 路径尾段（忽略 query/hash；无扩展名 → 空串）", () => {
  assert.equal(guessImageExt("/api/agent/s1/image.png?token=abc"), "png");
  assert.equal(guessImageExt("https://pi.example/dev/api/x/y.JPG#frag"), "jpg");
  assert.equal(guessImageExt("/api/agent/s1/image"), "");
  assert.equal(guessImageExt(""), "");
});

test("estimateDataUrlBytes：base64 载荷字节估算（含 padding）", () => {
  // "AAAA" → 3 字节；"AAA=" → 2 字节；"AA==" → 1 字节；非 base64 → undefined
  assert.equal(estimateDataUrlBytes("data:image/png;base64,AAAA"), 3);
  assert.equal(estimateDataUrlBytes("data:image/png;base64,AAA="), 2);
  assert.equal(estimateDataUrlBytes("data:image/png;base64,AA=="), 1);
  assert.equal(estimateDataUrlBytes("data:image/png;base64,"), 0);
  assert.equal(estimateDataUrlBytes("https://x/y.png"), undefined);
  assert.equal(estimateDataUrlBytes("data:image/svg+xml,%3Csvg%3E"), undefined);
});

test("统一查看器：触屏 pinch（双指集合 + 起始基准求解）与 double-tap", () => {
  // 双指捏合主通道：≥2 指记录基准，move 按「起始状态 × 累计倍率」求解（不逐帧累加）
  assert.match(imageViewerSrc, /pointersRef\.current\.set\(e\.pointerId/);
  assert.match(imageViewerSrc, /pinchRef\.current = \{\s*dist0:/);
  assert.match(imageViewerSrc, /pinch\.scale0 \* \(dist \/ pinch\.dist0\)/);
  assert.match(imageViewerSrc, /setPointerCapture/);
  // 双指 → 单指重建拖拽基准；>2 指保持捏合
  assert.match(imageViewerSrc, /pointersRef\.current\.size === 1/);
  // 触屏 double-tap（多数触屏浏览器不发 dblclick）→ 适应/100% 切换
  assert.match(imageViewerSrc, /e\.pointerType === "touch" && d && !d\.moved/);
  assert.match(imageViewerSrc, /toggleFitOneToOne\(\)/);
});

test("统一查看器：小屏工具条不溢出（换行 + 限宽 + 安全区）+ 消息场景下载按钮", () => {
  assert.match(imageViewerSrc, /flexWrap: "wrap"/);
  assert.match(imageViewerSrc, /maxWidth: "calc\(100% - 16px\)"/);
  assert.match(imageViewerSrc, /env\(safe-area-inset-bottom/);
  // 下载按钮（downloadName 提供时；文件场景在 FileToolbar，不重复）
  assert.match(imageViewerSrc, /downloadName \? \(/);
  assert.match(imageViewerSrc, /download=\{downloadName\}/);
  // data URL 不开新窗口（浏览器禁止顶层导航到 data:），http/票据 URL 才显示 ↗
  assert.match(imageViewerSrc, /!isDataUrl \? tbtn\("↗"/);
});

test("统一查看器：无磁盘路径兼容（displayName/filePath 可选、src 猜扩展）", () => {
  assert.match(imageViewerSrc, /filePath\?: string/);
  assert.match(imageViewerSrc, /displayName\?: string/);
  assert.match(imageViewerSrc, /guessImageExt\(src\)/);
});

test("统一查看器：已完成图加载兜底（complete 探测——首开空白修复）", () => {
  // Chrome 实测：消息 data 图首开 complete=true 且 load 事件不再派发 → loaded 恒 false
  // → opacity:0 全空白（关掉重开才恢复）。src 变化后必须补一次 complete 探测双保险。
  assert.match(imageViewerSrc, /if \(!img \|\| !img\.complete\) return;/);
  assert.match(imageViewerSrc, /if \(img\.naturalWidth\) onLoad\(\);/);
  // complete 且 naturalWidth=0（坏图）→ 与 onError 同语义（onSrcError 可接手自愈）
  assert.match(imageViewerSrc, /else if \(!onSrcError \|\| !onSrcError\(\)\) setLoadErr\(true\);/);
});

test("图片浮层：单例 + data-ext-float 契约（拖拽/小屏全屏/遮罩豁免/ESC）+ 统一查看器", () => {
  assert.match(messageViewerSrc, /import \{ ImageViewer \} from "\.\/image-viewer"/);
  assert.match(messageViewerSrc, /<ImageViewer\b/);
  assert.match(messageViewerSrc, /estimateDataUrlBytes/);
  assert.match(messageViewerSrc, /downloadName/);
  // 单例：模块级 current 替换 + present("float")/useGate 门控
  assert.match(messageViewerSrc, /current = \{ src, alt: options\?\.alt \};/);
  assert.match(messageViewerSrc, /present\(FLOAT_KEY, "float"\)/); // 默认浮窗（present "float"，非 openFloat 的 "open" 语义）
  assert.match(messageViewerSrc, /useGate\(FLOAT_KEY, "float"\)/);
  assert.match(messageViewerSrc, /data-ext-float="1"/);
  assert.match(messageViewerSrc, /data-ext-float-full="1"/);
  // 遮罩豁免：aiti-float neutralizeMasks 默认把祖先链半透明遮罩中和成点击穿透
  // （遮罩点击关闭失效）——查看器要模态体验，必须 keepmask
  assert.match(messageViewerSrc, /data-ext-float-keepmask="1"/);
  // 停靠接入（audit-fix §9.1）：面板声明 zones → aiti-float 注入 ⇱；默认浮窗 = 显式 present "float"
  assert.match(messageViewerSrc, /data-ext-float-dock="right-panel"/);
  assert.match(messageViewerSrc, /data-ext-float-dock-default="right-panel"/);
  assert.match(messageViewerSrc, /declareDockZones\(FLOAT_KEY, \["right-panel"\]/);
  assert.match(messageViewerSrc, /presentState\(FLOAT_KEY\)\.startsWith\("docked:"\)/);
  assert.doesNotMatch(messageViewerSrc, /openFloat\(/); // "open" 语义违背默认浮窗（降级层直达停靠）
  assert.match(messageViewerSrc, /present\(FLOAT_KEY, "float"\)/);
  // 关闭即忘：closed 监听清形态偏好，下次打开回落默认浮窗
  assert.match(messageViewerSrc, /piwe-float-present-change/);
  assert.match(messageViewerSrc, /clearDockPref\(FLOAT_KEY\)/);
  // 右栏停靠面：rightFileDock item + DockBody chrome="tab"（页签 ⇱/✕ 宿主承担）
  assert.match(messageViewerSrc, /useGate\(FLOAT_KEY, \{ dock: "right-panel" \}\)/);
  assert.match(messageViewerSrc, /chrome="tab"/);
  // ESC 关闭（window capture，仅开窗期间，不落入宿主全局快捷键）
  assert.match(messageViewerSrc, /e\.key !== "Escape"/);
  assert.match(messageViewerSrc, /addEventListener\("keydown", onKey, true\)/);
});

test("entry 挂 openImagePreview + dialogs 浮层注册 + index 静态声明（imageViewer 已退役）", () => {
  assert.match(entrySrc, /registerItems\?\.\("dialogs"/);
  assert.match(entrySrc, /id: "image-preview"/);
  assert.match(entrySrc, /openImagePreview \}\)/); // __aitiEditor Object.assign
  assert.match(indexSrc, /\{ id: "image-preview", label: "图片预览" \}/);
  // 旧 imageViewer 插槽接管已整体退役（宿主 image tab 机制删除）
  assert.doesNotMatch(entrySrc, /"imageViewer"/);
  assert.doesNotMatch(indexSrc, /imageViewer/);
});
