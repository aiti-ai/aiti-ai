import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Exercises the Gitee mirror against a local mock of both APIs:
 * GitHub release notes, Gitee release creation, attachment replacement/upload.
 */
test("publish-gitee mirrors release assets and notes", async () => {
  const uploads = [];
  let createBody = "";
  const server = createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on("data", (chunk) => {
      body = Buffer.concat([body, chunk]);
    });
    req.on("end", () => {
      const url = req.url || "";
      if (req.method === "GET" && url.startsWith("/github/repos/aiti-ai/aiti-ai/releases/tags/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ body: "Release notes from GitHub" }));
        return;
      }
      if (req.method === "GET" && url.startsWith("/gitee/repos/aiti-ai/aiti-ai/releases/tags/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"message":"not found"}');
        return;
      }
      if (req.method === "POST" && url === "/gitee/repos/aiti-ai/aiti-ai/releases") {
        createBody = body.toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 7, tag_name: "aiti-desktop-widget-v0.2.0" }));
        return;
      }
      if (req.method === "GET" && url.includes("/attach_files")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.method === "POST" && url.includes("/attach_files")) {
        const text = body.toString("latin1");
        const match = /filename="([^"]+)"/.exec(text) || /name="file"; filename="([^"]+)"/.exec(text);
        const name = match ? match[1] : "unknown";
        uploads.push(name);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name }));
        return;
      }
      res.writeHead(404);
      res.end("no");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const assets = mkdtempSync(join(tmpdir(), "gitee-assets-"));
  writeFileSync(join(assets, "aiti-desktop-widget-linux-x64"), "binary");
  writeFileSync(join(assets, "checksums.txt"), `${"a".repeat(64)}  aiti-desktop-widget-linux-x64\n`);

  try {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./publish-gitee.mjs", import.meta.url)),
        "--tag",
        "aiti-desktop-widget-v0.2.0",
        "--assets-dir",
        assets,
      ],
      {
        env: {
          ...process.env,
          AITI_GITEE_TOKEN: "test-token",
          AITI_GITEE_API_BASE: `http://127.0.0.1:${port}/gitee`,
          AITI_GITHUB_API_BASE: `http://127.0.0.1:${port}/github`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `stderr=${stderr}\nstdout=${stdout}`);
    assert.deepEqual(uploads.sort(), ["aiti-desktop-widget-linux-x64", "checksums.txt"]);
    const params = new URLSearchParams(createBody);
    assert.equal(params.get("tag_name"), "aiti-desktop-widget-v0.2.0");
    assert.equal(params.get("name"), "aiti-desktop-widget v0.2.0");
    assert.match(params.get("body") || "", /Release notes from GitHub/);
    assert.equal(params.get("access_token"), "test-token");
  } finally {
    rmSync(assets, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
