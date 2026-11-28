/**
 * new-session-cwd shared resolution unit tests (node --test; pure functions, run directly with --experimental-strip-types).
 *
 * Plans: docs/pi-web-at-new-session-cwd-plan.md (v1) + docs/pi-web-at-new-session-cwd-v2-plan.md (v2)
 * Covered (v2 semantics): pathCovers / stripCommonDirs / longestCovering / resolveNewSessionCwd's four decision tiers
 *   (keep / switch to a watched directory (repoRoot first, deepest on nesting) / longest match among known workspaces /
 *    common-directory stripping / normalization without a cwd) / resolveNewSessionCwdClient fast-path short-circuit +
 *    sessions derivation + git-trace endpoint cross-check + failure fallback / buildAtText / openNewSession /
 *    openNewSessionWithExtSvc service-first and fallback.
 * Note: fetchKnownWorkspaces has a module-level TTL cache (60s); cases depending on it must call _resetWsCacheForTest() first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pathCovers, normDir, stripCommonDirs, longestCovering, DEFAULT_EXCLUDE_DIR_NAMES,
  resolveNewSessionCwd, resolveNewSessionCwdClient, buildAtText, openNewSession, openNewSessionWithExtSvc,
  _resetWsCacheForTest,
} from "./new-session-cwd.ts";

test("pathCovers: equal / mutual prefix / unrelated", () => {
  assert.ok(pathCovers("/a/b", "/a/b"));
  assert.ok(pathCovers("/a/b/c", "/a/b"));      // child covered by parent
  assert.ok(pathCovers("/a/b", "/a/b/c"));      // parent covered by child (same as doc-center's two-way wsCovers)
  assert.ok(!pathCovers("/a/bc", "/a/b"));      // non-prefix boundary (b prefixes bc but not at a directory boundary)
  assert.ok(!pathCovers("/a", "/b"));
  assert.ok(!pathCovers("", "/b"));
  assert.ok(!pathCovers("/a", ""));
});

test("pathCovers: path normalization (trailing slash / Windows backslash)", () => {
  assert.ok(pathCovers("/a/b/", "/a/b"));
  assert.ok(pathCovers("D:\\workspace\\proj", "D:/workspace/proj/src"));
  assert.ok(pathCovers("D:/workspace/proj/src", "D:\\workspace\\proj"));
});

test("DEFAULT_EXCLUDE_DIR_NAMES: v2 user-decided list", () => {
  assert.deepEqual(DEFAULT_EXCLUDE_DIR_NAMES, ["docs", "doc", "tmp", "temp", "design", "designs"]);
});

test("stripCommonDirs: single common-directory strip / multiple / case / non-common untouched / Windows backslash", () => {
  assert.equal(stripCommonDirs("/home/w/proj/docs"), "/home/w/proj");
  assert.equal(stripCommonDirs("/home/w/proj/docs/design"), "/home/w/proj"); // strips two layers in a row
  assert.equal(stripCommonDirs("/home/w/proj/Design"), "/home/w/proj");      // case-insensitive
  assert.equal(stripCommonDirs("/home/w/proj/src"), "/home/w/proj/src");     // non-common names untouched
  assert.equal(stripCommonDirs("D:\\workspace\\proj\\tmp"), "D:/workspace/proj");
  assert.equal(stripCommonDirs("/home/w/proj"), "/home/w/proj");
});

test("longestCovering: longest (deepest) cover / never selects a subdirectory of the target / empty candidates", () => {
  const cands = ["/home/w", "/home/w/proj", "/home/w/other"];
  assert.equal(longestCovering("/home/w/proj/src/x.ts", cands), "/home/w/proj");
  assert.equal(longestCovering("/home/w/proj", cands), "/home/w/proj");       // equal counts as a hit
  assert.equal(longestCovering("/home/w/other/a", cands), "/home/w/other");
  // candidate is a subdirectory of the target (e.g. a workspace candidate inside proj's src) → must not be selected (coversDir is one-way)
  assert.equal(longestCovering("/home/w/proj", ["/home/w/proj/src"]), null);
  assert.equal(longestCovering("/x/y/z.ts", []), null);
  assert.equal(longestCovering("/x/y/z.ts", ["", null, undefined]), null);
});

test("resolveNewSessionCwd: target inside the current CWD → keep", () => {
  const r = resolveNewSessionCwd({ targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web" });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd: current CWD inside the target (target = parent level) → keep", () => {
  const r = resolveNewSessionCwd({ targetDir: "/home/w", currentCwd: "/home/w/pi-web" });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd v2: target inside a watched path → switch to it (no longer keep)", () => {
  // current cwd in repo A, target in repo B — B is among A's watchPaths (git-trace-configured cross-repo watching) → switch to B
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj/src", targetPath: "/home/w/other-proj/src/x.ts",
    currentCwd: "/home/w/pi-web",
    watchPaths: ["/home/w/other-proj"],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2: watched path {path,repoRoot} object → repoRoot first", () => {
  // the watched path is a repo subdirectory → on a hit use repoRoot (the repo root fits the workspace concept better)
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj/packages/core",
    targetPath: "/home/w/other-proj/packages/core/README.md",
    currentCwd: "/home/w/pi-web",
    watchPaths: [{ path: "/home/w/other-proj/packages/core", repoRoot: "/home/w/other-proj" }],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2: nested watched paths take the deepest", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/mono/apps/foo",
    targetPath: "/home/w/mono/apps/foo/x.ts",
    currentCwd: "/home/w/pi-web",
    watchPaths: ["/home/w/mono", { path: "/home/w/mono/apps/foo", repoRoot: "/home/w/mono/apps/foo" }],
  });
  assert.equal(r.cwd, "/home/w/mono/apps/foo"); // the deeper hit wins
});

test("resolveNewSessionCwd v2: watched path configured below the target (target directory is its parent) → switch to the watched path", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj",
    targetPath: "/home/w/other-proj",
    currentCwd: "/home/w/pi-web",
    watchPaths: [{ path: "/home/w/other-proj/src", repoRoot: "/home/w/other-proj" }],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2: covered by a known workspace → longest match", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/x.ts",
    currentCwd: "/home/w/demo-repo",
    knownWorkspaces: ["/home/w", "/home/w/pi-web", "/home/w/other"],
  });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2: common-directory stripping (no workspace hit)", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/proj/docs", targetPath: "/home/w/proj/docs/guide.md",
    currentCwd: "/home/w/other",
    knownWorkspaces: ["/home/w/other", "/home/w/unrelated"],
  });
  assert.equal(r.cwd, "/home/w/proj"); // docs stripped; proj not among known workspaces → use the stripped result
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd v2: stripped result hits a workspace → use that workspace", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "/home/w/demo-repo",
    knownWorkspaces: ["/home/w/demo-repo", "/home/w/pi-web"],
  });
  assert.equal(r.cwd, "/home/w/pi-web"); // after stripping docs, /home/w/pi-web hits a known workspace
});

test("resolveNewSessionCwd v2: no CWD → known workspace hit (never lands in a deep directory; fixes the v1 bug)", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "",
    knownWorkspaces: ["/home/w/pi-web"],
  });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false); // no current cwd → always false
});

test("resolveNewSessionCwd v2: no CWD → watched directory hit", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/other-proj/src", targetPath: "/home/w/other-proj/src/x.ts",
    currentCwd: "",
    watchPaths: [{ path: "/home/w/other-proj", repoRoot: "/home/w/other-proj" }],
  });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd v2: no CWD and no candidates → directory after stripping common names", () => {
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/proj/tmp", targetPath: "/home/w/proj/tmp/x.log",
    currentCwd: null,
  });
  assert.equal(r.cwd, "/home/w/proj");
  assert.equal(r.switched, false);
});

test("resolveNewSessionCwd: target belongs to another workspace with no watched/known entries → switch away (after stripping)", () => {
  const r = resolveNewSessionCwd({ targetDir: "/home/w/other-proj", currentCwd: "/home/w/pi-web" });
  assert.equal(r.cwd, "/home/w/other-proj");
  assert.equal(r.switched, true);
});

test("resolveNewSessionCwd: empty targetDir/targetPath → return the current cwd", () => {
  const r = resolveNewSessionCwd({ targetDir: "", currentCwd: "/a" });
  assert.equal(r.cwd, "/a");
  assert.equal(r.switched, false);
  const r2 = resolveNewSessionCwd({ targetDir: "", targetPath: "", currentCwd: null });
  assert.equal(r2.cwd, "");
});

test("resolveNewSessionCwd v2: file inside the CWD but targetPath deeper (docs subdirectory) → keep (no stripping)", () => {
  // current CWD = project root, file in the project's docs subdirectory → ① hits and keeps (v2 principle: already inside the CWD, never switch casually)
  const r = resolveNewSessionCwd({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "/home/w/pi-web",
    knownWorkspaces: ["/home/w/pi-web"],
  });
  assert.equal(r.cwd, "/home/w/pi-web");
  assert.equal(r.switched, false);
});

// ── client flow (resolveNewSessionCwdClient) ──────────────
test("resolveNewSessionCwdClient: target inside the current CWD → fast-path short-circuit, no request sent", async () => {
  let called = 0;
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts",
    currentCwd: "/home/w/pi-web",
    apiUrl: () => { called++; return "http://x/ext"; },
    fetchFn: (async () => { throw new Error("no request expected"); })
  });
  assert.equal(cwd, "/home/w/pi-web");
  assert.equal(called, 0);
});

test("resolveNewSessionCwdClient: on switch-away, derives from sessions + endpoint cross-check (watched hit → switch to the watched directory)", async () => {
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
  // sessions first (derives the known list) → endpoint after
  assert.deepEqual(calls, ["/api/sessions", "/api/extensions/aiti-git-trace/new-session-cwd"]);
});

test("resolveNewSessionCwdClient: endpoint cross-check hits a switch → use the endpoint result", async () => {
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

test("resolveNewSessionCwdClient: endpoint fails/absent → local resolution fallback (known list in hand)", async () => {
  _resetWsCacheForTest();
  // git-trace endpoint fetch throws (not installed/404) → fallback = local resolveNewSessionCwd (knownWorkspaces already derived from sessions)
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/pi-web/docs", targetPath: "/home/w/pi-web/docs/guide.md",
    currentCwd: "/home/w/demo-repo",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [{ cwd: "/home/w/pi-web" }] }) };
      throw new Error("network");
    })
  });
  assert.equal(cwd, "/home/w/pi-web"); // endpoint absent → known workspace hit, never lands in the docs subdirectory
});

test("resolveNewSessionCwdClient: endpoint returns non-ok → fallback", async () => {
  _resetWsCacheForTest();
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/other-proj",
    currentCwd: "/home/w/pi-web",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) return { ok: true, json: async () => ({ sessions: [] }) };
      return { ok: true, json: async () => ({ ok: false, error: "missing targetDir" }) };
    })
  });
  assert.equal(cwd, "/home/w/other-proj");
});

test("resolveNewSessionCwdClient: no cwd → no short-circuit, sessions hit normalizes to the workspace", async () => {
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

test("resolveNewSessionCwdClient: sessions fetch fails → degrade to [], local resolution still works", async () => {
  _resetWsCacheForTest();
  const cwd = await resolveNewSessionCwdClient({
    targetDir: "/home/w/proj/tmp", targetPath: "/home/w/proj/tmp/x.log",
    currentCwd: "/home/w/other",
    apiUrl: (p) => "http://host" + p,
    fetchFn: (async (url) => {
      if (String(url).includes("/api/sessions")) throw new Error("sessions fetch failed");
      return { ok: true, json: async () => ({ ok: true, cwd: "/home/w/proj", switched: true }) };
    })
  });
  assert.equal(cwd, "/home/w/proj"); // endpoint result wins; sessions being absent does not affect the main flow
});

test("buildAtText: same format as the host's buildAtMentionText (quotes around spaces, trailing slash for directories)", () => {
  assert.equal(buildAtText("docs/a.md"), "@docs/a.md ");
  assert.equal(buildAtText("my docs/a.md"), '@"my docs/a.md" ');
  assert.equal(buildAtText("proj", true), "@proj/ ");
  assert.equal(buildAtText("my proj", true), '@"my proj/" ');
  assert.equal(buildAtText("proj/", true), "@proj/ "); // trailing slash normalized
  assert.equal(buildAtText("D:/workspace/a b.md"), '@"D:/workspace/a b.md" ');
});

test("openNewSession: pendingComposer + CWD resolution + dispatch (dispatch injected; node has no window)", async () => {
  _resetWsCacheForTest();
  const win = {};
  const events = [];
  await openNewSession({
    text: "@docs/a.md ", targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web",
    apiUrl: () => "http://x",
    fetchFn: (async () => { throw new Error("no request expected (containment keeps)"); }),
    dispatch: (evt) => events.push(evt),
    windowRef: win,
  });
  assert.ok(win.__piWebPendingComposer);
  assert.equal(win.__piWebPendingComposer.text, "@docs/a.md ");
  assert.ok(win.__piWebPendingComposer.at > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "pi-web:new-session");
  assert.equal(events[0].detail.cwd, "/home/w/pi-web"); // keeps current
});

test("openNewSession: switch-away path (switches to the target after sessions + git-trace endpoint cross-check)", async () => {
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

test("openNewSessionWithExtSvc: session-manager.mention service first (targetPath passed through)", async () => {
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

test("openNewSessionWithExtSvc: service absent → falls back to the same-source _shared implementation", async () => {
  _resetWsCacheForTest();
  let fetchCalled = 0;
  const events = [];
  await openNewSessionWithExtSvc({
    text: "@docs/a.md ", targetDir: "/home/w/pi-web/lib", targetPath: "/home/w/pi-web/lib/a.ts", currentCwd: "/home/w/pi-web",
    apiUrl: () => "http://x",
    extSvc: () => undefined, // session-manager absent
    fetchFn: (async () => { fetchCalled++; throw new Error("no request expected (containment keeps)"); }),
    dispatch: (evt) => events.push(evt),
    windowRef: {},
  });
  assert.equal(fetchCalled, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.cwd, "/home/w/pi-web"); // fallback path behaves identically to the shared implementation
});

test("openNewSessionWithExtSvc: no extSvc injected → falls back directly (full switch-away chain)", async () => {
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
