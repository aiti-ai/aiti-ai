// Hook wiring smoke test: drive the extension factory with a mock pi host.
// (Complements the engine tests; no model/provider needed.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

function makeHost() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const bus = new Map();
  const pi = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    events: {
      on(name, cb) {
        if (!bus.has(name)) bus.set(name, []);
        bus.get(name).push(cb);
      },
      emit(name, data) {
        for (const cb of bus.get(name) ?? []) cb(data);
      },
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
  const run = async (name, event, ctx) => {
    let out;
    for (const fn of handlers.get(name) ?? []) {
      const res = await fn(event, ctx);
      if (res !== undefined) out = res;
    }
    return out;
  };
  return { pi, handlers, commands, tools, bus, run };
}

function makeCtx(cwd, overrides = {}) {
  const notices = [];
  const ctx = {
    cwd,
    notices,
    sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined },
    ui: {
      notify: (text, level) => notices.push({ text, level }),
      input: async () => undefined,
      confirm: async () => true,
      editor: () => {},
    },
    ...overrides,
  };
  return ctx;
}

async function loadExtension(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const mod = await import(`../src/index.ts?home=${encodeURIComponent(home)}&t=${Date.now()}`);
  return mod.default;
}

test("mask wiring: send-boundary redaction, guard/restore, message_end, compact, provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "mask-wiring-"));
  try {
    const cwd = join(home, "proj");
    const factory = await loadExtension(home);
    const host = makeHost();
    await factory(host.pi);
    for (const hook of [
      "session_start",
      "context",
      "context_with_system",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "message_end",
      "session_before_compact",
      "session_before_tree",
      "user_bash",
      "before_provider_request",
    ]) {
      assert.ok(host.handlers.has(hook), `hook ${hook} registered`);
    }
    assert.ok(host.commands.has("secret"));

    const ctx = makeCtx(cwd);
    await host.run("session_start", { reason: "startup" }, ctx);

    // 1) user text auto-detects + redacts
    const messages = [{ role: "user", content: `my token: ${SECRET}`, timestamp: 1 }];
    const changed = await host.run("context", { messages }, ctx);
    assert.ok(changed);
    const ph = messages[0].content.match(/rsec_[0-9a-f]{8}/)?.[0];
    assert.ok(ph, "placeholder replaced the value");
    assert.ok(!messages[0].content.includes(SECRET));

    // 2) section contract injected
    const sections = {};
    await host.run("before_agent_start", { systemPromptOptions: { sections } }, ctx);
    assert.match(sections.secret_masking, /working credential/);

    // 3) tool_call restores; unknown placeholder is blocked
    const input = { command: `curl -H "Authorization: Bearer ${ph}"` };
    assert.equal(await host.run("tool_call", { input }, ctx), undefined);
    assert.ok(input.command.includes(SECRET));
    const blocked = await host.run("tool_call", { input: { command: "echo rsec_deadbeef" } }, ctx);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /vault_get|secret add/);

    // 4) tool_result reverse redaction
    const result = await host.run("tool_result", { content: [{ type: "text", text: `echo ${SECRET}` }], details: { stdout: SECRET } }, ctx);
    assert.ok(result);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.ok(JSON.stringify(result).includes(ph));

    // 5) landing plain → message_end is a no-op; ephemeral → input + message_end redact
    assert.equal(await host.run("message_end", { message: { role: "user", content: SECRET, timestamp: 2 } }, ctx), undefined);
    assert.equal((await host.run("input", { text: `my token: ${SECRET}`, source: "interactive" }, ctx)).action, "continue", "plain input untouched");
    await host.commands.get("secret").handler("landing ephemeral", ctx);
    const transformed = await host.run("input", { text: `my token: ${SECRET}`, source: "interactive" }, ctx);
    assert.ok(transformed);
    assert.equal(transformed.action, "transform");
    assert.ok(!transformed.text.includes(SECRET), "input redacted before the message is persisted");
    const replaced = await host.run("message_end", { message: { role: "user", content: SECRET, timestamp: 3 } }, ctx);
    assert.ok(replaced);
    assert.equal(replaced.message.role, "user");
    assert.ok(!JSON.stringify(replaced.message).includes(SECRET));

    // 6) compaction / tree preparation scrubbing
    const prep = { messagesToSummarize: [{ role: "user", content: SECRET }], turnPrefixMessages: [], previousSummary: SECRET };
    await host.run("session_before_compact", { preparation: prep }, ctx);
    assert.ok(!JSON.stringify(prep).includes(SECRET));
    const treePrep = { entriesToSummarize: [{ message: { role: "user", content: SECRET } }] };
    await host.run("session_before_tree", { preparation: treePrep }, ctx);
    assert.ok(!JSON.stringify(treePrep).includes(SECRET));

    // 7) `!` command warn / strict block
    const warn = await host.run("user_bash", { command: `export K=${SECRET}` }, ctx);
    assert.equal(warn, undefined);
    assert.ok(ctx.notices.some((n) => /registered secret/.test(n.text)));
    await host.commands.get("secret").handler("strict on", ctx);
    const blockedBash = await host.run("user_bash", { command: `export K=${SECRET}` }, ctx);
    assert.equal(blockedBash.result.exitCode, 1);

    // 8) provider rewrite safety net + audit
    const payload = { messages: [{ role: "user", content: `leak ${SECRET}` }] };
    const rewritten = await host.run("before_provider_request", { payload }, ctx);
    assert.ok(rewritten);
    assert.ok(!JSON.stringify(rewritten).includes(SECRET));
    await host.commands.get("secret").handler("audit on", ctx);
    await host.run("before_provider_request", { payload: { messages: [{ role: "user", content: "clean" }] } }, ctx);
    const log = join(home, ".pi", "agent", "secret-mask-audit.log");
    assert.ok(existsSync(log));
    assert.ok(readFileSync(log, "utf8").includes("placeholders"));

    // 9) status reports landing + guard
    await host.commands.get("secret").handler("status", ctx);
    const status = ctx.notices.at(-1).text;
    assert.match(status, /landing ephemeral/);
    assert.match(status, /guard ON/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mask wiring: yields to the vault handshake", async () => {
  const home = mkdtempSync(join(tmpdir(), "mask-wiring-2-"));
  try {
    const factory = await loadExtension(home);
    const host = makeHost();
    await factory(host.pi);
    const ctx = makeCtx(join(home, "proj"));
    await host.run("session_start", { reason: "startup" }, ctx);
    // vault announces itself
    host.pi.events.emit("aiti-secret:hello", { ext: "vault", active: true });
    const messages = [{ role: "user", content: `my token: ${SECRET}` }];
    assert.equal(await host.run("context", { messages }, ctx), undefined, "redaction disabled");
    await host.commands.get("secret").handler("status", ctx);
    assert.match(ctx.notices.at(-1).text, /DISABLED \(by pi-secret-vault\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
