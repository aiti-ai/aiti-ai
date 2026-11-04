/**
 * arbiter tests — 多编辑器仲裁纯函数（排序 / 能力联动 / capabilities 规整）。
 *
 * Run: node --test pi-web-ext/aiti-editor/client/src/arbiter.test.mjs
 * （node 24 原生 TS strip-types，直接 import 邻近 .ts）
 */
import assert from "node:assert/strict";
import test from "node:test";

const {
  extOf,
  normalizeCapabilities,
  hasCapability,
  defaultCapabilityOf,
  sortChain,
  pickForCapability,
  capabilityBadge,
  shouldTakeover,
  resolveFenceChain,
} = await import("./arbiter.ts");

const P = (id, extra = {}) => ({ id, ...extra });

test("extOf：扩展名小写化、无扩展名/点文件返回空", () => {
  assert.equal(extOf("/a/b/Report.DOCX"), ".docx");
  assert.equal(extOf("/a/b/x.tar.gz"), ".gz");
  assert.equal(extOf("/a/b/Makefile"), "");
  assert.equal(extOf("/a/b/.gitignore"), "");
});

test("normalizeCapabilities：显式声明优先，缺省按 supportsEdit 推导（向后兼容）", () => {
  assert.deepEqual(normalizeCapabilities(P("a", { capabilities: ["edit"] })), ["edit"]);
  assert.deepEqual(normalizeCapabilities(P("a", { capabilities: ["preview", "edit"] })), ["preview", "edit"]);
  // 旧注册无 capabilities：supportsEdit:false → preview-only
  assert.deepEqual(normalizeCapabilities(P("a", { supportsEdit: false })), ["preview"]);
  // 旧注册无 capabilities 且无 supportsEdit → 双能力（文本编辑器语义）
  assert.deepEqual(normalizeCapabilities(P("a")), ["preview", "edit"]);
  // 非法值过滤
  assert.deepEqual(normalizeCapabilities(P("a", { capabilities: ["edit", "bogus"] })), ["edit"]);
});

test("hasCapability / defaultCapabilityOf", () => {
  const previewOnly = P("p", { capabilities: ["preview"] });
  const both = P("b", { capabilities: ["preview", "edit"], defaultCapability: "edit" });
  assert.equal(hasCapability(previewOnly, "edit"), false);
  assert.equal(hasCapability(both, "edit"), true);
  // defaultCapability 未声明或不在 capabilities 里 → preview 兜底
  assert.equal(defaultCapabilityOf(both), "edit");
  assert.equal(defaultCapabilityOf(previewOnly), "preview");
  assert.equal(defaultCapabilityOf(P("x", { capabilities: ["preview"], defaultCapability: "edit" })), "preview");
});

test("sortChain：偏好 > priority > 注册顺序（稳定）", () => {
  const chain = [
    P("t1"),                                      // default，注册序 1
    P("t2", { priority: "preferred" }),           // preferred
    P("t3", { priority: "override" }),            // override
    P("t4"),                                      // default，注册序 4
  ];
  // 无偏好：override > preferred > default（default 按注册序）
  assert.deepEqual(sortChain(chain, {}, ".docx").map((p) => p.id), ["t3", "t2", "t1", "t4"]);
  // 有偏好：偏好项恒第一（即使是 default）
  assert.deepEqual(sortChain(chain, { ".docx": "t4" }, ".docx").map((p) => p.id), ["t4", "t3", "t2", "t1"]);
  // 偏好是 override 项：仍第一，其余相对次序不变
  assert.deepEqual(sortChain(chain, { ".docx": "t3" }, ".docx").map((p) => p.id), ["t3", "t2", "t1", "t4"]);
  // 偏好指向别的扩展名：不生效
  assert.deepEqual(sortChain(chain, { ".xlsx": "t1" }, ".docx").map((p) => p.id), ["t3", "t2", "t1", "t4"]);
  // 空偏好对象 / 空扩展名安全
  assert.equal(sortChain([], { ".x": "t1" }, ".x").length, 0);
});

