/**
 * registration-guard — load-time duplicate-registration guard for the pi-web-bridge plugin.
 *
 * pi can load the same plugin through two independent channels:
 *   ① settings.json `packages[]` — npm specs or local dirs, loaded via the package's
 *      own `package.json` → `pi.extensions`;
 *   ② the agent extensions dir (~/.pi/agent/extensions/) — every entry there is scanned
 *      automatically (the legacy deploy target).
 * Hitting both registers every tool twice ("Tool \"aiti_*\" conflicts with …") and starts
 * two `/web` bridges.
 *
 * pi offers no load-time self-inspection: `pi.getAllTools()` / `pi.getMcpServers()` are
 * throwing stubs until the runner binds (only `registerTool()` works while loading). So
 * the decision is made from the filesystem + settings, which is safe at any time:
 *
 *   authority 1: the first settings `packages` entry naming this plugin (settings order
 *                is the user's precedence order). Only that copy registers; every other
 *                copy stands down — regardless of which one pi loaded first.
 *   authority 2: no settings entry → a process-global marker picks the first copy that
 *                registers, so an unexplained duplicate (e.g. the same dir symlinked
 *                twice into extensions/) still yields a single registration.
 *
 * Both entry points of the plugin (the TUI `/web` bridge and the `aiti_*` connector
 * bundle) call `checkDuplicateRegistration()` before registering anything.
 *
 * This module is dependency-free (Node builtins only) and is shipped in three places:
 * the extension dir (jiti, plain ESM), the published package (`src/`), and inlined into
 * the connector bundle by esbuild.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Package names this plugin has been published/installed under. */
export const PI_PLUGIN_NAMES = new Set(["@aiti-ai/pi-web-bridge", "pi-web-bridge"]);

/** Set to 1 to load every copy anyway (debugging). AITI_PI_EXT_FORCE implies this. */
export const GUARD_FORCE_ENV = "AITI_PLUGIN_DUP_FORCE";

const MARKER = Symbol.for("aiti-ai/pi-web-bridge#registration");

/** Default settings files pi reads: agent scope, then project scope. */
export function defaultSettingsFiles({ agentDir, cwd = process.cwd() } = {}) {
  return [join(agentDir, "settings.json"), join(cwd, ".pi", "settings.json")];
}

/** Resolve the pi agent dir the same way pi does (PI_CODING_AGENT_DIR wins). */
export function defaultAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Strip the version suffix of an npm spec, keeping the leading scope `@`. */
export function npmSpecName(source) {
  return source.slice("npm:".length).replace(/@[^@/]+$/, "");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function realpathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Walk up from a file until the plugin's own package.json (max a few levels; the
 * connector bundle lives in `dist/`, the TUI bridge in `src/` or the extension dir).
 * @returns {{ dir: string, meta: Record<string, unknown>|null }}
 */
export function resolvePluginRoot(fromPath) {
  let dir = dirname(fromPath);
  for (let i = 0; i < 4; i++) {
    const meta = readJsonSafe(join(dir, "package.json"));
    if (meta && PI_PLUGIN_NAMES.has(meta.name)) return { dir, meta };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: dirname(fromPath), meta: null };
}

/**
 * Find the settings-level registration of this plugin.
 * Stale entries (path gone / npm package not installed) are ignored so a dead settings
 * entry cannot disable every copy.
 * @returns {{ source: string, dir: string|null, settingsFile: string }|null}
 */
