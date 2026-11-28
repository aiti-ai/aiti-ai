/**
 * aiti-editor read-only provider for CodeHub remote copies.
 *
 * Remote files are materialized as read-only cache copies (path contains
 * "/aiti-codehub/remote/"); this provider matches only those paths and renders
 * Monaco with readOnly: true. Editing/saving stays on local clones.
 */
import { t } from "./host-shim";
import { ensureMaterialized } from "./host-shim";

let registered = false;

export function registerReadOnlyEditor(): boolean {
  if (registered) return true;
  const we = (window as any).__aitiEditor;
  if (!we?.registerEditorProvider) return false;
  try {
    we.registerEditorProvider({
      id: "aiti-codehub.remote",
      displayName: "CodeHub Remote (read-only)",
      sourceExt: "aiti-codehub",
      selector: ["**/aiti-codehub/remote/**"],
      priority: "override",
      capabilities: ["preview"],
      defaultCapability: "preview",
      about: { summary: "CodeHub remote file (read-only copy)" },
      render: (host: any, content: any) => {
        const el = document.createElement("div");
        el.style.cssText = "height:100%;width:100%;min-height:200px;";
        let dispose = () => { /* not ready */ };
        void host.readFile().then((r: { data: ArrayBuffer }) => {
          const text = new TextDecoder().decode(r.data);
          return host.loadMonaco().then((monaco: any) => {
            const ext = String(content?.filePath || "").split(".").pop()?.toLowerCase() || "";
            const lang: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", json: "json", md: "markdown", css: "css", html: "html", vue: "html", py: "python", java: "java", go: "go", rs: "rust", sh: "shell", yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql" };
            const model = monaco.editor.createModel(text, lang[ext] || "plaintext");
            const ed = monaco.editor.create(el, {
              model, readOnly: true, automaticLayout: true, fontSize: 12.5,
              scrollBeyondLastLine: false, minimap: { enabled: false },
              wordWrap: "off", renderLineHighlight: "none",
            });
            dispose = () => { try { ed.dispose(); } catch { /* ignore */ } try { model.dispose(); } catch { /* ignore */ } el.remove(); };
          });
        }).catch((e: any) => { el.textContent = t("ch.editor.copyFail", { err: String(e?.message || e) }); });
        return { el, dispose: () => dispose() };
      },
    });
    registered = true;
    return true;
  } catch {
    return false;
  }
}

/** Register now, or wait for the editor registry (event-driven, 1.5s guard) before opening. */
export async function ensureReadOnlyEditor(): Promise<boolean> {
  if (registerReadOnlyEditor()) return true;
  try { await ensureMaterialized("aiti-editor"); } catch { /* ignore */ }
  if (registerReadOnlyEditor()) return true;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    const timer = setTimeout(finish, 1500);
    try {
      window.addEventListener("aiti-editor:registry-ready", () => { clearTimeout(timer); finish(); }, { once: true });
    } catch { clearTimeout(timer); finish(); }
  });
  return registerReadOnlyEditor();
}
