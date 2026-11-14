import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-cache-miss-notices-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
// The pi-web host injects API_ALLOW_ORIGINS=* (and PI_WEB_BASE_DOMAIN etc.) into
// child sessions; that widens isApiRequestAllowed and breaks the security
// assertions below. Tests must run from the zero-config baseline.
const savedHostEnv = {};
for (const key of ["API_ALLOW_ORIGINS", "PI_WEB_BASE_DOMAIN", "PI_WEB_ALLOWED_HOSTS", "PI_WEB_HOSTNAME"]) {
  savedHostEnv[key] = process.env[key];
  delete process.env[key];
}
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  for (const [key, value] of Object.entries(savedHostEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

const settingsPath = path.join(agentDir, "settings.json");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/cache-miss-notices", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("switches pi's showCacheMissNotices in the global settings, keeping other keys", async () => {
  assert.deepEqual(await (await GET()).json(), { enabled: false });
  // Off without a settings file is pi's default already: no file appears.
  assert.deepEqual(await (await put({ enabled: false })).json(), { enabled: false });
  await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });

  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  const on = await put({ enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { enabled: true });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m", showCacheMissNotices: true });
  assert.deepEqual(await (await GET()).json(), { enabled: true });

  // Off is pi's default: the key goes.
  const off = await put({ enabled: false });
  assert.deepEqual(await off.json(), { enabled: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
});

test("refuses what is not a boolean, a foreign origin and a non-JSON body", async () => {
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "m" }));
  assert.equal((await put({ enabled: "yes" })).status, 400);
  assert.equal((await put("{")).status, 400);
  assert.equal((await put({ enabled: true }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put({ enabled: true }, { host: "localhost", origin: "https://evil.example", "Content-Type": "application/json" })).status, 403);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { defaultModel: "m" });
});