test("pickForCapability：能力联动——当前无能力 → 队列下一个具备者；全无 → null", () => {
  const previewOnly = P("preview", { capabilities: ["preview"] });
  const both = P("both", { capabilities: ["preview", "edit"] });
  const editOnly = P("edit", { capabilities: ["edit"] });
  const chain = [previewOnly, both, editOnly];

  // 当前（队列首）无 edit → 联动到 both
  assert.equal(pickForCapability(chain, "edit")?.id, "both");
  // 首个具备者即返回（不跳到更后面的 editOnly）
  assert.equal(pickForCapability(chain, "preview")?.id, "preview");

  // 全队列无 edit → null（编辑按钮禁用）
  assert.equal(pickForCapability([previewOnly], "edit"), null);
  // 空队列安全
  assert.equal(pickForCapability([], "preview"), null);
});

test("capabilityBadge：菜单能力标注", () => {
  assert.equal(capabilityBadge(P("a", { capabilities: ["preview"] })), "👁");
  assert.equal(capabilityBadge(P("a", { capabilities: ["edit"] })), "✏️");
  assert.equal(capabilityBadge(P("a", { capabilities: ["preview", "edit"] })), "👁✏️");
});

test("shouldTakeover：命中队列非空即接管，supportsEdit:false（preview-only）不排斥接管", () => {
  // 回归钉死（2026-09-06）：M0 曾按 supportsEdit!==false 判定，text provider 退出非文本
  // 队列后媒体链首变 preview-only → 视频/音频/图片/PDF 整体跌回核心旧查看器
  const media = { chainLength: 1, isText: false, isViewableBinary: true };
  assert.equal(shouldTakeover(media), true, "mp4/mp3/png/pdf：链首 preview-only provider → 接管");
  // 文本：text provider 恒在链上（§1.2 只排除非文本），接管
  assert.equal(shouldTakeover({ chainLength: 1, isText: true, isViewableBinary: false }), true);
  // 第三方 render 型 provider（docx/xlsx 等）：链非空即接管
  assert.equal(shouldTakeover({ chainLength: 2, isText: false, isViewableBinary: false }), true);
  // 无 provider 命中：文本兑底接管；不可渲染非文本（exe 等）回退核心
  assert.equal(shouldTakeover({ chainLength: 0, isText: true, isViewableBinary: false }), true);
  assert.equal(shouldTakeover({ chainLength: 0, isText: false, isViewableBinary: false }), false);
  assert.equal(shouldTakeover({ chainLength: 0, isText: false, isViewableBinary: true }), true);
});

test("resolveFenceChain：围栏渲染器裁决（priority > 注册序；平局先注册者赢）", () => {
  const R = (id, lang, extra = {}) => ({ id, lang, ...extra });
  const all = [
    R("builtin", "mermaid"), // 内置：default + 先注册
    R("ext-a", "mermaid", { priority: "default" }),
    R("ext-b", "mermaid", { priority: "preferred" }),
    R("ext-c", "math", { priority: "override" }),
  ];
  // 只收命中 lang 的项；preferred 提首，其余按注册序（平局内置赢）
  assert.deepEqual(resolveFenceChain(all, "mermaid").map((r) => r.id), ["ext-b", "builtin", "ext-a"]);
  // 全是 default ⇒ 注册序即生效序（外部扩展不声明优先级就拿不走内置）
  assert.deepEqual(
    resolveFenceChain([R("builtin", "mermaid"), R("ext", "mermaid")], "mermaid").map((r) => r.id),
    ["builtin", "ext"],
  );
  // override 也参与同序裁决
  assert.deepEqual(
    resolveFenceChain([R("builtin", "mermaid"), R("ext", "mermaid", { priority: "override" })], "mermaid").map((r) => r.id),
    ["ext", "builtin"],
  );
  assert.deepEqual(resolveFenceChain(all, "math").map((r) => r.id), ["ext-c"]);
  assert.deepEqual(resolveFenceChain(all, "vega"), []); // 无注册 → 空队列（壳保持普通代码块）
  assert.deepEqual(resolveFenceChain(all, ""), []);
  assert.deepEqual(resolveFenceChain([], "mermaid"), []);
  assert.deepEqual(resolveFenceChain(null, "mermaid"), []);
  assert.deepEqual(resolveFenceChain([null, R("builtin", "mermaid")], "mermaid").map((r) => r.id), ["builtin"]);
  // 无用户偏好维度：prefs 不参与（围栏粒度不进偏好 UI）
  assert.deepEqual(resolveFenceChain(all, "mermaid")[0].id, "ext-b");
});
