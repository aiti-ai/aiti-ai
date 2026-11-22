#!/usr/bin/env node
/**
 * aiti-dialog — cross-platform zenity replacement backed by aiti-desktop-widget.
 *
 * Usage:
 *   aiti-dialog confirm --text "Continue?" [--ok-label OK] [--cancel-label Cancel]
 *   aiti-dialog --dialog confirm --text "Continue?"
 *   aiti-dialog input --text "Name:" [--default foo] [--password]
 *   aiti-dialog choose --text "Pick" --options "A,B,C"
 *   aiti-dialog file [--multiple] [--filter "*.png"]
 *   aiti-dialog directory
 *   aiti-dialog notify --text "Done" [--timeout 5]
 *   aiti-dialog custom --page http://127.0.0.1:PORT/page.html
 *   aiti-dialog --daemon [--port 18095] [--ttl 600]
 *
 * Exit codes (zenity-compatible): 0 answered, 1 cancelled, 5 timeout,
 * 2 usage error, 4 runtime error (no window / no widget binary).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  InteractionBroker,
  InteractionWidgetWindow,
  dialogExitCode,
  dialogStdout,
  dialogToRequest,
  dialogWindowSize,
  dialogWindowTitle,
  startInteractionServer,
  withInteractionParams,
} from "../dist/index.js";

const KINDS = new Set(["confirm", "choose", "input", "file", "directory", "notify", "custom"]);
const VALUE_FLAGS = new Set([
  "text", "title", "detail", "ok-label", "cancel-label", "options", "option",
  "default", "placeholder", "filter", "timeout", "page", "width", "height",
  "x", "y", "display", "widget-bin", "port", "token", "ttl",
]);
const BOOL_FLAGS = new Set(["json", "password", "multiple", "daemon", "no-window", "center", "help", "version"]);

function usage(code = 0) {
  const text = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  const start = text.indexOf("## CLI");
  const end = text.indexOf("\n## ", start + 4);
  process.stderr.write(`${start >= 0 ? text.slice(start, end > 0 ? end : undefined) : "see README.md"}\n`);
  process.exit(code);
}

function version() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  process.stdout.write(`aiti-dialog ${pkg.version}\n`);
  process.exit(0);
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  const list = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { list.push(arg); continue; }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inline = eq >= 0 ? body.slice(eq + 1) : null;
    if (VALUE_FLAGS.has(name)) {
      const value = inline !== null ? inline : (argv[i + 1] && !argv[i + 1].startsWith("--") ? (i += 1, argv[i]) : "");
      if (name === "option") (values.option ||= []).push(value);
      else values[name] = value;
    } else if (BOOL_FLAGS.has(name)) {
      flags.add(name);
    } else {
      process.stderr.write(`aiti-dialog: unknown option --${name}\n`);
      process.exit(2);
    }
  }
  return { values, flags, list };
}

function exitWith(code, message) {
  if (message) process.stderr.write(`aiti-dialog: ${message}\n`);
  process.exit(code);
}

async function runOnce(spec, values, flags) {
  const broker = new InteractionBroker();
  const size = dialogWindowSize(spec);
  const server = await startInteractionServer({ broker, port: 0 });
  const win = new InteractionWidgetWindow({
    bin: values["widget-bin"],
    width: Number(values.width) || size.width,
    height: Number(values.height) || size.height,
    title: dialogWindowTitle(spec),
  });

  let pageUrl = server.url;
  if (spec.page) {
    let page;
    try {
      page = new URL(spec.page);
    } catch {
      await server.close();
      broker.close();
      exitWith(2, `--page must be an absolute loopback URL (got ${JSON.stringify(spec.page)})`);
    }
    // A remote page would receive the broker token (it rides in the URL), so custom
    // pages stay loopback-only; hosts serve them from their own local port.
    const host = page.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      await server.close();
      broker.close();
      exitWith(2, `--page must be loopback-only (got host ${page.hostname}); serve the page locally`);
    }
    pageUrl = withInteractionParams(page.toString(), server.baseUrl, server.token);
  }

  if (flags.has("no-window")) {
    process.stderr.write(`aiti-dialog: open ${pageUrl}\n`);
  } else {
    const opened = await win.open(pageUrl);
    if (!opened) {
      await server.close();
      broker.close();
      exitWith(4, `cannot start aiti-desktop-widget (set --widget-bin or AITI_DESKTOP_WIDGET_BIN); page: ${pageUrl}`);
    }
  }

  const request = dialogToRequest(spec);
  const timeoutMs = Number(values.timeout) > 0 ? Math.round(Number(values.timeout) * 1000) : 0;
  const opened = broker.open({ ...request, timeoutMs: timeoutMs || request.timeoutMs });
  const result = await opened.result;

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const out = dialogStdout(result, spec);
    if (out) process.stdout.write(`${out}\n`);
  }

  await win.close();
  await server.close();
  broker.close();
  process.exit(dialogExitCode(result));
}

async function runDaemon(values, flags) {
  const broker = new InteractionBroker();
  const server = await startInteractionServer({
    broker,
    port: Number(values.port) || 0,
    token: values.token,
    allowCreate: true,
    onCreate: () => { if (!flags.has("no-window")) void win.open(server.url); },
  });
  const win = new InteractionWidgetWindow({
    bin: values["widget-bin"],
    width: Number(values.width) || 560,
    height: Number(values.height) || 260,
    title: values.title || "aiti-dialog",
  });
  const opened = flags.has("no-window") ? false : await win.open(server.url);
  process.stderr.write(`aiti-dialog: daemon ${server.baseUrl}${opened ? "" : " (window unavailable)"}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, port: server.port, baseUrl: server.baseUrl, token: server.token })}\n`);

  const ttl = Number(values.ttl) > 0 ? Number(values.ttl) * 1000 : 0;
  let timer = null;
  const arm = () => {
    if (!ttl) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void shutdown(0); }, ttl);
    timer.unref?.();
  };
  const shutdown = async (code) => {
    try { await win.close(); } catch { /* ignore */ }
    try { await server.close(); } catch { /* ignore */ }
    broker.close();
    process.exit(code);
  };
  process.on("SIGINT", () => { void shutdown(0); });
  process.on("SIGTERM", () => { void shutdown(0); });
  arm();
  // Keep the process alive even without handles (stdin may be /dev/null).
  setInterval(() => {}, 1 << 30);
}

const { values, flags, list } = parseArgs(process.argv.slice(2));
if (flags.has("help")) usage(0);
if (flags.has("version")) version();

if (flags.has("daemon")) {
  await runDaemon(values, flags);
} else {
  const kind = values.dialog || list[0] || "";
  if (!KINDS.has(kind)) {
    process.stderr.write(`aiti-dialog: expected one of ${[...KINDS].join("|")} (got ${JSON.stringify(kind)})\n`);
    process.exit(2);
  }
  if (kind === "choose" && !values.options && !values.option) exitWith(2, "choose requires --options");
  const spec = {
    kind,
    text: values.text,
    title: values.title,
    detail: values.detail,
    okLabel: values["ok-label"],
    cancelLabel: values["cancel-label"],
    options: values.option || (values.options ? String(values.options).split(",").map((x) => x.trim()).filter(Boolean) : undefined),
    defaultValue: values.default,
    placeholder: values.placeholder,
    password: flags.has("password"),
    multiple: flags.has("multiple"),
    filters: values.filter ? [values.filter] : undefined,
    page: values.page,
  };
  await runOnce(spec, values, flags);
}
