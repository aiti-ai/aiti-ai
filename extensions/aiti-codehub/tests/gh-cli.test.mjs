import test from "node:test";
import assert from "node:assert/strict";
import { createGhCli, withGhToken } from "../server/gh-cli.ts";
import { ForgeHttpError } from "../server/http.ts";

const HOSTS = JSON.stringify({
  hosts: {
    "github.com": [
      { state: "success", active: false, host: "github.com", login: "bob", scopes: "repo", tokenSource: "keyring" },
      { state: "success", active: true, host: "github.com", login: "alice", scopes: "repo, read:org", tokenSource: "keyring" },
    ],
    "ghe.example.com": [
      { state: "success", active: true, host: "ghe.example.com", login: "carol", scopes: "repo" },
    ],
  },
});

function fakeExec(overrides = {}) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    const joined = args.join(" ");
    if (joined.includes("--version")) return { stdout: "gh version 2.100.0 (2026-09-03)\n", stderr: "" };
    if (joined.includes("auth status")) return { stdout: HOSTS, stderr: "" };
    if (joined.includes("auth token")) {
      if (overrides.tokenError) throw Object.assign(new Error("failed"), { stderr: "not logged in" });
      return { stdout: "gho_test_token\n", stderr: "" };
    }
    throw new Error("unexpected gh invocation: " + joined);
  };
  return { exec, calls };
}

test("gh status: available, host filter, active account first", async () => {
  const { exec } = fakeExec();
  const cli = createGhCli(exec);
  const all = await cli.status();
  assert.equal(all.available, true);
  assert.match(String(all.version), /2\.100\.0/);
  assert.deepEqual(all.accounts.map((a) => a.login), ["alice", "carol", "bob"]);
  assert.equal(all.accounts[0].active, true);
  const gh = await cli.status("github.com");
  assert.deepEqual(gh.accounts.map((a) => a.login), ["alice", "bob"]);
});

test("gh status: missing gh reports unavailable", async () => {
  const exec = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); };
  const cli = createGhCli(exec);
  const s = await cli.status();
  assert.equal(s.available, false);
  assert.match(String(s.error), /not installed/);
});

test("gh token: reads via CLI, caches, and clears", async () => {
  const { exec, calls } = fakeExec();
  const cli = createGhCli(exec);
  assert.equal(await cli.token("github.com", "alice"), "gho_test_token");
  assert.equal(await cli.token("github.com", "alice"), "gho_test_token");
  const tokenCalls = calls.filter((c) => c.join(" ").includes("auth token"));
  assert.equal(tokenCalls.length, 1, "second read must hit the cache");
  assert.deepEqual(tokenCalls[0].slice(1), ["auth", "token", "--hostname", "github.com", "--user", "alice"]);
  cli.clearTokenCache();
  await cli.token("github.com", "alice");
  assert.equal(calls.filter((c) => c.join(" ").includes("auth token")).length, 2);
});

test("gh token: failure is an auth error, never leaks stderr as a token", async () => {
  const { exec } = fakeExec({ tokenError: true });
  const cli = createGhCli(exec);
  await assert.rejects(() => cli.token("github.com"), (e) => e instanceof ForgeHttpError && e.code === "auth" && !/gho_/.test(e.message));
});

test("withGhToken only touches gh-mode configs", async () => {
  const { exec } = fakeExec();
  const cli = createGhCli(exec);
  const pat = await withGhToken({ authType: "pat", token: "pat-token" }, cli);
  assert.equal(pat.token, "pat-token");
  const gh = await withGhToken({ authType: "gh", ghHost: "github.com", ghUser: "alice" }, cli);
  assert.equal(gh.token, "gho_test_token");
});
