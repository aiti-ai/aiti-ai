/**
 * demo · newSessionWidgets 示例小组件测试（方案 docs/pi-web-new-session-widgets-plan.md）。
 *
 * demo 是 JSX 写法样板（entry.tsx TSX + vite 构建），分三面验证：
 *   1. 渲染行为——client/src/new-session-widget.tsx 经 esbuild 打包（react/jsx-runtime
 *      alias 到纯记录器 stub，产出可遍历的普通对象树），断言 extra 数据流
 *      {cwd,isMobile,area}（~ 缩写 / area 透传 / null 降级 / 非 home 路径原样）；
 *   2. manifest/client 一致性——index.ts 静态声明 id ↔ entry.tsx 运行时注册 id 对齐
 *      （两段式对齐陷阱，docs/aiti-ext-lazy-loading-plan.md §5.5-4）+ meta 完整性；
 *   3. dist 新鲜度——已构建 bundle 含 widget 注册（缺失跳过，fresh clone 未构建）。
 *
 * demo/index.ts 顶层混用 require（jiti 宿主语义），node strip-types 直读不了——
 * 一致性面用源码正则（声明格式由宿主 registry schema 保证，这里只钉 id 对齐）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "../_shared/esbuild-bin.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

// ── 1. 渲染行为（esbuild 打包 TSX + jsx-runtime 记录器 stub）──

/** jsx 自动运行时的纯记录器：{type, props}，children 在 props.children（数组或单值）。 */
const stubRuntime = `
export function jsx(type, props) { return { type, props }; }
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol("Fragment");
`;

async function bundleWidget() {
  const tmp = mkdtempSync(join(tmpdir(), "demo-widget-test-"));
  const stubPath = join(tmp, "jsx-stub.mjs");
  const outPath = join(tmp, "widget-bundle.mjs");
  writeFileSync(stubPath, stubRuntime);
  const esbuildBin = join(repoRoot, "node_modules", "esbuild", "bin", "esbuild");
  await runEsbuild(esbuildBin, [
    join(here, "client", "src", "new-session-widget.tsx"),
    "--bundle",
    "--format=esm",
    "--jsx=automatic",
    `--alias:react/jsx-runtime=${stubPath}`,
    `--outfile=${outPath}`,
  ], { cwd: repoRoot });
  return { outPath, tmp };
}

const { outPath: widgetBundlePath, tmp: bundleTmp } = await bundleWidget();
const { WidgetDemoCard } = await import(pathToFileURL(widgetBundlePath).href);

/** 深度收集 JSX 记录树里的全部文本（props.children 数组或单值；字符串/数字直收）。 */
function collectText(node) {
  const out = [];
  const walk = (n) => {
    if (n == null || n === false || n === true) return;
    if (typeof n === "string" || typeof n === "number") {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "object") walk(n.props?.children);
  };
  walk(node);
  return out.join("");
}

test("render: extra 数据流——cwd ~ 缩写 + area 透传", () => {
  const text = collectText(WidgetDemoCard({ cwd: "/home/pi/workspace/aiti-ai", isMobile: false, area: "top" }));
  assert.ok(text.includes("示例小组件（demo）"), `标题缺失: ${text}`);
  assert.ok(text.includes("area=top"), `area 缺失: ${text}`);
  assert.ok(text.includes("cwd=~/workspace/aiti-ai"), `cwd 应缩写为 ~: ${text}`);
  assert.ok(!text.includes("/home/pi"), "home 前缀不应明文出现");
});

test("render: cwd=null 降级显示 —；非 /home 路径原样；isMobile 两态不炸", () => {
  assert.ok(collectText(WidgetDemoCard({ cwd: null, isMobile: true, area: "bottom" })).includes("cwd=—"));
  assert.ok(collectText(WidgetDemoCard({ cwd: "C:/repo", isMobile: true, area: "bottom" })).includes("cwd=C:/repo"));
  assert.ok(collectText(WidgetDemoCard({ cwd: "/opt/data", isMobile: false, area: "top" })).includes("cwd=/opt/data"));
  assert.doesNotThrow(() => WidgetDemoCard({ cwd: "/tmp", isMobile: true, area: "top" }));
  assert.doesNotThrow(() => WidgetDemoCard({ cwd: undefined, isMobile: false, area: "bottom" }));
});

