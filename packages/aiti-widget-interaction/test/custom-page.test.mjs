import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { InteractionBroker, startInteractionServer, withInteractionParams } from "../dist/index.js";

test("custom pages get the broker base and token appended", () => {
  const url = new URL(withInteractionParams("http://127.0.0.1:9000/custom.html?theme=dark", "http://127.0.0.1:4567", "tok-1"));
  assert.equal(url.origin, "http://127.0.0.1:9000");
  assert.equal(url.pathname, "/custom.html");
  assert.equal(url.searchParams.get("theme"), "dark");
  assert.equal(url.searchParams.get("base"), "http://127.0.0.1:4567/");
  assert.equal(url.searchParams.get("token"), "tok-1");

  const noToken = new URL(withInteractionParams("http://localhost:9000/x.html", "http://localhost:4567/"));
  assert.equal(noToken.searchParams.get("token"), null);

  assert.throws(() => withInteractionParams("custom.html", "http://127.0.0.1:4567/"), /Invalid URL/);
});

test("static page assets are importable from another loopback origin", async () => {
  const broker = new InteractionBroker();
  const handle = await startInteractionServer({ broker, port: 0, token: "t" });
  try {
    const client = await fetch(`${handle.baseUrl}interaction-client.js`);
    assert.equal(client.status, 200);
    // Module scripts are fetched with CORS, and custom pages live on another origin.
    assert.equal(client.headers.get("access-control-allow-origin"), "*");
    assert.match(client.headers.get("content-type"), /javascript/);
    // The example ships inside page/ but is served by the *host*, not the broker.
    const example = readFileSync(new URL("../page/custom-example.html", import.meta.url), "utf8");
    assert.match(example, /connectInteraction/);
    assert.match(example, /interaction-client\.js/);
  } finally {
    await handle.close();
    broker.close();
  }
});

test("a custom page answers a host request through the client protocol", async () => {
  const broker = new InteractionBroker({ idFactory: () => "custom-1" });
  const handle = await startInteractionServer({ broker, port: 0, token: "custom-token" });
  try {
    const pending = broker.ask({ kind: "custom", title: "Review", message: "Ship it?", actions: [{ id: "approve", label: "Ship" }, { id: "reject", label: "Hold" }] });
    // Same wire calls the client module makes from the custom page origin.
    const body = await fetch(`${handle.baseUrl}interactions/pending?token=custom-token`).then((r) => r.json());
    assert.equal(body.requests[0].kind, "custom");
    const answered = await fetch(`${handle.baseUrl}interactions/custom-1/answer?token=custom-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", approved: true, value: { source: "custom-example" } }),
    });
    assert.equal(answered.status, 200);
    const result = await pending;
    assert.equal(result.status, "answered");
    assert.equal(result.action, "approve");
    assert.deepEqual(result.value, { source: "custom-example" });
  } finally {
    await handle.close();
    broker.close();
  }
});
