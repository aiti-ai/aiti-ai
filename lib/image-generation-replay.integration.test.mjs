import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { replayImageProviders, resetImageProviders, registerImageProvider, imageProviderRegistrations } = await jiti.import("./image-generation.ts");

/** Minimal image-model provider: registers a `type:"image"` model + an images impl. */
function imageProviderExtension(register) {
  return {
    name: "test-image-providers",
    builtin: true,
    async factory(pi) {
      replayImageProviders(pi);
      void register;
    },
  };
}

test("image providers registered by an extension are replayed onto a fresh runtime", { timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "piweb-img-provider-"));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: {} }), "utf8");
    resetImageProviders();

    const reg = await registerImageProvider("demo-ext", "demo-images", {
      baseUrl: "https://example.test/v1",
      apiKey: "test-placeholder-key",
      models: [{ type: "image", id: "demo-img", name: "Demo", api: "demo-images-api", input: ["text"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      images: {
        "demo-images-api": {
          async generateImages(model) {
            return {
              api: "demo-images-api", provider: model.provider, model: model.id,
              output: [{ type: "image", mimeType: "image/png", data: "QUJD" }],
              stopReason: "stop", timestamp: Date.now(),
            };
          },
        },
      },
    });
    // No runtime was built yet in this process: the ledger is the only holder.
    assert.deepEqual(imageProviderRegistrations(), [{ extId: "demo-ext", name: "demo-images" }]);
    assert.equal(typeof reg.ok, "boolean");

    const services = await createAgentSessionServices({
      cwd: dir,
      agentDir: dir,
      resourceLoaderOptions: { extensionFactories: [imageProviderExtension()], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    const runtime = services.modelRuntime;
    const images = runtime.getModelsOfType("image");
    const mine = images.find((m) => m.provider === "demo-images" && m.id === "demo-img");
    assert.ok(mine, `registered image model missing (got: ${images.map((m) => `${m.provider}/${m.id}`).join(",") || "none"})`);
    assert.deepEqual(mine.output, ["image"]);

    // The chat list must not expose it.
    const chat = runtime.getModelsOfType("chat");
    assert.ok(!chat.some((m) => m.id === "demo-img"), "image model leaked into the chat list");

    resetImageProviders();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
