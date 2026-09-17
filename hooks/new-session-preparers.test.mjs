import assert from "node:assert/strict";
import test from "node:test";
import { runNewSessionPreparers } from "./new-session-preparers.ts";

// 行为测试（docs/pi-web-new-session-branch-worktree-plan.md M1 验收）：
// preparer 管道 = ensureNewSession POST 前的扩展执行缝——顺序、cwd 链式改写、abort 中止。

const ctx = (cwd) => ({ cwd });

test("无 preparer 时原样返回目标 cwd", async () => {
  assert.deepEqual(await runNewSessionPreparers(undefined, "/repo"), { cwd: "/repo" });
  assert.deepEqual(await runNewSessionPreparers([], "/repo"), { cwd: "/repo" });
});

test("preparer 按注册顺序执行，cwd 链式改写（后手看到先手输出）", async () => {
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

test("abort 中止管道：文案原样 throw，后续 preparer 不执行", async () => {
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

test("void/undefined 返回不介入管道", async () => {
  const out = await runNewSessionPreparers([{ id: "v", prepare: async () => {} }], "/repo");
  assert.deepEqual(out, { cwd: "/repo" });
});
