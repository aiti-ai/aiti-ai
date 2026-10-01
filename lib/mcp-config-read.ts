import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, type McpServerConfig } from "@earendil-works/pi-coding-agent";
import type {
  CodemodeSandboxStatus,
  McpAvailability,
  McpCodemodeInfo,
  McpConfigFieldRef,
  McpConfigFileInfo,
  McpConfigFileProblem,
  McpProjectInfo,
  McpResponse,
  McpScope,
  McpServerInfo,
  McpTransportKind,
  McpVariableReference,
} from "./api-types";
import {
  isMcpDisabledByOperator,
  MCP_DISABLE_VARIABLE,
  peekCodemodeSandbox,
  readBuiltinExtensionSwitches,
  type BuiltinExtensionName,
  type BuiltinExtensionSwitch,
} from "./builtin-extensions";
import { readCodemodePreference, readProjectCodemodeOverride } from "./codemode-settings";
import { getGlobalSettingsPath } from "./global-settings-file";
import { canonicalJson } from "./mcp-host";
import { maskArgs, maskCommand, maskUrl } from "./mcp-secrets";
import { withMcpStatuses } from "./mcp-status";
import { findWebPasswordField, resolvedConfigValues, WEB_PASSWORD_VARIABLE } from "./mcp-transport";
import { samePath } from "./paths";
import { hasParentDirectorySegment, isPathWithinRoots, resolveRealRoots } from "./path-security";
import { loadPiSdkInternals, type PiSdkInternals } from "./pi-sdk-internals";
import { getProjectTrustStatus } from "./project-trust";

// What Settings › MCP and the trust dialog list (ADR 0006): the entries of the
// global `mcp.json` and of a project's `.pi/mcp.json`, read from the files
// only. Nothing here spawns a process, opens a connection, or resolves a
// value — no `${VAR}` is expanded and no `!command` runs — so it never calls
// the SDK's transport, its value resolvers, `oauthSettings()`, or its OAuth
// credential store, which creates `mcp-auth.json` and a lock just to read it.
//
// The SDK's `loadMcpConfig()` cannot serve: it reads the project file only once
// the project is trusted, and merges by name, so a project entry hides the
// global one it replaces. Each file is read and parsed here as the SDK reads
// it, and each entry checked with the SDK's own validator.

export type McpConfigReadInternals = Pick<
  PiSdkInternals,
  "validateMcpServerConfig" | "isCommandConfigValue" | "getConfigValueEnvVarNames"
>;

export function globalMcpConfigPath(agentDir: string): string {
  return join(agentDir, "mcp.json");
}

export function projectMcpConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "mcp.json");
}

// One key per server process: hot reload re-evaluates this module, globalThis keeps it.
const CONFIG_KEY_SECRET: symbol = Symbol.for("pi-web:mcp-config-key-secret");

/**
 * What identifies an entry's content, so a status recorded for it can be
 * dropped once the entry changes: an HMAC of its canonical JSON (sorted keys)
 * under a key this process picked at random. Never the JSON itself, which
 * would carry every literal env and header value to the browser, and not a
 * plain hash either, which a weak password in an otherwise visible entry
 * would not survive. Stable for the life of the process, like the statuses
 * it is compared with.
 */
export function mcpConfigKey(value: unknown): string {
  const store = globalThis as Record<symbol, Buffer | undefined>;
  const secret = (store[CONFIG_KEY_SECRET] ??= randomBytes(32));
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("base64url");
}

/** The largest project file that is parsed; it comes from a repository nobody may have trusted. */
export const PROJECT_MCP_CONFIG_MAX_BYTES = 1024 * 1024;
/** Windows defines neither flag; it has no FIFOs, and the real-path check still refuses a link that leads outside. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function problem(info: McpConfigFileInfo, reason: McpConfigFileProblem["reason"], error: string): void {
  info.problems.push({ reason, error });
}

/** What reading a resolved path gave: the text and the file's permission bits, or why it was not read. */
export type ResolvedConfigFileRead =
  | { ok: true; text: string; mode: number }
  | { ok: false; reason: Extract<McpConfigFileProblem["reason"], "not-a-file" | "too-large" | "unreadable">; error: string; code?: string };

