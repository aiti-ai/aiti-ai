/**
 * new-session-cwd 共享判定单测（node --test；纯函数，--experimental-strip-types 直跑）。
 *
 * 方案：docs/pi-web-at-new-session-cwd-plan.md（v1）+ docs/pi-web-at-new-session-cwd-v2-plan.md（v2）
 * 覆盖（v2 语义）：pathCovers / stripCommonDirs / longestCovering / resolveNewSessionCwd 四档判定
 *   （保持 / 关注目录切走(repoRoot 优先、嵌套取最深) / 已知 workspace 最长匹配 / 常规目录剥离 /
 *    无 cwd 归一化）/ resolveNewSessionCwdClient 快路径短路 + sessions 派生 + git-trace 端点复核 +
 *    失败降级 / buildAtText / openNewSession / openNewSessionWithExtSvc 服务优先与降级。
 * 注意：fetchKnownWorkspaces 有模块级 TTL 缓存（60s），依赖它的用例开头必须 _resetWsCacheForTest()。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pathCovers, normDir, stripCommonDirs, longestCovering, DEFAULT_EXCLUDE_DIR_NAMES,
  resolveNewSessionCwd, resolveNewSessionCwdClient, buildAtText, openNewSession, openNewSessionWithExtSvc,
  _resetWsCacheForTest,
} from "./new-session-cwd.ts";

test("pathCovers：相等 / 互为前缀 / 无关", () => {
  assert.ok(pathCovers("/a/b", "/a/b"));
  assert.ok(pathCovers("/a/b/c", "/a/b"));      // 子目录被父覆盖
  assert.ok(pathCovers("/a/b", "/a/b/c"));      // 父被子覆盖（doc-center 双向 wsCovers 同款）
  assert.ok(!pathCovers("/a/bc", "/a/b"));      // 非前缀边界（b 是 bc 前缀但不是目录边界）
  assert.ok(!pathCovers("/a", "/b"));
  assert.ok(!pathCovers("", "/b"));
  assert.ok(!pathCovers("/a", ""));
});

test("pathCovers：路径归一（尾斜杠 / win 反斜杠）", () => {
  assert.ok(pathCovers("/a/b/", "/a/b"));
  assert.ok(pathCovers("D:\\workspace\\proj", "D:/workspace/proj/src"));
  assert.ok(pathCovers("D:/workspace/proj/src", "D:\\workspace\\proj"));
});

test("DEFAULT_EXCLUDE_DIR_NAMES：v2 用户拍板清单", () => {
  assert.deepEqual(DEFAULT_EXCLUDE_DIR_NAMES, ["docs", "doc", "tmp", "temp", "design", "designs"]);
});

test("stripCommonDirs：单层常规目录剥离 / 多重 / 大小写 / 非常规不动 / win 反斜杠", () => {
  assert.equal(stripCommonDirs("/home/w/proj/docs"), "/home/w/proj");
  assert.equal(stripCommonDirs("/home/w/proj/docs/design"), "/home/w/proj"); // 连续剥两层
  assert.equal(stripCommonDirs("/home/w/proj/Design"), "/home/w/proj");      // 大小写不敏感
  assert.equal(stripCommonDirs("/home/w/proj/src"), "/home/w/proj/src");     // 非常规名不动
  assert.equal(stripCommonDirs("D:\\workspace\\proj\\tmp"), "D:/workspace/proj");
  assert.equal(stripCommonDirs("/home/w/proj"), "/home/w/proj");
});

test("longestCovering：最长（最深）覆盖 / 不选目标的子目录 / 空候选", () => {
  const cands = ["/home/w", "/home/w/proj", "/home/w/other"];
  assert.equal(longestCovering("/home/w/proj/src/x.ts", cands), "/home/w/proj");
  assert.equal(longestCovering("/home/w/proj", cands), "/home/w/proj");       // 相等命中
  assert.equal(longestCovering("/home/w/other/a", cands), "/home/w/other");
  // 候选是目标的子目录（如 workspace 候选是 proj 内部的 src）→ 不得选（coversDir 单向）
  assert.equal(longestCovering("/home/w/proj", ["/home/w/proj/src"]), null);
  assert.equal(longestCovering("/x/y/z.ts", []), null);
  assert.equal(longestCovering("/x/y/z.ts", ["", null, undefined]), null);
});

test("resolveNewSessionCwd：目标在当前 CWD 内 → 保持", () => {
  const r = resolveNewSessionCwd({ targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web" });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd：当前 CWD 在目标内（目标=父层）→ 保持", () => {
  const r = resolveNewSessionCwd({ targetDir: "/home/w", currentCwd: "/home/w/pi-web" });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd v2：目标在关注路径内 → 切到关注路径（不再保持）", () => {
  // 当前 cwd 在 A 仓，目标在 B 仓——B 是 A 的 watchPaths（git-trace 配置的跨仓关注）→ 切到 B
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj/src", targetPath: "/home/w/other-proj/src/x.ts",
    currentCwd: "/home/w/pi-web",
    watchPaths: ["/home/w/other-proj"],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2：关注路径 {path,repoRoot} 对象 → repoRoot 优先", () => {
  // 用户关注的 path 是仓库子目录 → 命中时用 repoRoot（仓库根更符合 workspace 概念）
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj/packages/core",
    targetPath: "/home/w/other-proj/packages/core/README.md",
    currentCwd: "/home/w/pi-web",
    watchPaths: [{ path: "/home/w/other-proj/packages/core", repoRoot: "/home/w/other-proj" }],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2：关注路径嵌套取最深", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/mono/apps/foo",
    targetPath: "/home/w/mono/apps/foo/x.ts",
    currentCwd: "/home/w/pi-web",
    watchPaths: ["/home/w/mono", { path: "/home/w/mono/apps/foo", repoRoot: "/home/w/mono/apps/foo" }],
  });
  assert.equal(r.cwd, "/home/w/mono/apps/foo"); // 更深命中优先
});

test("resolveNewSessionCwd v2：关注路径配置在目标子层（目标目录是其父）→ 切到关注路径", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj",
    targetPath: "/home/w/other-proj",
    currentCwd: "/home/w/pi-web",
    watchPaths: [{ path: "/home/w/other-proj/src", repoRoot: "/home/w/other-proj" }],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2：已知 workspace 覆盖 → 最长匹配", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/x.ts",
    currentCwd: "/home/w/pi-work",
    knownWorkspaces: ["/home/w", "/home/w/pi-web", "/home/w/other"],
  });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2：常规目录剥离（无 workspace 命中）", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/proj/docs", targetPath: "/home/w/proj/docs/guide.md",
    currentCwd: "/home/w/other",
    knownWorkspaces: ["/home/w/other", "/home/w/unrelated"],
  });
  assert.equal(r.cwd, "/home/w/proj"); // docs 剥掉，proj 不在已知 workspace → 用剥离结果
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2：剥离后命中 workspace → 用 workspace", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "/home/w/pi-work",
    knownWorkspaces: ["/home/w/pi-work", "/home/w/pi-web"],
  });
  assert.equal(r.cwd, "/home/w/pi-web"); // 剥 docs 后 /home/w/pi-web 命中已知 workspace
});

test("resolveNewSessionCwd v2：无 CWD → 已知 workspace 命中（不落深目录，修 v1 bug）", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "",
    knownWorkspaces: ["/home/w/pi-web"],
  });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false); // 无当前 cwd → 恒 false
});

test("resolveNewSessionCwd v2：无 CWD → 关注目录命中", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj/src", targetPath: "/home/w/other-proj/src/x.ts",
    currentCwd: "",
    watchPaths: [{ path: "/home/w/other-proj", repoRoot: "/home/w/other-proj" }],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd v2：无 CWD 且无候选 → 剥离常规目录后的目录", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/proj/tmp", targetPath: "/home/w/proj/tmp/x.log",
    currentCwd: null,
  });
  assert.equal(r.cwd, "/home/w/proj");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd：目标属于其它工作区且无关注/已知 → 切走（剥离后）", () => {
  const r = resolveNewSessionCwd({ targetDir: "/home/w/other-proj", currentCwd: "/home/w/pi-web" });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd：空 targetDir/targetPath → 返回当前 cwd", () => {
  const r = resolveNewSessionCwd({ targetDir: "", currentCwd: "/a" });
  assert.equal(r.cwd, "/a");
  assert.equal(r.switched, false);
  const r2 = resolveNewSessionCwd({ targetDir: "", targetPath: "", currentCwd: null });
  assert.equal(r2.cwd, "");
});

test("resolveNewSessionCwd v2：文件在 CWD 内但 targetPath 更深（docs 子目录）→ 保持（不剥）", () => {
  // 当前 CWD = 项目根，文件在项目 docs 子目录 → ① 命中保持（v2 原则：已在 CWD 内不随便切）
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "/home/w/pi-web",
    knownWorkspaces: ["/home/w/pi-web"],
  });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false);
});

// ── client 流程（resolveNewSessionCwdClient）──────────────
test("resolveNewSessionCwdClient：目标在当前 CWD 内 → 快路径短路，不发请求", async () => {
  let called = 0;
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts",
    currentCwd: "/home/w/pi-web",
    apiUrl: () => { called++; return "http://x/ext"; },
    fetchFn: (async () => { throw new Error("不应发起请求"); })
  });
  assert.equal(cwd, "/home/w/pi-web");
  assert.equal(called, 0);
});

test("resolveNewSessionCwdClient：切走时拉 sessions 派生 + 端点复核（关注命中 → 切关注目录）", async () => {
  _resetWsCacheForTest();
  const calls = [];
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/other-proj/src", targetPath: "/home/w/other-proj/src/x.ts",
    currentCwd: "/home/w/pi-web",
    apiUrl: (p) => { calls.push(p); return "http://host" + p; },
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) {
        return { ok: true, json: async () => ({ sessions: [{ cwd: "/home/w/pi-web" }, { projectRoot: "/home/w/other-proj" }] }) };
      }
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/other-proj", switched: true }) };
    })
  });
  assert.equal(cwd, "/home/w/other-proj");
  // sessions 先（派生已知列表）→ 端点后
  assert.deepEqual(calls, ["/api/sessions", "/api/extensions/aiti-git-trace/new-session-cwd"]);
});

test("resolveNewSessionCwdClient：端点复核命中切走 → 用端点结果", async () => {
  _resetWsCacheForTest();
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/other-proj",
    currentCwd: "/home/w/pi-web",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/other-proj", switched: true }) };
    })
  });
  assert.equal(cwd, "/home/w/other-proj");
});

test("resolveNewSessionCwdClient：端点失败/缺席 → 本地判定兜底（已知列表在手）", async () => {
  _resetWsCacheForTest();
  // git-trace 端点 fetch 抛异常（未装/404）→ 兜底 = 本地 resolveNewSessionCwd（knownWorkspaces 已从 sessions 派生）
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "/home/w/pi-work",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [{ cwd: "/home/w/pi-web" }] }) };
      throw new Error("network");
    })
  });
  assert.equal(cwd, "/home/w/pi-web"); // 端点缺席 → 已知 workspace 命中，不落 docs 子目录
});

test("resolveNewSessionCwdClient：端点返回非 ok → 兜底", async () => {
  _resetWsCacheForTest();
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/other-proj",
    currentCwd: "/home/w/pi-web",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({ ok: false, error: "缺少 targetDir" }) };
    })
  });
  assert.equal(cwd, "/home/w/other-proj");
});

test("resolveNewSessionCwdClient：无 cwd → 不短路，sessions 命中归一化 workspace", async () => {
  _resetWsCacheForTest();
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [{ projectRoot: "/home/w/pi-web" }] }) };
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/pi-web", switched: false }) };
    })
  });
  assert.equal(cwd, "/home/w/pi-web");
});

test("resolveNewSessionCwdClient：sessions 拉取失败 → 降级 []，本地判定仍工作", async () => {
  _resetWsCacheForTest();
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/proj/tmp", targetPath: "/home/w/proj/tmp/x.log",
    currentCwd: "/home/w/other",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) throw new Error("sessions 挂了");
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/proj", switched: true }) };
    })
  });
  assert.equal(cwd, "/home/w/proj"); // 端点结果优先；sessions 缺席不影响主流程
});

test("buildAtText：与宿主 buildAtMentionText 同格式（空格加引号、目录尾斜杠）", () => {
  assert.equal(buildAtText("docs/a.md"), "@docs/a.md ");
  assert.equal(buildAtText("my docs/a.md"), '@"my docs/a.md" ');
  assert.equal(buildAtText("proj", true), "@proj/ ");
  assert.equal(buildAtText("my proj", true), '@"my proj/" ');
  assert.equal(buildAtText("proj/", true), "@proj/ "); // 尾斜杠归一
  assert.equal(buildAtText("D:/workspace/a b.md"), '@"D:/workspace/a b.md" ');
});

test("openNewSession：pendingComposer + CWD 判定 + 派发（dispatch 注入；node 无 window）", async () => {
  _resetWsCacheForTest();
  const win = {};
  const events = [];
  await openNewSession({
    text: "@docs/a.md ", targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web",
    apiUrl: () => "http://x",
    fetchFn: (async () => { throw new Error("不应发起请求（containment 保持）"); }),
    dispatch: (evt) => events.push(evt),
    windowRef: win,
  });
  assert.ok(win.__piWebPendingComposer);
  assert.equal(win.__piWebPendingComposer.text, "@docs/a.md ");
  assert.ok(win.__piWebPendingComposer.at > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "pi-web:new-session");
  assert.equal(events[0].detail.cwd, "/home/w/pi-web"); // 保持当前
});

test("openNewSession：切走路径（sessions + git-trace 端点复核后切到目标）", async () => {
  _resetWsCacheForTest();
  const events = [];
  await openNewSession({
    text: "@/home/w/other ", targetDir: "/home/w/other", targetPath: "/home/w/other/x.ts", currentCwd: "/home/w/pi-web",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/other", switched: true }) };
    }),
    dispatch: (evt) => events.push(evt),
    windowRef: {},
  });
  assert.equal(events[0].detail.cwd, "/home/w/other");
});

test("openNewSessionWithExtSvc：session-manager.mention 服务优先（targetPath 透传）", async () => {
  let svcCalled = 0;
  const svc = {
    openNewSession: async (_t, o) => { svcCalled++; assert.equal(o.targetDir, "/home/w/pi-web/lib"); assert.equal(o.targetPath, "/home/w/pi-web/lib/a.ts"); assert.equal(o.currentCwd, "/home/w/pi-web"); },
  };
  await openNewSessionWithExtSvc({
    text: "@docs/a.md ", targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web",
    apiUrl: () => "http://x",
    extSvc: (k) => (k === "session-manager.mention" ? svc : undefined),
  });
  assert.equal(svcCalled, 1);
});

test("openNewSessionWithExtSvc：服务缺席 → 降级 _shared 同源实现", async () => {
  _resetWsCacheForTest();
  let fetchCalled = 0;
  const events = [];
  await openNewSessionWithExtSvc({
    text: "@docs/a.md ", targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web",
    apiUrl: () => "http://x",
    extSvc: () => undefined, // session-manager 缺席
    fetchFn: (async () => { fetchCalled++; throw new Error("不应有请求（containment 保持）"); }),
    dispatch: (evt) => events.push(evt),
    windowRef: {},
  });
  assert.equal(fetchCalled, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.cwd, "/home/w/pi-web"); // 降级路径行为与共享实现一致
});

test("openNewSessionWithExtSvc：无 extSvc 注入 → 直接降级（切走全链路）", async () => {
  _resetWsCacheForTest();
  const events = [];
  await openNewSessionWithExtSvc({
    text: "@/home/w/other ", targetDir: "/home/w/other", targetPath: "/home/w/other/x.ts", currentCwd: "/home/w/pi-web",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/other", switched: true }) };
    }),
    dispatch: (evt) => events.push(evt),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.cwd, "/home/w/other");
});