export function findPluginEntry({ settingsFiles, agentDir = defaultAgentDir() } = {}) {
  for (const settingsFile of settingsFiles || []) {
    const packages = readJsonSafe(settingsFile)?.packages;
    if (!Array.isArray(packages)) continue;
    for (const item of packages) {
      const source = typeof item === "string" ? item : item?.source;
      if (typeof source !== "string" || !source) continue;
      if (source.startsWith("npm:")) {
        const name = npmSpecName(source);
        if (!PI_PLUGIN_NAMES.has(name)) continue;
        if (!existsSync(join(agentDir, "npm", "node_modules", name, "package.json"))) continue;
        return { source, dir: null, settingsFile };
      }
      // Relative entries are ambiguous: resolve next to the settings file, then against
      // its parent (project root for <root>/.pi/settings.json), then against cwd.
      const candidates = [...new Set([
        resolve(dirname(settingsFile), source),
        resolve(dirname(dirname(settingsFile)), source),
        resolve(source),
      ])];
      for (const dir of candidates) {
        if (!existsSync(join(dir, "package.json"))) continue;
        if (!PI_PLUGIN_NAMES.has(readJsonSafe(join(dir, "package.json"))?.name)) continue;
        return { source, dir, settingsFile };
      }
    }
  }
  return null;
}

/**
 * True when `dir` is the artifact written by the legacy directory install (our own
 * package.json shape, `private: true`) — only that kind is safe to move away.
 */
export function isGeneratedLegacyDir(dir) {
  const meta = readJsonSafe(join(dir, "package.json"));
  return !!meta && meta.private === true && PI_PLUGIN_NAMES.has(meta.name) && Array.isArray(meta.pi?.extensions);
}

function isNpmInstalledCopy(dir, agentDir) {
  const root = join(agentDir, "npm", "node_modules");
  return (dir + sep).startsWith(realpathOrSelf(root) + sep) || (dir + sep).startsWith(root + sep);
}

/**
 * Decide whether this loaded copy must stand down because another copy is authoritative.
 * @param {{ selfUrl: string, settingsFiles?: string[], agentDir?: string, force?: boolean,
 *           env?: Record<string, string|undefined> }} opts
 * @returns {{ standDown: boolean, selfDir: string, winner: string|null, reason: string|null }}
 */
export function checkDuplicateRegistration(opts) {
  const env = opts.env || process.env;
  const agentDir = opts.agentDir || defaultAgentDir(env);
  const self = resolvePluginRoot(fileURLToPath(opts.selfUrl));
  const selfDir = realpathOrSelf(self.dir);
  const settingsFiles = opts.settingsFiles || defaultSettingsFiles({ agentDir, cwd: process.cwd() });
  const force = opts.force === true || env[GUARD_FORCE_ENV] === "1" || env.AITI_PI_EXT_FORCE === "1";
  const result = { standDown: false, selfDir, winner: null, reason: null };

  if (force) {
    globalThis[MARKER] = { dir: selfDir };
    return result;
  }

  const entry = findPluginEntry({ settingsFiles, agentDir });
  // Settings authority only applies to a copy we can identify as this plugin's package
  // (package.json name match). A standalone connector bundle (e.g. packages/aiti-devtools-pi/
  // dist dropped in by hand) has no such manifest: blocking it on a package entry could
  // leave the session with NO tools at all, which is worse than a duplicate — those copies
  // fall through to the process marker below.
  if (entry && self.meta) {
    if (entry.dir) {
      const winnerDir = realpathOrSelf(entry.dir);
      result.winner = winnerDir;
      if (winnerDir !== selfDir) {
        result.standDown = true;
        result.reason = `another copy is registered as the pi package (${winnerDir})`;
      }
    } else {
      result.winner = entry.source;
      if (!isNpmInstalledCopy(selfDir, agentDir)) {
        result.standDown = true;
        result.reason = `the plugin is installed from npm (${entry.source}); this copy is not that install`;
      }
    }
    if (result.standDown) return result;
  }

  // Whatever happens above, only one copy may claim the process marker: a second copy that
  // slipped through resolves to "already registered" instead of colliding tool names.
  const occupant = globalThis[MARKER];
  if (occupant && occupant.dir && occupant.dir !== selfDir && existsSync(occupant.dir)) {
    result.standDown = true;
    result.winner = occupant.dir;
    result.reason = `the plugin is already loaded from ${occupant.dir}`;
    return result;
  }
  globalThis[MARKER] = { dir: selfDir };
  return result;
}
