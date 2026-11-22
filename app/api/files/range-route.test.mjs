import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-range-")));
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { GET, POST } = await jiti.import("./[...path]/route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
allowFileRoot(root);

test("download ranges require at least one bound and preserve valid suffix/open ranges", async () => {
  // Fork contract: file paths never enter URLs — exchange the path for a short
  // ticket (POST /api/files/ticket), then GET /api/files/_t/<ticket> with the
  // Range header.
  const file = path.join(root, "download.txt");
  fs.writeFileSync(file, "abcdef");
  const request = async (range) => {
    const issued = await POST(new NextRequest("http://localhost/api/files/ticket", {
      method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ path: file, type: "download" }),
    }), { params: Promise.resolve({ path: ["ticket"] }) });
    assert.equal(issued.status, 200);
    const ticket = (await issued.json()).ticket;
    return GET(new NextRequest(`http://localhost/api/files/_t/${ticket}`, { headers: { range } }), {
      params: Promise.resolve({ path: ["_t", ticket] }),
    });
  };
  const invalid = await request("bytes=-");
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get("content-range"), "bytes */6");
  for (const [range, content] of [["bytes=-2", "ef"], ["bytes=2-", "cdef"], ["bytes=1-3", "bcd"]]) {
    const response = await request(range);
    assert.equal(response.status, 206);
    assert.equal(await response.text(), content);
  }
});
