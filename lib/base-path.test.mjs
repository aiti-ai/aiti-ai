import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const subject = await jiti.import("./base-path.ts");

function withBasePathEnv(value, fn) {
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = previous;
  }
}

test("withBasePath is an identity for root deployments", () => {
  withBasePathEnv("", () => {
    assert.equal(subject.withBasePath("/api/sessions"), "/api/sessions");
    assert.equal(subject.withBasePath("/"), "/");
    assert.equal(subject.apiUrl("/api/models"), "/api/models");
    assert.equal(subject.getBasePath(), "");
  });
});

test("withBasePath prefixes root-absolute paths under a sub-path deployment", () => {
  withBasePathEnv("/dev", () => {
    assert.equal(subject.getBasePath(), "/dev");
    assert.equal(subject.withBasePath("/api/sessions"), "/dev/api/sessions");
    assert.equal(subject.withBasePath("/sw.js"), "/dev/sw.js");
    assert.equal(subject.withBasePath("/"), "/dev/");
    assert.equal(subject.withBasePath("/icons/icon-192.png"), "/dev/icons/icon-192.png");
  });
});

test("withBasePath never double-prefixes already-prefixed paths", () => {
  withBasePathEnv("/dev", () => {
    assert.equal(subject.withBasePath("/dev/api/sessions"), "/dev/api/sessions");
    assert.equal(subject.withBasePath("/dev/sw.js"), "/dev/sw.js");
    assert.equal(subject.withBasePath("/dev"), "/dev");
    assert.equal(subject.withBasePath("/dev?foo=1"), "/dev?foo=1");
  });
});

test("withBasePath normalizes trailing slashes in the configured base path", () => {
  withBasePathEnv("/dev/", () => {
    assert.equal(subject.getBasePath(), "/dev");
    assert.equal(subject.withBasePath("/api/sessions"), "/dev/api/sessions");
  });
});

test("apiUrl is an alias of withBasePath", () => {
  withBasePathEnv("/dev", () => {
    assert.equal(subject.apiUrl("/api/agent/s1/events"), subject.withBasePath("/api/agent/s1/events"));
  });
});

test("inAppPathname strips the base path so router.replace cannot double it", () => {
  withBasePathEnv("/dev", () => {
    globalThis.window = { location: { pathname: "/dev/" } };
    assert.equal(subject.inAppPathname("/"), "/");
    globalThis.window = { location: { pathname: "/dev" } };
    assert.equal(subject.inAppPathname("/"), "/");
    globalThis.window = { location: { pathname: "/dev/chat?x=1" } };
    assert.equal(subject.inAppPathname("/"), "/chat?x=1");
    globalThis.window = { location: { pathname: "/devx" } };
    assert.equal(subject.inAppPathname("/"), "/devx");
    delete globalThis.window;
  });
  withBasePathEnv("", () => {
    globalThis.window = { location: { pathname: "/chat" } };
    assert.equal(subject.inAppPathname("/"), "/chat");
    delete globalThis.window;
    assert.equal(subject.inAppPathname("/fallback"), "/fallback");
  });
});
