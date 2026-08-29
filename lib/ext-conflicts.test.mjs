/**
 * ext-conflicts —— 通用「冲突插件」禁用机制测试。
 *
 * 语义：扩展清单声明 conflicts（npm 包名标识），组装 SDK 扩展加载结果时
 * 命中标识的扩展整个移除（不初始化）；scoped 包名（@scope/name）与裸名
 * （name）是不同包名，互不误伤。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { disableConflictingExtensions, sourcePackageName, pathScopedPackageName } from "./ext-conflicts.ts";

function fakeExt(path, source, tools = ["subagent"]) {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source, scope: "user", origin: "package", baseDir: "/x" },
    handlers: new Map(),
    tools: new Map(tools.map((name) => [name, { name }])),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

function fakeRegistry(...conflictLists) {
  return { all: () => conflictLists.map((conflicts) => ({ ext: { conflicts } })) };
}

const VANILLA = "/x/node_modules/pi-subagents/index.ts";
const FORK = "/x/node_modules/@aiti-ai/pi-subagents/index.ts";
const OTHER = "/y/other-pkg/index.ts";

test("sourcePackageName：裸名/scoped/版本/协议解析", () => {
  assert.equal(sourcePackageName("npm:pi-subagents"), "pi-subagents");
  assert.equal(sourcePackageName("npm:pi-subagents@0.58.0"), "pi-subagents");
  assert.equal(sourcePackageName("npm:@aiti-ai/pi-subagents@0.58.0-aiti.6"), "@aiti-ai/pi-subagents");
  assert.equal(sourcePackageName("git:github.com/user/repo"), "github.com/user/repo");
  assert.equal(sourcePackageName(""), "");
});

test("pathScopedPackageName：路径 scoped 包名", () => {
  assert.equal(pathScopedPackageName("/x/node_modules/@aiti-ai/pi-subagents/index.ts"), "@aiti-ai/pi-subagents");
  assert.equal(pathScopedPackageName("/x/node_modules/pi-subagents/index.ts"), null);
});

test("声明 conflicts → 原版包整个移除（不初始化）", () => {
  const base = {
    extensions: [fakeExt(VANILLA, "npm:pi-subagents"), fakeExt(OTHER, "npm:other-pkg", ["read"])],
    errors: [],
    runtime: {},
  };
  const out = disableConflictingExtensions(base, fakeRegistry(["pi-subagents"]));
  assert.equal(out.extensions.length, 1);
  assert.equal(out.extensions[0].sourceInfo.source, "npm:other-pkg");
});

test("scoped fork（@aiti-ai/pi-subagents）不被裸名标识误伤", () => {
  const base = {
    extensions: [
      fakeExt(VANILLA, "npm:pi-subagents"),
      fakeExt(FORK, "npm:@aiti-ai/pi-subagents@0.58.0-aiti.6"),
    ],
    errors: [],
    runtime: {},
  };
  const out = disableConflictingExtensions(base, fakeRegistry(["pi-subagents"]));
  const paths = out.extensions.map((e) => e.path);
  assert.ok(!paths.includes(VANILLA), "原版被禁用");
  assert.ok(paths.includes(FORK), "fork 保留（scoped 包名 ≠ 裸名）");
});

test("路径 scoped 包名也参与匹配（本地 npm 目录布局）", () => {
  const base = {
    extensions: [fakeExt(VANILLA, "")], // 无 source
    errors: [],
    runtime: {},
  };
  // VANILLA 路径无 scoped 段且无 source → 不匹配（保守，不误伤）
  const out = disableConflictingExtensions(base, fakeRegistry(["pi-subagents"]));
  assert.equal(out.extensions.length, 1);
  // scoped 路径场景
  const base2 = {
    extensions: [fakeExt("/x/node_modules/@foo/pi-subagents/index.ts", "")],
    errors: [],
    runtime: {},
  };
  const out2 = disableConflictingExtensions(base2, fakeRegistry(["@foo/pi-subagents"]));
  assert.equal(out2.extensions.length, 0, "scoped 路径命中标识 → 移除");
});

test("无声明/registry 不可用 → 原样返回", () => {
  const base = { extensions: [fakeExt(VANILLA, "npm:pi-subagents")], errors: [], runtime: {} };
  assert.equal(disableConflictingExtensions(base, fakeRegistry()), base.extensions.length === 1 ? base : base);
  assert.equal(disableConflictingExtensions(base, undefined), base);
});

test("多个声明者去重合并", () => {
  const registry = {
    all: () => [
      { ext: { conflicts: ["pi-subagents"] } },
      { ext: { conflicts: ["pi-subagents", "other-conflicting-pkg"] } },
    ],
  };
  const base = {
    extensions: [fakeExt(VANILLA, "npm:pi-subagents"), fakeExt(OTHER, "npm:other-conflicting-pkg", ["read"])],
    errors: [],
    runtime: {},
  };
  const out = disableConflictingExtensions(base, registry);
  assert.equal(out.extensions.length, 0);
});
