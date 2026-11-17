#!/usr/bin/env node
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
await build({
  entryPoints: ["client/src/index.js"], bundle: true, format: "esm", platform: "browser",
  target: ["es2020"], outfile: "dist/aiti-msg-share-client.mjs", logLevel: "warning",
  banner: { js: "// aiti-msg-share client bundle — built by tools/build-client.mjs. Do not edit." },
});
console.log("[aiti-msg-share] client bundle → dist/aiti-msg-share-client.mjs");