/**
 * Read the file at `realPath`, which has no link left in it: opened once
 * without following a link swapped in since and without blocking on a FIFO,
 * then checked through what was opened. A FIFO or a device is never read.
 * The `mcp.json` writer (`lib/mcp-config-file.ts`) reads through this too.
 */
export function readResolvedConfigFile(realPath: string, maxBytes: number | undefined): ResolvedConfigFileRead {
  let fd: number | undefined;
  try {
    fd = openSync(realPath, OPEN_FLAGS);
    const stats = fstatSync(fd);
    const mode = stats.mode & 0o777;
    if (!stats.isFile()) return { ok: false, reason: "not-a-file", error: "not a regular file" };
    if (maxBytes === undefined) return { ok: true, text: readFileSync(fd, "utf8"), mode };
    if (stats.size > maxBytes) return { ok: false, reason: "too-large", error: `larger than ${maxBytes} bytes` };
    // One byte past the limit: a file still growing past it is not parsed.
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < limit) {
      const chunk = Buffer.alloc(Math.min(limit - length, 64 * 1024));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      length += read;
    }
    if (length > maxBytes) return { ok: false, reason: "too-large", error: `larger than ${maxBytes} bytes` };
    return { ok: true, text: Buffer.concat(chunks, length).toString("utf8"), mode };
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, reason: "unreadable", error: errorMessage(error), ...(code ? { code } : {}) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readResolvedFile(realPath: string, info: McpConfigFileInfo, maxBytes: number | undefined): string | undefined {
  const read = readResolvedConfigFile(realPath, maxBytes);
  info.exists = true;
  if (read.ok) return read.text;
  problem(info, read.reason, read.error);
  return undefined;
}

/**
 * The global file is the user's own: a symbolic link is followed wherever it
 * leads, and a dangling one reads as no file, as it does for the SDK.
 */
function readGlobalFile(agentDir: string): { info: McpConfigFileInfo; text?: string } {
  const path = globalMcpConfigPath(agentDir);
  const info: McpConfigFileInfo = { scope: "global", path, exists: false, problems: [] };
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      info.exists = true;
      problem(info, "unreadable", errorMessage(error));
    }
    return { info };
  }
  if (!samePath(realPath, join(realPathOr(agentDir), "mcp.json"))) info.realPath = realPath;
  return { info, text: readResolvedFile(realPath, info, undefined) };
}

/**
 * The project file is whatever the repository committed, and may be read
 * before anyone trusted it. A link, in the file or in a folder above it, is
 * followed only when its real path stays inside `allowedRoots` (the folders
 * `/api/files` may read); a dangling one is refused rather than read as no
 * file. The same rule as the rest of the file access allow-list: a link is
 * authorized by where it resolves.
 */
/** Where a project's `.pi/mcp.json` leads under the link rule, before anything is read from it. */
export type ProjectMcpConfigLocation =
  | { kind: "found"; path: string; realPath: string }
  | { kind: "missing"; path: string }
  | {
      kind: "refused";
      path: string;
      /** Where the link leads, when it leads somewhere. */
      realPath?: string;
      reason: Extract<McpConfigFileProblem["reason"], "link-dangling" | "link-outside" | "unreadable">;
      error: string;
    };

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // Missing, or a folder above it is missing or a dangling link.
    return false;
  }
}

/**
 * The project file under the link rule: its real path, a link in the file or
 * in `.pi/` above it included, must be inside `allowedRoots`, and a dangling
 * link is refused rather than taken for a missing file. Settings › MCP reads,
 * and `lib/mcp-config-file.ts` writes, only what this lets through.
 */
