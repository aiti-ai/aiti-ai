/**
 * aiti-codebuddy-agent — codebuddy-core tests（2.148.0 实测帧钉死）。
 *
 * Run: node --test pi-web-ext/aiti-codebuddy-agent/codebuddy-core.test.mjs
 *
 * 帧样本来源：`npx -y @tencent-ai/codebuddy-code -p "hi" --output-format stream-json`
 * （2026-09-10 未登录实测）——system/init 双发、assistant{message.content}、
 * result{is_error:true, exit 0, modelUsage.contextWindow}。字段逐字节对齐真实输出。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  parseFrame, parseAssistantFrame, usageFromResult, deltaFromStreamEvent,
  buildTurnArgs, buildStreamArgs, userLine, controlRequestLine, isSwallowedResult,
  resolveCli, npxCliJsPath, extractTurnError,
  readCred, writeCred, credPath, buildTurnEnv,
  CBC_MODELS, DEFAULT_MODEL,
  stripAnsi, extractCbcLoginUrl, loginFingerprint, buildLoginCommand, codebuddyHome,
  createFeedState, feedStdout, flushStdoutTail,
  toolResultsFromUserFrame,
  parseCliAuthFile, readCliAuth, CBC_CLI_AUTH_REL, isolateCliLogin, fetchCbcQuota,
} = await import("./codebuddy-core.ts");

// ── 真实帧样本（逐字段对齐实测输出，只截断 tools/slash_commands 数组）──
const INIT_FRAME = {
  type: "system", subtype: "init",
  uuid: "01a08c07-5d59-73f3-97da-3dad574bea28",
  session_id: "01a08c07-5d59-73f3-97da-3dad574bea28",
  apiKeySource: "www.codebuddy.ai", cwd: "/tmp", tools: ["Read", "Write", "Bash"],
  mcp_servers: [], model: "default-model", permissionMode: "default",
  slash_commands: ["login", "logout", "model"],
  output_style: "default", __timestamp: "2026-09-10T15:54:48.636Z",
};
const ASSISTANT_FRAME = {
  type: "assistant", uuid: "01a08c07-5fdb",
  session_id: "01a08c07-5d59-73f3-97da-3dad574bea28",
  message: {
    id: "01a08c07-5fdb", content: [{ type: "text", text: "Authentication required. Please use /login command to sign in to your account" }],
    model: "default-model", role: "assistant", stop_reason: null, stop_sequence: null, type: "message",
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
  parent_tool_use_id: null, _requestId: "r1",
  _meta: { baggage: "codebuddy.session_id=01a08c07" }, __timestamp: "2026-09-10T15:54:48.708Z",
};
const RESULT_ERROR_FRAME = {
  type: "result", subtype: "error_during_execution", is_error: true, uuid: "01a08c07-6005",
  session_id: "01a08c07-5d59-73f3-97da-3dad574bea28",
  duration_ms: 84, duration_api_ms: 51, num_turns: 2, total_cost_usd: 0,
  usage: { input_tokens: 1200, output_tokens: 88, cache_creation_input_tokens: 0, cache_read_input_tokens: 3400, cache_creation: null, server_tool_use: null },
  permission_denials: [],
  errors: ["Authentication required. Please use /login command to sign in to your account"],
  modelUsage: { "default-model": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, contextWindow: 176000, maxOutputTokens: 24000 } },
  __timestamp: "2026-09-10T15:54:48.710Z", _requestId: "r1",
};
const STREAM_DELTA_FRAME = {
  type: "stream_event", session_id: "s1",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
};

test("parseFrame：真实 init/assistant/result/stream_event 行", () => {
  assert.equal(parseFrame(JSON.stringify(INIT_FRAME))?.subtype, "init");
  assert.equal(parseFrame(JSON.stringify(ASSISTANT_FRAME))?.type, "assistant");
  assert.equal(parseFrame("not json {broken"), null);
  assert.equal(parseFrame("[1,2]"), null);
});

test("parseAssistantFrame：文本 + 模型 + 工具调用（message.content 嵌套形状）", () => {
  const a = parseAssistantFrame(parseFrame(JSON.stringify(ASSISTANT_FRAME)));
  assert.ok(a);
  assert.equal(a.text, "Authentication required. Please use /login command to sign in to your account");
  assert.equal(a.model, "default-model");
  assert.deepEqual(a.toolCalls, []);
  // 工具调用块
  const withTool = parseAssistantFrame(parseFrame(JSON.stringify({
    type: "assistant", message: {
      content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } }, { type: "text", text: "看了" }],
      model: "glm-5.3",
    },
  })));
  assert.ok(withTool);
  assert.equal(withTool.model, "glm-5.3");
  assert.deepEqual(withTool.toolCalls, [{ id: "t1", name: "Read", input: { path: "/x" } }]);
  assert.equal(withTool.text, "看了");
  // 顶层 content 形状（防御式兼容 cbc 内部风格）
  const topLevel = parseAssistantFrame(parseFrame(JSON.stringify({
    type: "assistant", role: "assistant", model: "glm-5.2",
    content: [{ type: "output_text", text: "顶层形状" }],
  })));
  assert.ok(topLevel);
  assert.equal(topLevel.text, "顶层形状");
});

test("usageFromResult：token 归一 + contextWindow 取 modelUsage 首档", () => {
  const u = usageFromResult(parseFrame(JSON.stringify(RESULT_ERROR_FRAME)));
  assert.equal(u.inputTokens, 1200);
  assert.equal(u.outputTokens, 88);
  assert.equal(u.cacheReadTokens, 3400);
  assert.equal(u.numTurns, 2);
  assert.equal(u.model, "default-model");
  assert.equal(u.contextWindow, 176000);
});

test("deltaFromStreamEvent：text_delta 提取 / 其他增量忽略", () => {
  assert.equal(deltaFromStreamEvent(parseFrame(JSON.stringify(STREAM_DELTA_FRAME))), "你好");
  assert.equal(deltaFromStreamEvent(parseFrame(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }))), null);
});

test("buildTurnArgs：单发 -p + stream-json + resume/model/permissionMode", () => {
  const args = buildTurnArgs({ prompt: "说两个字:你好", sessId: "abc-uuid", model: "glm-5.3", permissionMode: "bypassPermissions" });
  assert.deepEqual(args, [
    "-p", "说两个字:你好",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--model", "glm-5.3",
    "--permission-mode", "bypassPermissions",
    "--resume", "abc-uuid",
  ]);
  const bare = buildTurnArgs({ prompt: "hi", includePartial: false });
  assert.ok(!bare.includes("--include-partial-messages"));
  assert.ok(!bare.includes("--resume"));
});

test("buildStreamArgs：长连接 -p + 双端 stream-json + verbose + model/permission/resume", () => {
  const args = buildStreamArgs({ model: "hy4-preview", permissionMode: "bypassPermissions", resumeSid: "abc-uuid" });
  assert.deepEqual(args, [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model", "hy4-preview",
    "--permission-mode", "bypassPermissions",
    "--resume", "abc-uuid",
  ]);
  const bare = buildStreamArgs({ includePartial: false });
  assert.ok(!bare.includes("--include-partial-messages"));
  assert.ok(!bare.includes("--resume"));
  assert.ok(bare.includes("--input-format")); // 长连接必需：stdin 多轮
});

test("userLine：stdin 用户消息行（CC 同形，可往返解析）", () => {
  const line = userLine("说两个字:你好");
  assert.deepEqual(JSON.parse(line), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "说两个字:你好" }] },
  });
});

test("isSwallowedResult：turn-ack 吞输入判定（2026-09-12 实测钉死）", () => {
  const base = { activity: false, resultText: "OLD", lastResultText: "OLD", sinceWriteMs: 8000 };
  // 复读上轮 result：即使距写入很久也判定被吞
  assert.equal(isSwallowedResult({ ...base }), true);
  // 有活动帧（真轮）→ 不是吞
  assert.equal(isSwallowedResult({ ...base, activity: true }), false);
  // 无上轮 result（首轮）→ 不可能复读
  assert.equal(isSwallowedResult({ ...base, lastResultText: null }), false);
  // 错误轮 → 不进吞判定（走错误收口）
  assert.equal(isSwallowedResult({ ...base, isError: true }), false);
  // 文本不同但距写入极短（无活动）→ 吞
  assert.equal(isSwallowedResult({ ...base, resultText: "NEW", sinceWriteMs: 500 }), true);
  // 文本不同且距写入较久（无活动）→ 非吞（真轮/真实无输出轮）
  assert.equal(isSwallowedResult({ ...base, resultText: "NEW", sinceWriteMs: 5000 }), false);
});

test("controlRequestLine：interrupt / set_model / set_permission_mode 三通道", () => {
  assert.deepEqual(JSON.parse(controlRequestLine("int-1", { subtype: "interrupt" })), {
    type: "control_request", request_id: "int-1", request: { subtype: "interrupt" },
  });
  assert.deepEqual(JSON.parse(controlRequestLine("sm-1", { subtype: "set_model", model: "hy3" })), {
    type: "control_request", request_id: "sm-1", request: { subtype: "set_model", model: "hy3" },
  });
  assert.deepEqual(JSON.parse(controlRequestLine("pm-1", { subtype: "set_permission_mode", mode: "default" })), {
    type: "control_request", request_id: "pm-1", request: { subtype: "set_permission_mode", mode: "default" },
  });
});

test("resolveCli：显式路径优先 → 不存在 throw；npx 兜底 = node + npx-cli.js", () => {
  const bin = join(tmpdir(), "cbc-fake-bin");
  writeFileSync(bin, "#!/bin/sh\n");
  const direct = resolveCli({ featurePath: bin });
  assert.equal(direct.kind, "direct");
  assert.equal(direct.cmd, bin);
  assert.throws(() => resolveCli({ featurePath: "/nonexistent/cbc" }), /路径不存在/);
  const npx = resolveCli({});
  assert.equal(npx.kind, "npx");
  assert.equal(npx.cmd, process.execPath);
  assert.equal(npx.baseArgs[1], "-y");
  assert.ok(npx.baseArgs[0].endsWith("npx-cli.js"));
  assert.equal(npxCliJsPath({ CODEBUDDY_NPX_PATH: "/custom/npx-cli.js" }), "/custom/npx-cli.js");
});

test("extractTurnError：Authentication required → 登录指引", () => {
  const msg = extractTurnError({
    errors: ["Authentication required. Please use /login command to sign in to your account"],
    fallback: "x",
  });
  assert.ok(msg.includes("未登录"));
  assert.ok(msg.includes("codebuddy.apiKey"));
  const plain = extractTurnError({ resultError: "额度不足", fallback: "fb" });
  assert.ok(plain.includes("额度不足"));
  assert.equal(extractTurnError({ stderrTail: "boom line\nlast", fallback: "fb" }), "CodeBuddy CLI: last");
});

test("凭据文件：0600 落盘 + patch 语义（缺省不动/空串清除/全空删文件）", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbc-cred-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeCred(dir, { apiKey: "sk-xxx", baseUrl: "https://gw.example.com/v1" });
    if (process.platform !== "win32") {
      const st = statSync(credPath(dir));
      assert.equal(st.mode & 0o777, 0o600); // POSIX 权限位语义；Windows 无 0600（ACL 另管），只验内容
    }
    assert.deepEqual(readCred(dir), { apiKey: "sk-xxx", baseUrl: "https://gw.example.com/v1" });
    // 缺省字段不动
    writeCred(dir, { authToken: "tok" });
    assert.deepEqual(readCred(dir), { apiKey: "sk-xxx", baseUrl: "https://gw.example.com/v1", authToken: "tok" });
    // 空串清除
    writeCred(dir, { baseUrl: "" });
    assert.deepEqual(readCred(dir), { apiKey: "sk-xxx", authToken: "tok" });
    // 全空删文件
    writeCred(dir, { apiKey: "", authToken: "" });
    assert.equal(readCred(dir), null);
    assert.equal(readCred(dir + "-absent"), null); // 无文件返回 null 不 throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTurnEnv：凭据注入 + 白名单起底（PATH/HOME 保留）+ extra 键（桥 URL）", () => {
  const env = buildTurnEnv({ apiKey: "sk-1", authToken: "tok-1", baseUrl: "https://gw/v1" });
  assert.equal(env.CODEBUDDY_API_KEY, "sk-1");
  assert.equal(env.CODEBUDDY_AUTH_TOKEN, "tok-1");
  assert.equal(env.CODEBUDDY_BASE_URL, "https://gw/v1");
  assert.ok(env.PATH, "PATH 应从白名单透传");
  assert.equal(buildTurnEnv(null).CODEBUDDY_API_KEY, undefined);
  const withBridge = buildTurnEnv(null, { AITI_BRIDGE_URL: "http://127.0.0.1:8777" });
  assert.equal(withBridge.AITI_BRIDGE_URL, "http://127.0.0.1:8777");
});

test("目录清单：--help 内置档齐全", () => {
  const ids = CBC_MODELS.map((m) => m.id);
  for (const must of ["default-model", "glm-5.3", "kimi-k2.6", "minimax-m3", "gpt-5.3-codex", "gemini-3.5-flash"]) {
    assert.ok(ids.includes(must), `缺 ${must}`);
  }
  assert.equal(DEFAULT_MODEL, "default-model");
});

test("stripAnsi：CSI/OSC/控制字符清理（保留 \n 与正文）", () => {
  const raw = "\x1b]0;title\x07登 录\x1b[?25l\x1b[2K\x1b[1;32m✔\x1b[0m site\r\nnext";
  assert.equal(stripAnsi(raw), "登 录✔ site\nnext");
  assert.equal(stripAnsi("plain"), "plain");
});

test("stripAnsi：OSC8 超链接还原 URL（TUI 打印授权链接形态）", () => {
  const raw = "Open \x1b]8;;https://sso.codebuddy.cn/oauth/authorize?c=1\x07this link\x1b]8;;\x07 now";
  const text = stripAnsi(raw);
  assert.ok(text.includes("https://sso.codebuddy.cn/oauth/authorize?c=1"), "URL 保留");
  assert.ok(!text.includes("\x1b]8"), "转义已剥");
});

test("extractCbcLoginUrl：SSO/OAuth 链接抓取（先到先得）+ 无关 URL 忽略", () => {
  const t = "请访问 https://tencent.sso.codebuddy.cn/oauth/authorize?client_id=abc&x=1 完成授权";
  assert.equal(extractCbcLoginUrl(stripAnsi(t)), "https://tencent.sso.codebuddy.cn/oauth/authorize?client_id=abc&x=1");
  assert.equal(extractCbcLoginUrl("see https://www.codebuddy.ai/docs and https://auth.example.com/signin?a=1"), "https://auth.example.com/signin?a=1");
  assert.equal(extractCbcLoginUrl("no urls here"), null);
  assert.equal(extractCbcLoginUrl("https://random.site/path"), null, "无 auth 提示词的链接不命中");
});

test("loginFingerprint：无 .codebuddy 返回 null；文件变化可感知", () => {
  const saved = process.env.AITI_CODEBUDDY_HOME;
  process.env.AITI_CODEBUDDY_HOME = "/nonexistent-cbg-home";
  assert.equal(loginFingerprint(), null);
  const dir = mkdtempSync(join(tmpdir(), "cbc-fp-"));
  try {
    process.env.AITI_CODEBUDDY_HOME = dir;
    assert.equal(loginFingerprint(), "-|-"); // settings.json 与 local_storage/ 均缺失 → "-"
    mkdirSync(join(dir, "local_storage"), { recursive: true });
    writeFileSync(join(dir, "settings.json"), "x");
    const fp1 = loginFingerprint();
    writeFileSync(join(dir, "local_storage", "entry_a.info"), "y");
    const fp2 = loginFingerprint();
    assert.notEqual(fp1, fp2, "local_storage 新增文件改变指纹");
  } finally {
    if (saved === undefined) delete process.env.AITI_CODEBUDDY_HOME; else process.env.AITI_CODEBUDDY_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CLI 侧登录态探测（浏览器 OAuth 落盘 *.info）──

const CLI_AUTH_JSON = JSON.stringify({
  account: { uid: "u-1", nickname: "李永", uin: "330116798388", type: "personal" },
  auth: {
    accessToken: "AT-xxx", refreshToken: "RT-xxx", tokenType: "Bearer",
    expiresAt: 1_794_456_115_736, refreshExpiresAt: 1_797_048_115_736,
  },
});

test("parseCliAuthFile：只吐展示字段（绝不返回 token）+ 过期判定", () => {
  const hit = parseCliAuthFile(CLI_AUTH_JSON, "/x/Tencent-Cloud.coding-copilot.info", 1_789_000_000_000);
  assert.equal(hit?.user, "李永");
  assert.equal(hit?.uin, "330116798388");
  assert.equal(hit?.expired, false, "refreshExpiresAt 未到 → 未过期");
  assert.equal(hit?.refreshExpiresAt, 1_797_048_115_736);
  assert.ok(!JSON.stringify(hit).includes("AT-xxx"), "token 绝不出现在结果里");

  assert.equal(parseCliAuthFile(CLI_AUTH_JSON, "/x/a.info", 1_799_000_000_000)?.expired, true, "refreshExpiresAt 已过 → 过期");
  assert.equal(parseCliAuthFile("not json", "/x/a.info"), null);
  assert.equal(parseCliAuthFile(JSON.stringify({ account: { nickname: "x" } }), "/x/a.info"), null, "无 token = 未登录");
  // access 过期但 refresh 有效 → 仍登录（CLI 自动续期）
  const accessExpired = JSON.stringify({ account: { nickname: "y" }, auth: { accessToken: "A", expiresAt: 1 } });
  assert.equal(parseCliAuthFile(accessExpired, "/x/a.info", 1_789_000_000_000)?.expired, true, "无 refresh → 以 expiresAt 判");
});

test("readCliAuth：扫 <数据根>/CodeBuddyExtension/Data/Public/auth/*.info（真实相对路径）", () => {
  assert.deepEqual(CBC_CLI_AUTH_REL, ["CodeBuddyExtension", "Data", "Public", "auth"]);
  const root = mkdtempSync(join(tmpdir(), "cbc-auth-"));
  const dir = join(root, ...CBC_CLI_AUTH_REL);
  try {
    // 空目录 / 目录不存在 → null
    assert.equal(readCliAuth({ existsSync: () => false, readdirSync: () => [], readFileSync: () => "" }), null);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Tencent-Cloud.coding-copilot.info"), CLI_AUTH_JSON);
    // 注入 fs：只认传入的根（codebuddyDataRoots 走 XDG_DATA_HOME）
    const saved = process.env.XDG_DATA_HOME; const savedLA = process.env.LOCALAPPDATA; const savedAD = process.env.APPDATA;
    process.env.XDG_DATA_HOME = root; process.env.LOCALAPPDATA = root; process.env.APPDATA = root;
    try {
      const hit = readCliAuth(undefined, 1_789_000_000_000);
      assert.equal(hit?.user, "李永");
      assert.equal(hit?.expired, false);
      assert.ok(hit?.file.endsWith("Tencent-Cloud.coding-copilot.info"));
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved;
      if (savedLA === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLA;
      if (savedAD === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAD;
    }

    // 坏 JSON 在前 → 跳过，取后一个有效文件
    writeFileSync(join(dir, "aaa-broken.info"), "{oops");
    const saved2 = process.env.XDG_DATA_HOME; const savedLA2 = process.env.LOCALAPPDATA; const savedAD2 = process.env.APPDATA;
    process.env.XDG_DATA_HOME = root; process.env.LOCALAPPDATA = root; process.env.APPDATA = root;
    try {
      assert.equal(readCliAuth(undefined, 1_789_000_000_000)?.user, "李永");
    } finally {
      if (saved2 === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = saved2;
      if (savedLA2 === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLA2;
      if (savedAD2 === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedAD2;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildLoginCommand：direct 直拼 / npx 通道 node+npx-cli 引号安全", () => {
  assert.equal(buildLoginCommand({ kind: "direct", cmd: "/usr/local/bin/cbc", baseArgs: [] }), "/usr/local/bin/cbc");
  const npx = buildLoginCommand({ kind: "npx", cmd: "/home/x/node", baseArgs: ["/opt/my tools/npx-cli.js", "-y", "@tencent-ai/codebuddy-code"] });
  assert.equal(npx, '/home/x/node "/opt/my tools/npx-cli.js" -y @tencent-ai/codebuddy-code');
  assert.equal(codebuddyHome(), process.env.AITI_CODEBUDDY_HOME || join(process.env.HOME || "", ".codebuddy"));
});
test("feedStdout：帧跨 chunk 边界 / 一 chunk 多帧 / result 置位 / 坏行跳过", () => {
  const init = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });
  const asst = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }], model: "m" } });
  const result = JSON.stringify({ type: "result", is_error: false, usage: {} });
  const frames = [];
  const onFrame = (f) => frames.push(f);
  const st = createFeedState();
  // 半帧断点（init 中间切 chunk，无换行——缓冲驻留）
  feedStdout(st, init.slice(0, 20), onFrame);
  assert.equal(frames.length, 0, "半帧不派发");
  feedStdout(st, init.slice(20) + "\n" + "not json\n", onFrame);
  assert.equal(frames.length, 1, "补全后半帧派发，坏行跳过");
  assert.equal(frames[0].subtype, "init");
  // 一 chunk 两帧（帧必须以换行收口才派发）
  feedStdout(st, asst + "\n" + result + "\n", onFrame);
  assert.equal(frames.length, 3);
  assert.equal(st.sawResult, true, "result 帧置位");
});

test("flushStdoutTail：无尾换行的 result 帧冲刷 + 空缓冲安全", () => {
  const st = createFeedState();
  const frames = [];
  const onFrame = (f) => frames.push(f);
  feedStdout(st, JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\n", onFrame);
  // result 不带换行（进程退出瞬态）
  feedStdout(st, JSON.stringify({ type: "result", is_error: false }));
  assert.equal(frames.length, 1);
  assert.equal(flushStdoutTail(st, onFrame), true, "尾帧冲刷并置位 sawResult");
  assert.equal(frames.length, 2);
  assert.equal(frames[1].type, "result");
  // 空缓冲安全
  assert.equal(flushStdoutTail(st, onFrame), false);
});

test("重放完整真实轮（init×2 + status + assistant + result error）：帧序保真", () => {
  const realTurn = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-abc", model: "default-model" }),
    JSON.stringify({ type: "system", subtype: "init", session_id: "s-abc", model: "default-model" }), // 双发（实测）
    JSON.stringify({ type: "system", subtype: "status", status: null }),
    JSON.stringify(ASSISTANT_FRAME),
    JSON.stringify(RESULT_ERROR_FRAME),
  ].join("\n");
  const frames = [];
  const st = createFeedState();
  feedStdout(st, realTurn + "\n", (f) => frames.push(f));
  assert.equal(frames.length, 5, "全部帧派发（含双 init）");
  assert.equal(st.sawResult, true);
  assert.equal(usageFromResult(frames[4]).contextWindow, 176000);
});

// ── stream-json 工具结果（user 帧 tool_result；2026-09-13 cbc 2.150.0 真机钉死）──
// 真机样本：cbc -p "用 Bash 运行 echo probe-ok" --output-format stream-json --verbose
const USER_TOOL_RESULT_FRAME = {
  type: "user",
  uuid: "01a09884-70f2-7d88-8aa3-e3bd4c018745",
  session_id: "01a09884-5d41-739c-a135-627612d454e9",
  message: {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: "chatcmpl-tool-a38f5b22e5306bf2",
      content: [{ type: "text", text: "Command: echo probe-ok\nStdout: probe-ok\n\nStderr: (empty)\nExit Code: 0\nSignal: (none)" }],
      is_error: false,
      _meta: { rawResponse: { exitCode: 0 } },
    }],
  },
  parent_tool_use_id: null,
};

test("toolResultsFromUserFrame：真机样本 → callId + 文本 + 非错误", () => {
  const out = toolResultsFromUserFrame(USER_TOOL_RESULT_FRAME);
  assert.equal(out.length, 1);
  assert.equal(out[0].callId, "chatcmpl-tool-a38f5b22e5306bf2");
  assert.equal(out[0].isError, false);
  assert.match(out[0].text, /Stdout: probe-ok/);
  assert.equal(out[0].text.startsWith("Command:"), true, "文本首尾已 trim");
  assert.equal(out[0].text.endsWith("(none)"), true);
});

test("toolResultsFromUserFrame：is_error / status=failed 双判定 + 多块一帧", () => {
  const frame = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "boom" }] },
        { type: "tool_result", tool_use_id: "t2", status: "failed", content: "raw-string-output" },
        { type: "text", text: "用户消息回显（非 tool_result，忽略）" },
      ],
    },
  };
  const out = toolResultsFromUserFrame(frame);
  assert.equal(out.length, 2, "只取 tool_result 块");
  assert.deepEqual(out.map((r) => r.callId), ["t1", "t2"]);
  assert.deepEqual(out.map((r) => r.isError), [true, true]);
  assert.equal(out[1].text, "raw-string-output", "content 为字符串也兼容");
});

test("toolResultsFromUserFrame：空/缺 id/非工具帧 → 安全兜底", () => {
  assert.deepEqual(toolResultsFromUserFrame({ type: "user", message: { content: [] } }), []);
  assert.deepEqual(toolResultsFromUserFrame({ type: "user" }), []);
  assert.deepEqual(toolResultsFromUserFrame({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }), []);
  const orphan = toolResultsFromUserFrame({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: "no id" }] }] } });
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].callId, "", "缺 tool_use_id → 空串孤儿兜底");
  assert.equal(orphan[0].text, "no id");
});

test("isolateCliLogin：登录前备份并移走 CLI auth + 托管凭据（只搬不删，0700）", () => {
  const root = mkdtempSync(join(tmpdir(), "cbc-isolate-"));
  const configDir = join(root, "cfg");
  const stateDir = join(root, "state");
  const authDir = join(root, ...CBC_CLI_AUTH_REL);
  mkdirSync(authDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(authDir, "Tencent-Cloud.coding-copilot.info"), '{"account":{"nickname":"A"}}');
  writeFileSync(join(configDir, "codebuddy-credentials.json"), '{"apiKey":"sk-1"}');

  const r = isolateCliLogin({ configDir, stateDir, roots: [root], now: 1_700_000_000_000 });
  assert.equal(r.moved.length, 2, "两个凭据文件均被移走");
  assert.ok(r.backupDir.startsWith(stateDir), "备份目录在 state 下");
  assert.equal(readFileSync(join(r.backupDir, "root1", "Tencent-Cloud.coding-copilot.info"), "utf8").includes("A"), true);
  assert.equal(readFileSync(join(r.backupDir, "managed-credentials.json"), "utf8").includes("sk-1"), true);
  assert.equal(existsSync(join(authDir, "Tencent-Cloud.coding-copilot.info")), false, "原位置已移走");
  assert.equal(existsSync(join(configDir, "codebuddy-credentials.json")), false, "托管凭据已移走");
  // 幂等：无凭据时 moved 为空
  const r2 = isolateCliLogin({ configDir, stateDir, roots: [root], now: 1_700_000_000_001 });
  assert.deepEqual(r2.moved, []);
  assert.equal(r2.backupDir, "");
  rmSync(root, { recursive: true, force: true });
});

test("fetchCbcQuota：官方 summary 归一化（多包求和 + 单位 + paid）", async () => {
  const fakeFetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: 0, msg: "OK", data: { Packages: [
      { PackageCode: "p1", CycleTotalCapacity: "1500", CycleRemainCapacity: "1500", CycleUsedCapacity: "0", CapacityUnit: "credits" },
      { PackageCode: "p2", CycleTotalCapacity: "500", CycleRemainCapacity: "485.13", CycleUsedCapacity: "14.87", CapacityUnit: "credits" },
    ], IsPaidUser: false } }),
  });
  const q = await fetchCbcQuota({ token: "t", uin: "1", domain: "www.codebuddy.cn", fetchImpl: fakeFetch });
  assert.equal(q.total, 2000);
  assert.equal(Math.round(q.remaining * 100) / 100, 1985.13);
  assert.equal(Math.round(q.used * 100) / 100, 14.87);
  assert.equal(q.unit, "credits");
  assert.equal(q.paid, false);
  assert.equal(q.packages.length, 2);
  assert.ok(q.fetchedAt > 0);
});

test("fetchCbcQuota：非 200 / code!=0 → throw（调用方回落错误态）", async () => {
  await assert.rejects(
    fetchCbcQuota({ token: "t", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }),
    /HTTP 401/,
  );
  await assert.rejects(
    fetchCbcQuota({ token: "t", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 10001, msg: "bad" }) }) }),
    /code=10001/,
  );
});
