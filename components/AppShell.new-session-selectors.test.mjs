import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 回归保护（2026-09-17 新建会话「分支 / Worktree」选择器，方案
// docs/pi-web-new-session-branch-worktree-plan.md M1）：
//  1. newSessionSelectors 渲染插槽：DOM 顺序钉在 Workspace 与 Backend 之间；
//  2. newSessionPreparers 注册面：ensureNewSession 在 POST 前依序 await，
//     {cwd} 改写目标目录、{abort} 走既有 throw→notice 通道；
//  3. 改写后的 cwd 经 promoteNewSession 上报 onSessionCreated（AppShell 切活动工作区）。
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const useAgentSession = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const extTypes = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const preparers = await readFile(new URL("../hooks/new-session-preparers.ts", import.meta.url), "utf8");

test("插槽契约：newSessionSelectors + newSessionPreparers 进 ExtSlotName/ui 声明/契约 map", () => {
  assert.match(extTypes, /"newSessionSelectors"/);
  assert.match(extTypes, /"newSessionPreparers"/);
  assert.match(extTypes, /newSessionSelectors: \{ props: NewSessionSelectorSlotProps \}/);
  assert.match(extTypes, /newSessionSelectors\?: ExtUiItem\[\]/);
  assert.match(extTypes, /newSessionPreparers\?: ExtUiItem\[\]/);
  // extra 只喂数据（插槽 extra 红线）：契约里不允许回调字段
  const contract = extTypes.slice(extTypes.indexOf("interface NewSessionSelectorSlotProps"), extTypes.indexOf("NewSessionPrepareResult"));
  assert.match(contract, /cwd: string \| null/);
  assert.match(contract, /isMobile: boolean/);
});

test("渲染点 DOM 顺序：Workspace < newSessionSelectors < Backend", () => {
  const workspaceAt = chatWindow.indexOf(">Workspace</span>");
  const selectorsAt = chatWindow.indexOf('name="newSessionSelectors"');
  const backendAt = chatWindow.indexOf(">Backend</span>");
  assert.notEqual(workspaceAt, -1, "Workspace 标签缺失");
  assert.notEqual(selectorsAt, -1, "newSessionSelectors 插槽缺失");
  assert.notEqual(backendAt, -1, "Backend 标签缺失");
  assert.ok(workspaceAt < selectorsAt && selectorsAt < backendAt, "插槽应渲染在 Workspace 与 Backend 之间");
  // extra 只喂数据 {cwd,isMobile}
  assert.match(chatWindow, /extra=\{\{ cwd: newSessionCwd, isMobile \}\}/);
  // 选择器行渲染门控把插槽纳入（无 workspace/backend 选项时选择器仍可见）
  assert.match(chatWindow, /backendExtraOptions\.length > 0 \|\| hasNewSessionSelectors/);
});

test("preparer 收集与透传：ChatWindow 收 meta.prepare → useAgentSession 管道", () => {
  assert.match(chatWindow, /useExtSlotItems\("newSessionPreparers"\)/);
  assert.match(chatWindow, /typeof it\.meta\?\.prepare === "function"/);
  assert.match(chatWindow, /newSessionPreparers,/);
  assert.match(useAgentSession, /newSessionPreparers\?: NewSessionPreparer\[\]/);
  // ref 镜像（插槽 items 身份变化不破坏回调稳定）
  assert.match(useAgentSession, /newSessionPreparersRef\.current = opts\.newSessionPreparers/);
});

test("ensureNewSession：preparer 管道在 POST 之前，改写后的 cwd 进请求体", () => {
  const pipelineAt = useAgentSession.indexOf("runNewSessionPreparers(newSessionPreparersRef.current");
  const fetchAt = useAgentSession.indexOf('fetch(apiUrl("/api/agent/new")');
  assert.notEqual(pipelineAt, -1, "ensureNewSession 内未见 preparer 管道调用");
  assert.notEqual(fetchAt, -1);
  assert.ok(pipelineAt < fetchAt, "preparer 管道必须在 POST /api/agent/new 之前");
  // 请求体 cwd = 管道输出（不再是裸 newSessionCwd）
  assert.match(useAgentSession, /cwd: prepared\.cwd,/);
  // abort = throw 既有通道：错误经 handleSend catch → addNotice；无新增显示机制
  assert.match(preparers, /if \(r\.abort\) throw new Error\(r\.abort\)/);
  assert.match(preparers, /if \(r\.cwd\) target = r\.cwd/);
});

test("改写后的 cwd 上报会话创建（AppShell 据此切活动工作区到 worktree 路径）", () => {
  assert.match(useAgentSession, /cwd: newSessionResolvedCwdRef\.current \?\? newSessionCwd,/);
  // resolved 在 POST 前落 ref（成功路径 promote 读取；失败路径不落 promote）
  const resolvedAt = useAgentSession.indexOf("newSessionResolvedCwdRef.current = prepared.cwd");
  const fetchAt = useAgentSession.indexOf('fetch(apiUrl("/api/agent/new")');
  assert.ok(resolvedAt > -1 && resolvedAt < fetchAt, "resolved cwd 必须在 POST 之前落 ref");
});