test("render: 外层卡片有边框容器（栅格格子内自绘外观的样板形态）", () => {
  const el = WidgetDemoCard({ cwd: "/tmp", isMobile: false, area: "top" });
  assert.equal(el.type, "div");
  assert.ok(el.props.style, "顶层应有 style（卡片外观）");
});

// ── 2. manifest / client 一致性（源码正则；id 对齐是两段式的头号陷阱）──

const indexSrc = readFileSync(join(here, "index.ts"), "utf8");
const entrySrc = readFileSync(join(here, "client", "src", "entry.tsx"), "utf8");
const widgetSrc = readFileSync(join(here, "client", "src", "new-session-widget.tsx"), "utf8");

test("consistency: index.ts 静态声明 newSessionWidgets 且 id 与 entry.tsx 注册对齐", () => {
  const declared = indexSrc.match(/newSessionWidgets:\s*\[\s*\{\s*id:\s*"([^"]+)"/);
  assert.ok(declared, "index.ts ui 应声明 newSessionWidgets 静态条目");
  const registered = entrySrc.match(/registerItems\?\.\(\s*"newSessionWidgets",\s*\[\s*\{\s*id:\s*"([^"]+)"/);
  assert.ok(registered, "entry.tsx 应运行时注册 newSessionWidgets（带 render）");
  assert.equal(declared[1], registered[1], "静态声明与运行时注册 id 必须一致");
});

test("consistency: entry.tsx 注册 meta 完整（areas both / defaultArea bottom / 4×1 / title）", () => {
  const block = entrySrc.match(/registerItems\?\.\(\s*"newSessionWidgets"([\s\S]*?)\]\);/);
  assert.ok(block, "newSessionWidgets 注册块存在");
  const meta = block[1];
  assert.ok(meta, "注册条目必须带 meta");
  assert.ok(/areas:\s*\[\s*"top",\s*"bottom"\s*\]/.test(meta), "areas 应为 both");
  assert.ok(/defaultArea:\s*"bottom"/.test(meta), "defaultArea 应为 bottom");
  assert.ok(/w:\s*4/.test(meta) && /h:\s*1/.test(meta), "尺寸应为 4×1");
  assert.ok(/title:\s*"示例小组件"/.test(meta), "应有 title（自定义面板显示名）");
  assert.ok(/render:\s*WidgetDemoCard/.test(meta), "运行时注册必须带 render");
});

test("consistency: entry.tsx 引入的组件与 new-session-widget.tsx 导出对齐", () => {
  const imported = entrySrc.match(/import\s*\{\s*(\w+)\s*\}\s*from\s*"\.\/new-session-widget"/);
  assert.ok(imported, "entry.tsx 应从 ./new-session-widget 引入组件");
  assert.match(widgetSrc, new RegExp(`export function ${imported[1]}`), "组件必须导出");
});

// ── 3. dist 新鲜度（存在才校验；fresh clone 未构建时跳过）──

const distCandidates = [
  join(here, "dist", "demo-jsx.mjs"),
  join(here, "client", "demo-jsx.mjs"),
];
const distPath = distCandidates.find(existsSync);
test("dist bundle 含 widget 注册（存在才校验）", { skip: !distPath ? "dist 未构建" : false }, () => {
  const src = readFileSync(distPath, "utf8");
  assert.ok(src.includes("newSessionWidgets"), "已构建 bundle 应包含 newSessionWidgets 注册（构建过期？npm run build:client）");
  assert.ok(src.includes("示例小组件"), "已构建 bundle 应包含 widget 文案");
});

test("清理临时打包目录", () => {
  rmSync(bundleTmp, { recursive: true, force: true });
});