export function locateProjectMcpConfig(cwd: string, allowedRoots: Set<string>): ProjectMcpConfigLocation {
  const path = projectMcpConfigPath(cwd);
  if (hasParentDirectorySegment(path)) return { kind: "refused", path, reason: "unreadable", error: "the path has a .. segment" };
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch (error) {
    if (isSymbolicLink(path)) return { kind: "refused", path, reason: "link-dangling", error: "a symbolic link to nothing" };
    if (errorCode(error) !== "ENOENT") return { kind: "refused", path, reason: "unreadable", error: errorMessage(error) };
    return { kind: "missing", path };
  }
  if (!isPathWithinRoots(realPath, resolveRealRoots(allowedRoots))) {
    return { kind: "refused", path, realPath, reason: "link-outside", error: "a symbolic link outside the folders Pi Web may read" };
  }
  return { kind: "found", path, realPath };
}

/**
 * Where a project file that does not exist yet would be created, under the
 * same rule: inside the real `.pi/` folder when there is one, which must
 * resolve inside `allowedRoots` (a dangling `.pi` link is refused), else in a
 * `.pi/` the writer creates in the project folder's real path.
 */
export function projectMcpConfigCreatePath(
  cwd: string,
  allowedRoots: Set<string>,
): { ok: true; realPath: string } | { ok: false; reason: "link-dangling" | "link-outside" | "unreadable"; error: string } {
  const dir = join(cwd, CONFIG_DIR_NAME);
  if (hasParentDirectorySegment(dir)) return { ok: false, reason: "unreadable", error: "the path has a .. segment" };
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (error) {
    if (isSymbolicLink(dir)) return { ok: false, reason: "link-dangling", error: "a symbolic link to nothing" };
    if (errorCode(error) !== "ENOENT") return { ok: false, reason: "unreadable", error: errorMessage(error) };
    try {
      realDir = join(realpathSync(cwd), CONFIG_DIR_NAME);
    } catch (cwdError) {
      return { ok: false, reason: "unreadable", error: errorMessage(cwdError) };
    }
  }
  if (!isPathWithinRoots(realDir, resolveRealRoots(allowedRoots))) {
    return { ok: false, reason: "link-outside", error: "a symbolic link outside the folders Pi Web may read" };
  }
  return { ok: true, realPath: join(realDir, "mcp.json") };
}

function readProjectFile(cwd: string, allowedRoots: Set<string>): { info: McpConfigFileInfo; text?: string } {
  const location = locateProjectMcpConfig(cwd, allowedRoots);
  const info: McpConfigFileInfo = { scope: "project", path: location.path, exists: false, problems: [] };
  if (location.kind === "missing") return { info };
  const realPath = location.realPath;
  if (realPath !== undefined && !samePath(realPath, join(realPathOr(cwd), CONFIG_DIR_NAME, "mcp.json"))) info.realPath = realPath;
  if (location.kind === "refused") {
    info.exists = true;
    problem(info, location.reason, location.error);
    return { info };
  }
  return { info, text: readResolvedFile(location.realPath, info, PROJECT_MCP_CONFIG_MAX_BYTES) };
}

// V8's message for an unexpected token quotes the source around it instead of
// giving a position: the whole text when it is shorter than 21 characters,
// else up to 10 characters on either side, with `...` where it was cut.
const UNEXPECTED_TOKEN = /^Unexpected token '([\s\S])', ([\s\S]*) is not valid JSON$/;
const TOKEN_CONTEXT = 10;

