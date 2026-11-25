/**
 * aiti-word-superdoc client build (Vite lib mode).
 *
 * entry (thin shell) → client/aiti-word-superdoc-client.mjs;
 * SuperDoc + vue + yjs and friends → dynamically imported chunks, fetched only
 * when a .docx is actually opened.
 *
 * SuperDoc's dist keeps vue/yjs as bare specifiers, so they have to be inlined
 * here. node_modules is grouped **by package** rather than into one catch-all
 * chunk: after superdoc 2.34 grew its DOCX engine, a single chunk reached
 * 26.6MB, which (a) breaks hosts with a per-file upload cap (EdgeOne Makers
 * free plan rejects anything over 25MB) and (b) dragged optional surfaces such
 * as pdfjs into the same file. Per-package grouping keeps every module in
 * exactly one chunk (still one instance per module) while the largest file
 * stays around 21.9MB (@superdoc/docx-engine).
 */
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Owning npm package of a module id — used as the chunk key. Returning the same
 * name for every module of a package never duplicates a module; it only decides
 * which chunk file it lands in.
 */
function packageOf(id: string): string | null {
  const at = id.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const rest = id.slice(at + "node_modules/".length);
  const parts = rest.split("/");
  return rest.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

export default defineConfig({
  // Relative base: the worker entry (new Worker(new URL(...))) must resolve
  // relative to the chunk itself — extension assets live under
  // /{basePath}/api/extensions/<id>/assets/, so an absolute /assets/ would hit
  // the page root instead.
  base: "./",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: fileURLToPath(new URL("client/src/entry.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "aiti-word-superdoc-client.mjs",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [],
      output: {
        // [name] keeps the package visible in the file name (engine/vue/pdfjs…)
        chunkFileNames: "aiti-word-superdoc-[name]-[hash].mjs",
        assetFileNames: "aiti-word-superdoc-[name][extname]",
        // hex hash: the default charset includes "-" (e.g. chunk-C-XYOkSV) and
        // does not match the host's HASHED_ASSET_RE (/-[A-Za-z0-9_]{8}\.\w+$/,
        // pi-web app/api/extensions/[...path]/route.ts) → those chunks miss
        // immutable caching and re-validate on every page open.
        hashCharacters: "hex",
        manualChunks(id) {
          const pkg = packageOf(id);
          if (!pkg) return undefined;
          if (pkg.startsWith("pdfjs-dist")) return "pdfjs";
          if (pkg.startsWith("@superdoc/")) return "engine";
          if (pkg === "superdoc") return "superdoc";
          if (pkg === "vue" || pkg.startsWith("@vue/")) return "vue";
          if (pkg === "yjs" || pkg === "lib0" || pkg.startsWith("y-")) return "yjs";
          if (pkg === "konva") return "konva";
          return "vendor";
        },
      },
    },
  },
});
