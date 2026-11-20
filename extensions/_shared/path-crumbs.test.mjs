/**
 * path-crumbs tests — breadcrumb splitting is the only place that decides what a
 * clickable folder segment is; the picker must stay correct on POSIX, Windows drive
 * and UNC paths (the server may run on another platform than the browser).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parentOfPath, splitPathSegments } from "./path-crumbs.ts";

test("POSIX absolute path: root plus cumulative segments", () => {
  assert.deepEqual(splitPathSegments("/home/wind/workspace"), {
    sep: "/",
    root: { label: "/", path: "/" },
    segments: [
      { label: "home", path: "/home" },
      { label: "wind", path: "/home/wind" },
      { label: "workspace", path: "/home/wind/workspace" },
    ],
  });
});

test("POSIX: trailing and duplicated separators do not create empty segments", () => {
  const trailing = splitPathSegments("/a/b/");
  assert.deepEqual(trailing.segments.map((s) => s.label), ["a", "b"]);
  const duplicated = splitPathSegments("/a//b");
  assert.deepEqual(duplicated.segments.map((s) => s.path), ["/a", "/a/b"]);
});

test("filesystem root and empty path", () => {
  assert.deepEqual(splitPathSegments("/"), { sep: "/", root: { label: "/", path: "/" }, segments: [] });
  assert.deepEqual(splitPathSegments(""), { sep: "/", root: null, segments: [] });
});

test("relative path: no root, cumulative segments still navigate the same levels", () => {
  assert.deepEqual(splitPathSegments("home/wind"), {
    sep: "/",
    root: null,
    segments: [
      { label: "home", path: "home" },
      { label: "wind", path: "home/wind" },
    ],
  });
});

test("Windows drive: drive root crumb, backslash separators", () => {
  assert.deepEqual(splitPathSegments("C:\\Users\\me"), {
    sep: "\\",
    root: { label: "C:", path: "C:\\" },
    segments: [
      { label: "Users", path: "C:\\Users" },
      { label: "me", path: "C:\\Users\\me" },
    ],
  });
});

test("Windows with forward slashes / duplicated separators / bare drive", () => {
  const forward = splitPathSegments("C:/Users/me/");
  assert.equal(forward.sep, "\\");
  assert.deepEqual(forward.segments.map((s) => s.path), ["C:\\Users", "C:\\Users\\me"]);
  assert.deepEqual(splitPathSegments("C:\\\\Users"), splitPathSegments("C:\\Users"));
  assert.deepEqual(splitPathSegments("C:\\"), { sep: "\\", root: { label: "C:", path: "C:\\" }, segments: [] });
  assert.deepEqual(splitPathSegments("C:"), { sep: "\\", root: { label: "C:", path: "C:\\" }, segments: [] });
});

test("UNC path: server/share is one root crumb", () => {
  assert.deepEqual(splitPathSegments("\\\\server\\share\\team\\docs"), {
    sep: "\\",
    root: { label: "\\\\server\\share", path: "\\\\server\\share" },
    segments: [
      { label: "team", path: "\\\\server\\share\\team" },
      { label: "docs", path: "\\\\server\\share\\team\\docs" },
    ],
  });
  assert.deepEqual(splitPathSegments("\\\\server\\share"), {
    sep: "\\",
    root: { label: "\\\\server\\share", path: "\\\\server\\share" },
    segments: [],
  });
});

test("parentOfPath: one level up, never above a filesystem root", () => {
  assert.equal(parentOfPath("/a/b/c"), "/a/b");
  assert.equal(parentOfPath("/a"), "/");
  assert.equal(parentOfPath("/"), null);
  assert.equal(parentOfPath("C:\\a\\b"), "C:\\a");
  assert.equal(parentOfPath("C:\\a"), "C:\\");
  assert.equal(parentOfPath("C:\\"), null);
  assert.equal(parentOfPath("\\\\server\\share\\a"), "\\\\server\\share");
  assert.equal(parentOfPath("\\\\server\\share"), null);
  assert.equal(parentOfPath(""), null);
});