/** Where V8's quoted context puts the unexpected token in `text`, or undefined when it cannot be told. */
function unexpectedTokenPosition(text: string, token: string, quoted: string): number | undefined {
  const cutBefore = quoted.startsWith('..."');
  const cutAfter = quoted.endsWith('"...');
  const inner = quoted.slice(cutBefore ? 3 : 0, cutAfter ? -3 : undefined);
  if (inner.length < 2 || !inner.startsWith('"') || !inner.endsWith('"')) return undefined;
  // The whole text: V8 says nothing about where in it.
  if (!cutBefore && !cutAfter) return undefined;
  const context = inner.slice(1, -1);
  let position: number;
  if (!cutBefore) {
    if (!text.startsWith(context)) return undefined;
    position = context.length - TOKEN_CONTEXT;
  } else if (!cutAfter) {
    if (!text.endsWith(context)) return undefined;
    position = text.length - context.length + TOKEN_CONTEXT;
  } else {
    position = text.indexOf(context);
    while (position >= 0 && text[position + TOKEN_CONTEXT] !== token) position = text.indexOf(context, position + 1);
    if (position < 0) return undefined;
    position += TOKEN_CONTEXT;
  }
  return text[position] === token ? position : undefined;
}

/** `at position 62 (line 5 column 7)`, as V8 words the messages that give one. */
function describePosition(text: string, position: number): string {
  const before = text.slice(0, position);
  const line = before.split("\n").length;
  const column = position - before.lastIndexOf("\n");
  return `at position ${position} (line ${line} column ${column})`;
}

/**
 * The parser's message without the source text it quotes. For an unexpected
 * token V8 quotes up to twenty characters around it (`Unexpected token ''',
 * ..."B_TOKEN": 'ghp_abcde"... is not valid JSON`), and that text is often a
 * literal secret — a single-quoted value is the usual mistake. The message
 * keeps the token only when it is punctuation, never a letter or a digit of
 * a value, and gives the position the quote stood for. Messages that already
 * give a position quote nothing and are kept.
 */
