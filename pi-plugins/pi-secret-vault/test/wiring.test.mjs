// Vault extension wiring: hooks + tools + /vault commands + handshake.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const OTHER = "9pQrStUvWx3y4z5A6b7C8d9E0f1";

// One HOME for the whole file: module-level path constants are resolved once
// (same as a real pi process), so tests share the sandbox home and vary only
// settings/vault content.
const HOME = mkdtempSync(join(tmpdir(), "vault-wiring-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
test.after(() => rmSync(HOME, { recursive: true, force: true }));

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

function makeCtx(cwd, opts = {}) {
  const notices = [];
  const inputs = [...(opts.inputs ?? [])];
  const ctx = {
    cwd,
    notices,
    sessionManager: { getSessionId: () => "sess-1" },
    ui: {
      notify: (text, level) => notices.push({ text, level }),
      input: async () => inputs.shift(),
      confirm: async () => true,
      editor: () => {},
    },
  };
  return ctx;
}

let loaded;
async function loadExtension() {
  if (!loaded) loaded = (await import("../src/index.ts")).default;
  return loaded;
}

function writeSettings(packages) {
  mkdirSync(join(HOME, ".pi", "agent"), { recursive: true });
  writeFileSync(join(HOME, ".pi", "agent", "settings.json"), JSON.stringify({ packages }));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("vault wiring: landing captures into the vault; tools and commands work", async () => {
  const home = HOME;
  {
    writeSettings([]);
    const cwd = join(home, "proj");
    mkdirSync(cwd, { recursive: true });
    const factory = await loadExtension();
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
    assert.ok(host.tools.has("vault_list"));
    assert.ok(host.tools.has("vault_get"));
    assert.ok(host.commands.has("vault"));
    assert.ok(host.commands.has("secret"));

    const ctx = makeCtx(cwd);
    await host.run("session_start", { reason: "startup" }, ctx);
    await tick();

    // landing=vault: the input hook stores the value encrypted and rewrites the
    // text to the STABLE token before the message becomes a session entry
    const input = await host.run("input", { text: `my token: ${SECRET}`, source: "interactive" }, ctx);
    assert.ok(input);
    assert.equal(input.action, "transform");
    assert.ok(!input.text.includes(SECRET));
    const inputToken = input.text.match(/rsec_[0-9a-f]{8}/)?.[0];
    assert.ok(inputToken);
    const vaultFileEarly = join(home, ".pi", "agent", "secret-vault", "global.json");
    assert.ok(existsSync(vaultFileEarly), "input landing created the vault");

    // landing=vault also covers values that reach context without the input hook
    const messages = [{ role: "user", content: `my token: ${SECRET}`, timestamp: 1 }];
    assert.ok(await host.run("context", { messages }, ctx));
    const ph = messages[0].content.match(/rsec_[0-9a-f]{8}/)?.[0];
    assert.ok(ph);
    const vaultFile = join(home, ".pi", "agent", "secret-vault", "global.json");
    assert.ok(existsSync(vaultFile), "vault file created by landing");
    const raw = readFileSync(vaultFile, "utf8");
    assert.ok(!raw.includes(SECRET), "value encrypted at rest");
    assert.match(raw, /auto-/);

    // message_end persists only the placeholder
    const replaced = await host.run("message_end", { message: { role: "user", content: SECRET, timestamp: 2 } }, ctx);
    assert.ok(replaced);
    assert.ok(!JSON.stringify(replaced.message).includes(SECRET));

    // vault_list never leaks; vault_get returns a token; tool_call restores it
    const list = await host.tools.get("vault_list").execute("t1", {}, null, null, ctx);
    assert.ok(!list.content[0].text.includes(SECRET));
    const alias = list.content[0].text.match(/auto-[A-Za-z0-9_-]+/)?.[0];
    assert.ok(alias, "alias listed");
    const got = await host.tools.get("vault_get").execute("t2", { alias }, null, null, ctx);
    const token = got.content[0].text.match(/rsec_[0-9a-f]{8}/)?.[0];
    assert.ok(token);
    assert.match(got.content[0].text, /working credential/);
    assert.match(got.content[0].text, /normal display form/);
    const toolInput = { command: `echo ${token}` };
    assert.equal(await host.run("tool_call", { input: toolInput }, ctx), undefined);
    assert.equal(toolInput.command, `echo ${SECRET}`);
    // unknown token blocked
    const blocked = await host.run("tool_call", { input: { command: "echo rsec_deadbeef" } }, ctx);
    assert.equal(blocked.block, true);

    // /vault add via masked input → list → get
    const addCtx = makeCtx(cwd, { inputs: [OTHER] });
    await host.commands.get("vault").handler("add manual-key manual entry", addCtx);
    assert.ok(addCtx.notices.at(-1).text.includes('added "manual-key"'));
    assert.ok(!addCtx.notices.at(-1).text.includes(OTHER));
    const listCtx = makeCtx(cwd);
    await host.commands.get("vault").handler("list", listCtx);
    assert.match(listCtx.notices.at(-1).text, /manual-key/);

    // session state file records mount names only
    await host.run("session_start", { reason: "reload" }, makeCtx(cwd));
    const stateFile = join(home, ".pi", "agent", "secret-vault", "session-state.json");
    assert.ok(existsSync(stateFile));
    const stateRaw = readFileSync(stateFile, "utf8");
    assert.ok(!stateRaw.includes(SECRET));
    assert.ok(!stateRaw.includes(OTHER));

    // tool_result reverse redaction keeps the value out of context
    const result = await host.run("tool_result", { content: [{ type: "text", text: SECRET }] }, ctx);
    assert.ok(result);
    assert.ok(!JSON.stringify(result).includes(SECRET));

    // audit evidence never contains values
    await host.commands.get("secret").handler("audit on", ctx);
    await host.run("before_provider_request", { payload: { messages: [{ role: "user", content: "clean" }] } }, ctx);
    const audit = readFileSync(join(home, ".pi", "agent", "secret-vault-audit.log"), "utf8");
    assert.ok(!audit.includes(SECRET));
  }
});

test("vault wiring: session record carries name/file; derived titles are redacted", async () => {
  {
    writeSettings([]);
    const cwd = join(HOME, "proj");
    const factory = await loadExtension();
    const host = makeHost();
    await factory(host.pi);
    const ctx = makeCtx(cwd);
    ctx.sessionManager = {
      getSessionId: () => "sess-named",
      getSessionName: () => "Named Session",
      getSessionFile: () => "/tmp/named.jsonl",
      getEntries: () => [],
    };
    await host.run("session_start", { reason: "startup" }, ctx);
    const stateFile = join(HOME, ".pi", "agent", "secret-vault", "session-state.json");
    let doc = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(doc.sessions["sess-named"].name, "Named Session");
    assert.equal(doc.sessions["sess-named"].file, "/tmp/named.jsonl");

    // no explicit name: first user message becomes a redacted title
    const ctx2 = makeCtx(cwd);
    ctx2.sessionManager = {
      getSessionId: () => "sess-derived",
      getSessionFile: () => "/tmp/derived.jsonl",
      getEntries: () => [{ type: "message", message: { role: "user", content: `my token: ${SECRET}` } }],
    };
    await host.run("session_start", { reason: "startup" }, ctx2);
    doc = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.ok(doc.sessions["sess-derived"].name);
    assert.ok(!doc.sessions["sess-derived"].name.includes(SECRET), "title is redacted");
    assert.match(doc.sessions["sess-derived"].name, /rsec_/);
  }
});

test("vault wiring: weak-value extraction, sensitive files and learn", async () => {
  {
    writeSettings([]);
    const cwd = join(HOME, "proj");
    const factory = await loadExtension();
    const host = makeHost();
    await factory(host.pi);
    const ctx = makeCtx(cwd);
    await host.run("session_start", { reason: "startup" }, ctx);
    await tick();
    const secretCmd = (line) => host.commands.get("secret").handler(line, ctx);

    // structured extraction from a .env read: value redacted, keys readable
    const cat = await host.run(
      "tool_result",
      { toolName: "bash", toolCallId: "c1", input: { command: "cat /tmp/proj/.env" }, content: [{ type: "text", text: "DB_PASSWORD=abc12345\nPORT=3000" }], isError: false },
      ctx,
    );
    assert.ok(cat);
    assert.ok(!JSON.stringify(cat).includes("abc12345"));
    assert.ok(JSON.stringify(cat).includes("DB_PASSWORD="));

    // dedicated secret file is withheld and registered
    const withheld = await host.run(
      "tool_result",
      { toolName: "bash", toolCallId: "c2", input: { command: "cat /tmp/secret.txt" }, content: [{ type: "text", text: "123abc" }], isError: false },
      ctx,
    );
    assert.ok(withheld);
    assert.match(withheld.content[0].text, /withheld/);
    assert.ok(!JSON.stringify(withheld).includes("123abc"));

    // block policy
    await secretCmd("files block");
    const blocked = await host.run("tool_call", { toolName: "read", toolCallId: "r1", input: { path: "/tmp/proj/.env" } }, ctx);
    assert.equal(blocked.block, true);
    await secretCmd("files learn");

    // weak candidate on the input boundary (vault landing transforms it)
    const input = await host.run("input", { text: "密码是123abc", source: "interactive" }, ctx);
    assert.ok(input);
    assert.equal(input.action, "transform");
    assert.ok(!input.text.includes("123abc"));
    assert.match(input.text, /rsec_[0-9a-f]{8}/);

    // explicit learn from a file
    const learnFile = join(HOME, "vault-learn.env");
    writeFileSync(learnFile, "API_TOKEN=xyz987654\n");
    await secretCmd(`learn ${learnFile}`);
    const learned = ctx.notices.at(-1).text;
    assert.match(learned, /learned 1/);
    assert.ok(!learned.includes("xyz987654"));
  }
});

test("vault wiring: mask handshake wins (mask yields, vault stays active)", async () => {
  {
    const cwd = join(HOME, "proj");
    writeSettings(["npm:@aiti-ai/pi-secret-mask@0.3.0"]);
    const factory = await loadExtension();
    const host = makeHost();
    await factory(host.pi);
    // mask 0.3 announces itself before/around session_start (both orders OK)
    host.pi.events.emit("aiti-secret:hello", { ext: "mask", active: true });
    const ctx = makeCtx(cwd);
    await host.run("session_start", { reason: "startup" }, ctx);
    await tick();
    const messages = [{ role: "user", content: `my token: ${SECRET}` }];
    assert.ok(await host.run("context", { messages }, ctx), "vault keeps working when mask yields");
    await host.commands.get("secret").handler("status", ctx);
    assert.match(ctx.notices.at(-1).text, /secret-mask: ON|secret-mask: [0-9]/);
    assert.ok(!/DISABLED/.test(ctx.notices.at(-1).text));
  }
});

test("vault wiring: legacy mask (no handshake) makes the vault yield", async () => {
  {
    const cwd = join(HOME, "proj");
    writeSettings(["npm:@aiti-ai/pi-secret-mask@0.2.3"]);
    const factory = await loadExtension();
    const host = makeHost();
    await factory(host.pi);
    const ctx = makeCtx(cwd);
    await host.run("session_start", { reason: "startup" }, ctx);
    await tick();
    assert.ok(ctx.notices.some((n) => /old pi-secret-mask/.test(n.text)));
    const messages = [{ role: "user", content: `my token: ${SECRET}` }];
    assert.equal(await host.run("context", { messages }, ctx), undefined, "vault disabled");
    await host.tools.get("vault_get").execute("t", { alias: "x" }, null, null, ctx);
    // command still informs the user
    await host.commands.get("secret").handler("status", ctx);
    assert.match(ctx.notices.at(-1).text, /DISABLED/);
  }
});

// Incident regression: a credential pasted in a chat-shaped sentence must be
// masked AND landed, whatever the phrasing. The original leak was
// `...，token <ark key>，报错 ...` — keyword, a space, the value, then Chinese // cjk-ok
// punctuation — which the old separator-enumerating rules never matched.
test("incident regression: chat phrasings reach the vault", async () => {
  const cwd = join(HOME, "proj-incident");
  mkdirSync(cwd, { recursive: true });
  writeSettings([]);
  const factory = await loadExtension();
  const host = makeHost();
  await factory(host.pi);
  const ctx = makeCtx(cwd);
  await host.run("session_start", { reason: "startup" }, ctx);
  await tick();

  const arkKey = "ark-1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d-9f8e";
  const opaque = "Zx8Kp2Lm9Qr4Tv7Wn3Yb6Cd1Fg7H"; // no known vendor prefix
  const cases = [
    `https://ark.cn-beijing.volces.com/api/plan/v3 豆包 无法使用，token ${arkKey}，报错 Failed (HTTP 404）`,
    `我的密钥是 ${opaque}`,
    `密钥如下：${opaque}`,
    opaque, // bare paste: nothing but the value
  ];

  for (const text of cases) {
    const res = await host.run("input", { text, source: "interactive" }, ctx);
    assert.ok(res, `input hook transformed: ${text.slice(0, 24)}`);
    assert.equal(res.action, "transform");
    assert.ok(!res.text.includes(arkKey) && !res.text.includes(opaque), "value removed from the prompt");
    assert.match(res.text, /rsec_[0-9a-f]{8}/);
  }

  // Every value must be retrievable from the vault (encrypted at rest), which is
  // what "the vault did not cache it" was about.
  const list = await host.tools.get("vault_list").execute("t", {}, null, null, ctx);
  const listed = JSON.stringify(list);
  assert.equal(listed.includes(arkKey), false, "vault_list never reveals a value");
  assert.equal(listed.includes(opaque), false, "vault_list never reveals a value");
  // one alias per distinct value: the incident key + the opaque one
  assert.ok(/4 alias/.test(listed), `expected four landed aliases, got ${listed.slice(0, 160)}`);

  // A later turn that contains the same values is redacted without the input hook.
  const messages = [{ role: "user", content: `retry with ${arkKey} and ${opaque}` }];
  const ctxRes = await host.run("context", { messages }, ctx);
  assert.ok(ctxRes, "context hook redacted a known value");
  assert.ok(!JSON.stringify(messages).includes(arkKey));
  assert.ok(!JSON.stringify(messages).includes(opaque));
});

// The web pre-send gate stores the value and substitutes the *stable* vault
// placeholder. This process never saw that mount, so the input/context hooks
// must resolve it from the vault on demand — otherwise the guard (correctly)
// refuses to run with an unmounted token.
test("preflight tokens: a web-masked message mounts from the vault on arrival", async () => {
  const cwd = join(HOME, "proj-preflight");
  mkdirSync(cwd, { recursive: true });
  writeSettings([]);
  const factory = await loadExtension();
  const host = makeHost();
  await factory(host.pi);
  const ctx = makeCtx(cwd);
  await host.run("session_start", { reason: "startup" }, ctx);
  await tick();

  const { VaultStore } = await import("@aiti-ai/secret-vault-core");
  const { preflightMask } = await import("@aiti-ai/secret-vault-core");
  const store = new VaultStore({ cwd });
  const secret = "ark-7f7f7f7f-1111-4222-8333-944455556666-abc1";
  const masked = preflightMask(store, `看下这个 ${secret} 能用吗`, [0]);
  assert.ok(!masked.text.includes(secret));
  const token = masked.text.match(/rsec_[0-9a-f]{8}/)?.[0];
  assert.ok(token, masked.text);

  // arriving message: hook must mount the alias behind the stable token
  await host.run("input", { text: masked.text, source: "interactive" }, ctx);
  const call = await host.run("tool_call", { toolName: "bash", input: { command: `curl -H "x-key: ${token}"` } }, ctx);
  assert.equal(call, undefined, "guard no longer blocks the token");
  const restored = `curl -H "x-key: ${token}"`;
  const input = { command: restored };
  await host.run("tool_call", { toolName: "bash", input }, ctx);
  assert.ok(input.command.includes(secret), "token restored to the real value");
});

test("tool_result extract never registers encoded forms of mounted values", async () => {
  const home = HOME;
  {
    writeSettings([]);
    const cwd = join(home, "proj-extract");
    mkdirSync(cwd, { recursive: true });
    const factory = await loadExtension();
    const host = makeHost();
    await factory(host.pi);
    const ctx = makeCtx(cwd);
    await host.run("session_start", { reason: "startup" }, ctx);
    await tick();

    // mount one value via the input hook (landing=vault default)
    const input = await host.run("input", { text: `my token: ${SECRET}`, source: "interactive" }, ctx);
    assert.ok(input);
    const token = input.text.match(/rsec_[0-9a-f]{8}/)?.[0];
    assert.ok(token);

    const list = async () => {
      const c = makeCtx(cwd);
      await host.commands.get("secret").handler("list", c);
      return c.notices.map((n) => n.text).join("\n");
    };
    const before = await list();

    // bash-style output carrying the base64 form of the mounted value
    const encoded = Buffer.from(SECRET).toString("base64");
    const res = await host.run(
      "tool_result",
      { toolName: "bash", content: [{ type: "text", text: `api_key = ${encoded}` }] },
      ctx,
    );
    assert.ok(res, "encoded form should be redacted");
    const outText = JSON.stringify(res);
    assert.ok(!outText.includes(encoded), "encoded form must not survive");
    assert.ok(outText.includes(token), "replaced with the mounted placeholder");

    // the core regression: extract ran on the redacted text, so no junk
    // auto entry for the encoded form was registered — list is unchanged
    assert.equal(await list(), before);
  }
});

test("a stray token from another session still gets the usage contract", async () => {
  // A token the model copied out of a foreign transcript (nothing mounted here):
  // the section must still explain it so the model stops treating it as damage.
  writeSettings([]);
  // Build the token by concatenation: a literal token in this file would be rewritten by
  // the masking layer while the test file itself is read or edited.
  const strayToken = "rsec_" + "cf1e2d3a";
  const cwd = join(HOME, "proj-stray");
  mkdirSync(cwd, { recursive: true });
  const factory = await loadExtension();
  const host = makeHost();
  await factory(host.pi);
  const ctx = makeCtx(cwd);
  await host.run("session_start", { reason: "startup" }, ctx);
  await tick();

  const sections = {};
  await host.run("input", { text: `why did I write ${strayToken} there?`, source: "interactive" }, ctx);
  await host.run("before_agent_start", { systemPromptOptions: { sections } }, ctx);
  assert.match(sections.secret_masking ?? "", /normal output of the masking layer/);
  assert.match(sections.secret_masking ?? "", /not that you broke it/);
});
