import assert from "node:assert/strict";
import test from "node:test";
import { runNewSessionPreparers } from "./new-session-preparers.ts";

// Behavior tests (docs/pi-web-new-session-branch-worktree-plan.md M1 acceptance):
// the preparer pipeline is the extension execution seam before the ensureNewSession
// POST — ordering, chained cwd rewriting, abort cancellation.

const ctx = (cwd) => ({ cwd });

test("returns the target cwd unchanged when there is no preparer", async () => {
  assert.deepEqual(await runNewSessionPreparers(undefined, "/repo"), { cwd: "/repo" });
  assert.deepEqual(await runNewSessionPreparers([], "/repo"), { cwd: "/repo" });
});

test("preparers run in registration order with chained cwd rewriting (later sees earlier output)", async () => {
  const seen = [];
  const out = await runNewSessionPreparers(
    [
      { id: "a", prepare: async (c) => { seen.push(`a:${c.cwd}`); return { cwd: "/wt/a" }; } },
      { id: "b", prepare: async (c) => { seen.push(`b:${c.cwd}`); return { cwd: "/wt/b" }; } },
      { id: "c", prepare: async (c) => { seen.push(`c:${c.cwd}`); } },
    ],
    "/repo",
  );
  assert.deepEqual(seen, ["a:/repo", "b:/wt/a", "c:/wt/b"]);
  assert.deepEqual(out, { cwd: "/wt/b" });
});

test("abort cancels the pipeline: message thrown verbatim, later preparers skipped", async () => {
  const after = [];
  await assert.rejects(
    runNewSessionPreparers(
      [
        { id: "x", prepare: async () => ({ abort: "已取消发送" }) },
        { id: "y", prepare: async () => { after.push("y"); } },
      ],
      "/repo",
    ),
    (e) => e instanceof Error && e.message === "已取消发送",
  );
  assert.deepEqual(after, []);
});

test("a void/undefined return does not intervene in the pipeline", async () => {
  const out = await runNewSessionPreparers([{ id: "v", prepare: async () => {} }], "/repo");
  assert.deepEqual(out, { cwd: "/repo" });
});