export function jsonErrorMessage(error: unknown, text: string): string {
  const message = errorMessage(error);
  if (!message.includes('"')) return message;
  const match = UNEXPECTED_TOKEN.exec(message);
  if (!match) return "Not valid JSON";
  const [, token, quoted] = match;
  const code = token.charCodeAt(0);
  const shown = /[\p{L}\p{N}]/u.test(token)
    ? ""
    : /[\p{P}\p{S}]/u.test(token)
      ? ` '${token}'`
      : ` U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  const position = unexpectedTokenPosition(text, token, quoted);
  return `Unexpected token${shown} in JSON${position === undefined ? "" : ` ${describePosition(text, position)}`}`;
}

/** The file's `mcpServers` entries, parsed as the SDK's `loadMcpConfig()` parses them. */
function parseConfigText(info: McpConfigFileInfo, text: string): [name: string, value: unknown][] {
  let parsed: unknown;
  try {
    // No byte-order mark is stripped: the SDK does not strip one either.
    parsed = JSON.parse(text);
  } catch (error) {
    problem(info, "unparsable", jsonErrorMessage(error, text));
    return [];
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    problem(info, "invalid-shape", 'expected an object with an "mcpServers" object');
    return [];
  }
  if (typeof parsed.autoEnableCodemode === "boolean") info.autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined) {
    problem(info, "auto-enable-codemode-invalid", "autoEnableCodemode must be a boolean");
  }
  return Object.entries(isRecord(parsed.mcpServers) ? parsed.mcpServers : {});
}

/**
 * Servers with tokens in `mcp-auth.json`, keyed as the SDK keys them
 * (`String(new URL(url))`). Read raw and never locked or created; undefined
 * when the file cannot be read, so no server is reported either way.
 */
function readSignedInUrls(agentDir: string): Set<string> | undefined {
  const path = join(agentDir, "mcp-auth.json");
  if (!existsSync(path)) return new Set();
  try {
    const text = readFileSync(path, "utf8");
    if (!text.trim()) return new Set();
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return new Set();
    return new Set(
      Object.entries(parsed)
        .filter(([, state]) => isRecord(state) && isRecord(state.tokens) && typeof state.tokens.access_token === "string")
        .map(([key]) => key),
    );
  } catch {
    return undefined;
  }
}

/**
 * The transport a connection uses, decided as the SDK's `createDefaultTransport()`
 * (and Pi Web's factory, and the value walk in `resolvedConfigValues()`)
 * decide it: by whether the key `url` is present, whatever its value or
 * `type`. The validator decides differently — `{ type: "stdio", command, url }`
 * passes as stdio — but such an entry connects over HTTP, with its headers'
 * `!command`s, so that is what is reported. An entry the validator refuses
 * never connects, so it gets the validator's reading instead: a legacy SSE
 * entry has no transport.
 */
function transportOf(config: Record<string, unknown>, refused: boolean): McpTransportKind | undefined {
  if (refused) {
    const { type } = config;
    if (typeof config.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) return "http";
    if (typeof config.command === "string" && (type === undefined || type === "stdio")) return "stdio";
    return undefined;
  }
  if ("url" in config) return "http";
  if ("command" in config) return "stdio";
  return undefined;
}

function signInKey(url: string): string | undefined {
  try {
    return String(new URL(url));
  } catch {
    return undefined;
  }
}

interface DescribeContext {
  internals: McpConfigReadInternals | undefined;
  signedInUrls: Set<string> | undefined;
}

interface DescribedServer {
  info: McpServerInfo;
  /** Whether the SDK would load it: valid, or not checked because the validator is unavailable. */
  loads: boolean;
}

const TEMPLATE_REFERENCE = /\$(?:[$!]|\{([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables a value that is not a `!command` reads, as the SDK's
 * `getConfigValueEnvVarNames()` parses them, for when its internals cannot be
 * loaded: `${NAME}` and `$NAME`, with `$$` and `$!` escaping a literal, and
 * `${…}` around anything but a name left as written.
 */
export function templateVariableNames(value: string): string[] {
  const names: string[] = [];
  for (const [, braced, bare] of value.matchAll(TEMPLATE_REFERENCE)) {
    const name = braced !== undefined ? (VARIABLE_NAME.test(braced) ? braced : undefined) : bare;
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function fieldRef({ kind, name }: McpConfigFieldRef): McpConfigFieldRef {
  return name === undefined ? { kind } : { kind, name };
}

function describeServer(
  name: string,
  value: unknown,
  scope: McpScope,
  sourcePath: string,
  { internals, signedInUrls }: DescribeContext,
): DescribedServer {
  const validation = internals?.validateMcpServerConfig(name, value);
  const config: Record<string, unknown> = isRecord(value) ? value : {};
  const info: McpServerInfo = {
    name,
    scope,
    sourcePath,
    configKey: mcpConfigKey(value),
    enabled: config.enabled !== false,
    validated: internals !== undefined,
    envNames: isRecord(config.env) ? Object.keys(config.env) : [],
    headerNames: isRecord(config.headers) ? Object.keys(config.headers) : [],
    usesOAuth: false,
    commandFields: [],
    variableReferences: [],
    masked: false,
  };
  if (typeof validation === "string") info.invalidError = validation;
  if (!isRecord(value)) info.notAnObject = true;
  const transport = transportOf(config, typeof validation === "string");
  if (transport) info.transport = transport;
  if (validation !== undefined && typeof validation !== "string") {
    info.exposure = (validation as McpServerConfig).exposure ?? "codemode";
  }

  if (typeof config.command === "string") {
    const command = maskCommand(config.command);
    info.command = command.value;
    info.masked ||= command.masked;
  }
  if (Array.isArray(config.args)) {
    const args = maskArgs(config.args.filter((arg): arg is string => typeof arg === "string"));
    info.args = args.args;
    info.masked ||= args.masked;
  }
  if (typeof config.cwd === "string") info.cwd = config.cwd;
  if (typeof config.url === "string") {
    const url = maskUrl(config.url);
    info.url = url.value;
    info.masked ||= url.masked;
  }
  // The SDK's rule (runtime.js usesOAuth): `url` present and no Authorization header.
  info.usesOAuth = transport === "http" && !info.headerNames.some((header) => header.toLowerCase() === "authorization");
  if (info.usesOAuth && signedInUrls && typeof config.url === "string") {
    const key = signInKey(config.url);
    if (key) info.signedIn = signedInUrls.has(key);
  }

  // Without the SDK's parser, a leading `!` is all that marks a command, and any
  // mention of the password counts, as it does for a command.
  const isCommand = internals ? (text: string) => internals.isCommandConfigValue(text) : (text: string) => text.startsWith("!");
  const values = resolvedConfigValues(config);
  info.commandFields = values.filter((field) => isCommand(field.value)).map(fieldRef);
  // Named, never expanded: these are the host's variables the entry hands to
  // its process or sends to its URL, which the trust dialog has to show.
  const variableNames = internals ? (text: string) => internals.getConfigValueEnvVarNames(text) : templateVariableNames;
  info.variableReferences = values
    .filter((field) => !isCommand(field.value))
    .map((field): McpVariableReference => ({ ...fieldRef(field), variables: variableNames(field.value) }))
    .filter((reference) => reference.variables.length > 0);
  const webPasswordField = internals
    ? findWebPasswordField(config, internals)
    : values.find((field) => field.value.toUpperCase().includes(WEB_PASSWORD_VARIABLE));
  if (webPasswordField) info.webPasswordField = fieldRef(webPasswordField);

  return { info, loads: internals ? typeof validation !== "string" : isRecord(value) };
}

export interface McpConfigReadOptions {
  agentDir: string;
  /** The project to read `.pi/mcp.json` from; its file must resolve inside `allowedRoots`. */
  project?: { cwd: string; allowedRoots: Set<string> };
  /** The SDK's validator and value parsers; without them entries are listed unchecked. */
  internals?: McpConfigReadInternals;
}

export interface McpConfigRead {
  files: McpConfigFileInfo[];
  servers: McpServerInfo[];
}

/** The servers of the global and the project file, each described from the file alone. */
export function readMcpServerConfigs(options: McpConfigReadOptions): McpConfigRead {
  const context: DescribeContext = {
    internals: options.internals,
    signedInUrls: readSignedInUrls(options.agentDir),
  };
  const files: McpConfigFileInfo[] = [];
  const described: DescribedServer[] = [];
  const sources = [readGlobalFile(options.agentDir)];
  if (options.project) sources.push(readProjectFile(options.project.cwd, options.project.allowedRoots));
  for (const { info, text } of sources) {
    files.push(info);
    if (text === undefined) continue;
    for (const [name, value] of parseConfigText(info, text)) {
      described.push(describeServer(name, value, info.scope, info.path, context));
    }
  }
  // A project entry the SDK loads replaces the global one of its name once the
  // project is trusted; an invalid one is skipped and leaves the global in place.
  const projectNames = new Set(
    described.filter(({ info, loads }) => info.scope === "project" && loads).map(({ info }) => info.name),
  );
  const shadowedNames = new Set<string>();
  for (const { info } of described) {
    if (info.scope === "global" && projectNames.has(info.name)) {
      info.shadowedByProject = true;
      shadowedNames.add(info.name);
    }
  }
  for (const { info } of described) {
    if (info.scope === "project" && shadowedNames.has(info.name)) info.replacesGlobal = true;
  }
  return { files, servers: described.map(({ info }) => info) };
}

/** One entry as its file holds it, for a route that connects it; never sent to the browser. */
export type McpServerEntryRead =
  | {
      ok: true;
      /** The raw entry, literal values included. */
      value: unknown;
      /** The configured path of its file, as `McpServerInfo.sourcePath` names it. */
      sourcePath: string;
      /** `mcpConfigKey()` of the raw entry, as GET reports it. */
      configKey: string;
    }
  | {
      ok: false;
      /** A problem of the file (its servers are not listed), or `server-missing`. */
      reason: Exclude<McpConfigFileProblem["reason"], "auto-enable-codemode-invalid"> | "server-missing";
      error: string;
      path: string;
    };

/**
 * The entry `name` of the global file or the project's, read and parsed as
 * the listing reads it, under the same link rule, so a route acts only on an
 * entry the panel can list and never on a config the browser sent.
 */
export function readMcpServerEntry(options: {
  agentDir: string;
  scope: McpScope;
  name: string;
  /** Required for a project entry. */
  project?: { cwd: string; allowedRoots: Set<string> };
}): McpServerEntryRead {
  const { scope, name, project } = options;
  if (scope === "project" && !project) throw new Error("a project entry needs the project");
  const { info, text } = scope === "global" || !project
    ? readGlobalFile(options.agentDir)
    : readProjectFile(project.cwd, project.allowedRoots);
  const entries = text === undefined ? [] : parseConfigText(info, text);
  for (const problem of info.problems) {
    if (problem.reason !== "auto-enable-codemode-invalid") {
      return { ok: false, reason: problem.reason, error: problem.error, path: info.path };
    }
  }
  const found = entries.find(([entryName]) => entryName === name);
  if (!found) return { ok: false, reason: "server-missing", error: `${info.path} does not define MCP server "${name}"`, path: info.path };
  return { ok: true, value: found[1], sourcePath: info.path, configKey: mcpConfigKey(found[1]) };
}

export interface ProjectMcpServers {
  file: McpConfigFileInfo;
  servers: McpServerInfo[];
}

/**
 * What a project's `.pi/mcp.json` declares, for the trust dialog: read as
 * `GET /api/mcp` reads it, from the file only and whether or not the project
 * is trusted. The global file is read too, only to tell which project entries
 * replace a global one of their name.
 */
export async function readProjectMcpServers(options: {
  agentDir: string;
  cwd: string;
  allowedRoots: Set<string>;
}): Promise<ProjectMcpServers> {
  const internals = await loadPiSdkInternals();
  const { files, servers } = readMcpServerConfigs({
    agentDir: options.agentDir,
    project: { cwd: options.cwd, allowedRoots: options.allowedRoots },
    internals: internals.ok ? internals : undefined,
  });
  const file = files.find((info) => info.scope === "project");
  if (!file) throw new Error("the project file was not read");
  return { file, servers: servers.filter((server) => server.scope === "project") };
}

// ---------------------------------------------------------------------------
// GET /api/mcp
// ---------------------------------------------------------------------------

function mcpAvailability(
  environment: NodeJS.ProcessEnv,
  internals: Awaited<ReturnType<typeof loadPiSdkInternals>>,
  mcpSwitch: BuiltinExtensionSwitch | undefined,
): McpAvailability {
  if (isMcpDisabledByOperator(environment)) {
    return { available: false, reason: "operator-disabled", error: `${MCP_DISABLE_VARIABLE} is set` };
  }
  if (!internals.ok) {
    return {
      available: false,
      reason: "internals-unavailable",
      error: "Pi Web cannot load the SDK's MCP modules",
      detail: internals.reason,
    };
  }
  if (mcpSwitch && !mcpSwitch.enabled) {
    return {
      available: false,
      reason: "builtin-disabled",
      error: "the extensions setting turns builtin:mcp off",
      ...(mcpSwitch.settingsPath ? { settingsPath: mcpSwitch.settingsPath } : {}),
    };
  }
  return { available: true };
}

/**
 * Code mode as a session would get it: the global preference, the sandbox
 * self-test and `-builtin:codemode` (both as the project's sessions see it and
 * as the global settings alone say), and, given `trustedCwd`, the project
 * settings that decide it there whatever the global choice.
 */
async function codemodeInfo(
  agentDir: string,
  codemodeSwitch: BuiltinExtensionSwitch | undefined,
  trustedCwd: string | undefined,
): Promise<McpCodemodeInfo> {
  const peek = await peekCodemodeSandbox();
  const sandbox: CodemodeSandboxStatus = !peek.checked
    ? { state: "not-checked" }
    : peek.available
      ? { state: "available" }
      : { state: "unavailable", error: peek.reason };
  const info: McpCodemodeInfo = { sandbox, builtinDisabled: codemodeSwitch?.enabled === false };
  if (codemodeSwitch?.settingsPath) info.builtinSettingsPath = codemodeSwitch.settingsPath;
  // What the global `extensions` alone say, which is what Always on, a global setting, depends on.
  const globalSwitch = codemodeSwitch?.global ?? codemodeSwitch;
  if (globalSwitch?.enabled === false) {
    info.globalBuiltinSettingsPath = globalSwitch.settingsPath ?? getGlobalSettingsPath(agentDir);
  }
  try {
    info.preference = await readCodemodePreference(getGlobalSettingsPath(agentDir));
  } catch (error) {
    info.preferenceError = errorMessage(error);
  }
  const projectOverride = trustedCwd === undefined ? undefined : readProjectCodemodeOverride(trustedCwd);
  if (projectOverride) info.projectOverride = projectOverride;
  return info;
}

export interface McpOverviewOptions {
  agentDir: string;
  project?: { cwd: string; allowedRoots: Set<string> };
  environment?: NodeJS.ProcessEnv;
}

/**
 * Everything Settings › MCP shows, from files and process state only: whether
 * MCP and Code mode can run, the servers of both files with the last known
 * status of each (`lib/mcp-status.ts`, for the entry as the file holds it
 * now), and the project's trust, read fresh. A project that is not trusted is listed too, with the
 * command each entry would run, which is the point: it can be checked before
 * anyone trusts it.
 */
export async function readMcpOverview(options: McpOverviewOptions): Promise<McpResponse> {
  const { agentDir, project, environment = process.env } = options;
  const internals = await loadPiSdkInternals();
  let projectInfo: McpProjectInfo | undefined;
  if (project) {
    projectInfo = { cwd: project.cwd };
    try {
      projectInfo.trust = getProjectTrustStatus(project.cwd, agentDir);
    } catch (error) {
      projectInfo.trustError = errorMessage(error);
    }
  }
  // Whether sessions load the project's settings, as `projectTrustReloadOptions()` decides when one
  // starts: a folder that requires trust only with a decision that trusts it, never while trust.json
  // cannot be read; one that requires none has no `.pi/settings.json`, which alone requires trust.
  const projectSettingsLoad = projectInfo?.trust?.trusted === true;
  let switches: Record<BuiltinExtensionName, BuiltinExtensionSwitch> | undefined;
  try {
    switches = await readBuiltinExtensionSwitches({
      agentDir,
      cwd: project?.cwd,
      projectTrusted: projectSettingsLoad,
    });
  } catch (error) {
    // A settings file that cannot be read leaves the built-ins as the session would find them: on.
    console.warn(`[pi-web] cannot read the extensions settings for Settings › MCP: ${errorMessage(error)}`);
  }
  const { files, servers } = readMcpServerConfigs({
    agentDir,
    project,
    internals: internals.ok ? internals : undefined,
  });
  // A file whose servers are all listed: statuses of names it no longer defines can go.
  const listedFiles = files.filter((file) => !file.problems.some((item) => item.reason !== "auto-enable-codemode-invalid"));
  return {
    mcp: mcpAvailability(environment, internals, switches?.mcp),
    codemode: await codemodeInfo(agentDir, switches?.codemode, project && projectSettingsLoad ? project.cwd : undefined),
    files,
    servers: withMcpStatuses(servers, listedFiles),
    ...(projectInfo ? { project: projectInfo } : {}),
  };
}
