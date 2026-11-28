/**
 * HTTP surface for the extension (mounted under /api/extensions/aiti-codehub/*).
 *
 * Every route is provider-agnostic: `provider` selects an adapter from the registry,
 * the adapter maps its API to the shared meta-model, and this file only validates
 * inputs, reads/writes storage and maps errors.
 */
import { ForgeHttpError, sanitizeErrorText } from "./http.ts";
import { bind, type InstanceBinding } from "./binding.ts";
import { instanceLabel, isDefaultInstanceId, sameAlias } from "./instances.ts";
import type {
  ForgeProvider,
  ForgeRepo,
  ForgeWorkItem,
  ForgeWorkItemScope,
  ProviderConfig,
  WorkItemFilter,
} from "./contract.ts";
import { cancelDevice, deviceStatus } from "./device.ts";
import { ghCli, withGhToken } from "./gh-cli.ts";
import { basePath, finishOAuth, landingUrl, manualOAuth, oauthStatus, pageOriginForConfig, refreshIfNeeded, startOAuth } from "./oauth.ts";
import { getRegistry, getStore, publish, runtime } from "./runtime.ts";
import { issueBlobToken, resolveBlobToken } from "./blob-tokens.ts";
import { findLocalClone } from "./local.ts";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configView, recentScore } from "./store.ts";
import { DEFAULT_TEMPLATES } from "./contract.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const data = await req.json();
    return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function cfgOf(inst: InstanceBinding, opts: { refresh?: boolean } = {}): Promise<ProviderConfig> {
  let cfg = getStore().provider(inst.id);
  if (opts.refresh && cfg.authType === "oauth" && cfg.token) cfg = await refreshIfNeeded(runtime(), inst.id);
  if (cfg.authType === "gh") cfg = await withGhToken(cfg);
  return cfg;
}

function paging(q: URLSearchParams): { page: number; pageSize: number; q?: string } {
  const page = Math.max(1, Number(q.get("page") || 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.get("pageSize") || 0) || getStore().global().pageSize));
  const search = q.get("q") || undefined;
  return { page, pageSize, ...(search ? { q: search } : {}) };
}

function splitList(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function scopeOf(q: URLSearchParams): ForgeWorkItemScope {
  const id = String(q.get("scopeId") || "").trim();
  if (!id) throw new ForgeHttpError("scopeId is required", { status: 400, code: "bad_request" });
  return {
    kind: q.get("scopeKind") === "repo" ? "repo" : "project",
    id,
    label: String(q.get("scopeLabel") || id),
  };
}

function filterOf(q: URLSearchParams): WorkItemFilter {
  const exclude = q.get("excludeTerminal");
  return {
    keyword: q.get("keyword") || undefined,
    types: splitList(q.get("types")),
    statuses: splitList(q.get("statuses")),
    states: splitList(q.get("states")),
    assignee: q.get("assignee") || undefined,
    labels: splitList(q.get("labels")),
    excludeTerminal: exclude === null ? getStore().global().excludeClosed : exclude === "1" || exclude === "true",
  };
}

function repoOf(q: URLSearchParams): ForgeRepo {
  const id = String(q.get("repoId") || "").trim();
  const path = String(q.get("repoPath") || id).trim();
  if (!id && !path) throw new ForgeHttpError("repoId or repoPath is required", { status: 400, code: "bad_request" });
  return {
    id: id || path,
    name: String(q.get("repoName") || path.split("/").pop() || path),
    path,
    defaultBranch: q.get("defaultBranch") || undefined,
    webUrl: q.get("repoUrl") || undefined,
    cloneSsh: q.get("cloneSsh") || undefined,
    cloneHttp: q.get("cloneHttp") || undefined,
    archived: q.get("archived") === "1",
  };
}

function validateBaseUrl(provider: ForgeProvider, raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ForgeHttpError("baseUrl is not a valid URL", { status: 400, code: "bad_request" });
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ForgeHttpError("baseUrl must use https (loopback excepted)", { status: 400, code: "bad_request" });
  }
  const host = url.hostname;
  const allowed = (provider.allowedHosts || []).some((s) => host === s || host.endsWith("." + s));
  if (!allowed && !provider.allowsCustomBaseUrl) {
    throw new ForgeHttpError(`baseUrl host is not allow-listed: ${host}`, { status: 400, code: "bad_request" });
  }
}

/** Redacted config payload: the platform catalogue plus every configured account. */
function configPayload(req: Request): Record<string, unknown> {
  const store = getStore();
  const descriptors = getRegistry().descriptors();
  // Ignore stray files whose platform has no adapter (renamed/removed providers).
  const real = store.instances().filter((i) => descriptors.some((d) => String(d.id) === i.platform));
  const view = (inst: { id: string; platform: string; alias: string; createdAt: number }, virtual = false) => {
    const descriptor = (descriptors.find((d) => String(d.id) === inst.platform) || {}) as Record<string, unknown>;
    const platformLabel = String(descriptor.label || inst.platform);
    const cfg = store.provider(inst.id);
    const status = oauthStatus(runtime(), inst.id);
    const uris: Record<string, string> = {};
    try {
      const base = store.global().oauthCallbackBase || "http://127.0.0.1:30141";
      uris.default = landingUrl(base, inst.platform);
    } catch {
      /* ignore */
    }
    try {
      uris.page = landingUrl(pageOriginForConfig(req) + basePath(), inst.platform);
    } catch {
      /* host unknown */
    }
    return {
      ...descriptor,
      id: inst.id,
      platform: inst.platform,
      platformLabel,
      alias: instanceLabel({ id: inst.id, platform: inst.platform, alias: cfg.alias || inst.alias }, platformLabel),
      isDefault: isDefaultInstanceId(inst.id),
      /** Not configured yet: the platform has no account file, the UI may create it on save. */
      virtual,
      contract: 1,
      status: {
        ...status,
        configured: !!(cfg.token || (cfg.authType === "gh" && !!(cfg.ghHost || cfg.ghUser))),
        hasToken: !!cfg.token,
        authType: cfg.authType || "pat",
        needsLogin: !!cfg.needsLogin,
        account: cfg.account || null,
        accountError: cfg.accountError || "",
        orgId: cfg.orgId || "",
        baseUrl: cfg.baseUrl || "",
        clientId: cfg.clientId || "",
        ghHost: cfg.ghHost || "",
        ghUser: cfg.ghUser || "",
        hasClientSecret: !!cfg.clientSecret,
        alias: cfg.alias || "",
        aliasAuto: cfg.aliasAuto !== false,
        createdAt: inst.createdAt,
      },
      redirectUris: uris,
    };
  };

  const instances = real.map((i) => view(i));
  // Unconfigured platforms keep an implicit default instance so the settings form works
  // exactly as before (fill a PAT / start OAuth -> the file is created on save).
  for (const d of descriptors) {
    const platform = String(d.id);
    if (real.some((i) => i.platform === platform)) continue;
    instances.push(view({ id: platform, platform, alias: "", createdAt: 0 }, true));
  }
  instances.sort((a, b) => String(a.platform).localeCompare(String(b.platform)) || Number(a.status.createdAt) - Number(b.status.createdAt) || String(a.id).localeCompare(String(b.id)));

  // Backward-compatible view: one entry per platform (its default instance).
  const providers = descriptors.map((d) => {
    const platform = String(d.id);
    return instances.find((i) => i.id === platform) || instances.find((i) => i.platform === platform) || { ...d, platform, platformLabel: String(d.label || platform) };
  });
  const ids = instances.map((i) => String(i.id));
  return { ok: true, global: store.global(), settings: configView(store, ids).providers, providers, instances };
}

function errorResponse(e: unknown): Response {
  if (e instanceof ForgeHttpError) {
    const status = e.code === "auth" ? 401
      : e.code === "forbidden" ? 403
        : e.code === "rate_limited" ? 429
          : e.code === "not_found" ? 404
            : e.code === "bad_request" ? 400
              : e.code === "network" ? 502
                : e.status || 500;
    return json({ ok: false, code: e.code, error: sanitizeErrorText(e.message), retryAt: e.retryAt }, status);
  }
  const message = e instanceof Error ? e.message : String(e);
  return json({ ok: false, code: "server", error: sanitizeErrorText(message) }, 500);
}

export async function api(req: Request, ctx: { path?: string[]; searchParams?: URLSearchParams }): Promise<Response | null> {
  const path = ctx.path || [];
  const q = ctx.searchParams || new URL(req.url).searchParams;
  const [head, second, third] = path;

  try {
    /* ───────── account instances (multi-account) ───────── */
    if (head === "instances" && second && req.method === "POST") {
      const body = await bodyJson(req);
      if (second === "create") {
        const platform = String(body.platform || "").trim();
        const adapter = getRegistry().get(platform);
        if (!adapter) throw new ForgeHttpError(`unknown provider: ${platform || "(missing)"}`, { status: 404, code: "not_found" });
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
        if (baseUrl) validateBaseUrl(adapter, baseUrl);
        const alias = String(body.alias || "").trim() || `Account ${getStore().instancesOf(platform).length + 1}`;
        const authType = body.authType === "oauth" ? "oauth" : body.authType === "gh" ? "gh" : "pat";
        const created = getStore().createInstance(platform, alias, { authType, ...(baseUrl ? { baseUrl } : {}) });
        return json({ ...configPayload(req), created });
      }
      const inst = bind(String(body.instance || body.provider || ""));
      if (second === "rename") {
        const renamed = getStore().renameInstance(inst.id, String(body.alias || ""));
        return json({ ...configPayload(req), renamed });
      }
      if (second === "delete") {
        cancelDevice(inst.id);
        const removed = getStore().deleteInstance(inst.id);
        return json({ ...configPayload(req), removed });
      }
      throw new ForgeHttpError(`unknown instances action: ${second}`, { status: 404, code: "not_found" });
    }

    /* ───────── providers / config ───────── */
    if (head === "providers" && req.method === "GET") {
      return json({ ok: true, providers: getRegistry().descriptors() });
    }

    if (head === "config" && req.method === "GET") {
      return json(configPayload(req));
    }

    if (head === "config" && req.method === "POST") {
      const body = await bodyJson(req);
      if (body.global && typeof body.global === "object") {
        getStore().saveGlobal(body.global as never);
      }
      const providerId = typeof body.provider === "string" ? body.provider : "";
      if (providerId) {
        const inst = bind(providerId, typeof body.account === "string" ? body.account : undefined);
        const provider = inst.adapter;
        const patchIn = (body.config && typeof body.config === "object" ? body.config : {}) as Record<string, unknown>;
        const patch: Partial<ProviderConfig> = {};
        const allowed: Array<keyof ProviderConfig> = ["authType", "token", "refreshToken", "clientId", "clientSecret", "orgId", "baseUrl", "redirectUri", "ghHost", "ghUser"];
        for (const key of allowed) {
          if (key in patchIn) (patch as Record<string, unknown>)[key] = patchIn[key];
        }
        if (typeof patch.baseUrl === "string" && patch.baseUrl.trim()) validateBaseUrl(provider, patch.baseUrl.trim());
        if (patch.authType && patch.authType !== "pat" && patch.authType !== "oauth" && patch.authType !== "gh") {
          throw new ForgeHttpError("authType must be pat / oauth / gh", { status: 400, code: "bad_request" });
        }
        if (typeof patch.baseUrl === "string") patch.baseUrl = patch.baseUrl.trim().replace(/\/+$/, "") || undefined;
        getStore().saveProvider(inst.id, patch);
        // Aliases go through rename (uniqueness + aliasAuto=false), never a raw patch.
        const aliasIn = typeof patchIn.alias === "string" ? patchIn.alias.trim() : "";
        if (aliasIn && aliasIn !== String(getStore().provider(inst.id).alias || "")) {
          getStore().renameInstance(inst.id, aliasIn);
        }
      }
      return json(configPayload(req));
    }

    /* ───────── gh CLI bridge ───────── */
    if (head === "gh" && second === "status" && req.method === "POST") {
      const body = await bodyJson(req);
      const inst = bind(String(body.provider || "github"), typeof body.account === "string" ? body.account : undefined);
      const cfg = getStore().provider(inst.id);
      const host = String(body.host || cfg.ghHost || "github.com");
      const status = await ghCli.status(host);
      return json({ ok: true, host, ...status });
    }
    if (head === "gh" && second === "refresh" && req.method === "POST") {
      ghCli.clearTokenCache();
      return json({ ok: true });
    }

    /* ───────── auth ───────── */
    if (head === "auth" && second === "test" && req.method === "POST") {
      const body = await bodyJson(req);
      const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
      const provider = inst.adapter;
      const id = inst.id;
      let cfg = await cfgOf(inst, { refresh: true });
      if (!cfg.token) throw new ForgeHttpError("No token or OAuth sign-in configured yet", { status: 400, code: "bad_request" });

      let account;
      if (cfg.authType === "oauth") {
        const driver = provider.auth.oauth;
        if (!driver) throw new ForgeHttpError("This platform does not support OAuth", { status: 400, code: "bad_request" });
        account = cfg.account || (await driver.account(cfg, provider.httpFor(cfg), { accessToken: rfgToken(cfg) }));
      } else {
        if (!provider.auth.pat) throw new ForgeHttpError("This platform does not support PAT", { status: 400, code: "bad_request" });
        account = await provider.auth.pat.validate(cfg, provider.httpFor(cfg));
      }
      const patch: Partial<ProviderConfig> = { account, needsLogin: false, accountError: undefined };
      const org = (cfg.orgId || account?.extra?.orgId || "").trim();
      if (org) patch.orgId = org;
      // Until the user edits the alias manually, adopt the account name from the platform.
      if (cfg.aliasAuto !== false) {
        const auto = String(account?.displayName || account?.username || "").trim();
        const taken = getStore().instancesOf(inst.platform).some((i) => i.id !== id && sameAlias(i.alias, auto));
        if (auto && !taken && !sameAlias(auto, cfg.alias || "")) patch.alias = auto;
      }
      cfg = getStore().saveProvider(id, patch);
      return json({ ok: true, account, orgId: cfg.orgId || "", alias: cfg.alias || "" });
    }

    if (head === "auth" && second === "logout" && req.method === "POST") {
      const body = await bodyJson(req);
      const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
      const provider = inst.adapter;
      const id = inst.id;
      const old = getStore().provider(id);
      getStore().clearProvider(id);
      getStore().saveProvider(id, {
        authType: old.authType || "pat",
        clientId: old.clientId,
        clientSecret: old.clientSecret,
        baseUrl: old.baseUrl,
        orgId: old.orgId,
        redirectUri: old.redirectUri,
        ghHost: old.ghHost,
        ghUser: old.ghUser,
        needsLogin: false,
      });
      return json({ ok: true });
    }

    /* ───────── oauth ───────── */
    if (head === "oauth" && second) {
      const inst = bind(decodeURIComponent(second));
      const provider = inst.adapter;
      const id = inst.id;
      if (third === "start" && req.method === "POST") {
        const body = await bodyJson(req);
        const callbackMode = body.callbackMode === "page" || body.callbackMode === "custom" ? body.callbackMode : "default";
        const customBase = typeof body.customBase === "string" ? body.customBase : undefined;
        const out = await startOAuth(runtime(), id, { callbackMode, customBase }, req);
        return json({ ok: true, ...out });
      }
      if (third === "exchange" && req.method === "POST") {
        const body = await bodyJson(req);
        const result = await finishOAuth(runtime(), { platform: inst.platform }, String(body.code || ""), String(body.state || ""));
        return json({ ok: result.ok, error: result.error }, result.ok ? 200 : 400);
      }
      if (third === "manual" && req.method === "POST") {
        const body = await bodyJson(req);
        const result = await manualOAuth(runtime(), id, {
          url: typeof body.url === "string" ? body.url : undefined,
          code: typeof body.code === "string" ? body.code : undefined,
          state: typeof body.state === "string" ? body.state : undefined,
        });
        return json({ ok: result.ok, error: result.error }, result.ok ? 200 : 400);
      }
      if (third === "device" && req.method === "POST") {
        const body = await bodyJson(req);
        if (body.action === "cancel") {
          const cancelled = cancelDevice(id);
          return json({ ok: true, cancelled });
        }
        return json({ ok: false, error: "unknown device action" }, 400);
      }
      if (third === "device" && req.method === "GET") {
        return json({ ok: true, ...deviceStatus(id) });
      }
      if (third === "status" && req.method === "GET") {
        return json({ ok: true, ...oauthStatus(runtime(), id) });
      }
      if (third === "cancel" && req.method === "POST") {
        return json({ ok: true });
      }
      if (third === "callback" && req.method === "GET") {
        // Compatibility: local/browser callback that lands directly on the API path.
        const err = q.get("error");
        if (err) {
          publish("aiti-codehub:oauth", { provider: id, ok: false, error: err });
          return json({ ok: false, error: q.get("error_description") || err }, 400);
        }
        const code = q.get("code") || "";
        const state = q.get("state") || "";
        if (!code || !state) return json({ ok: false, error: "missing code/state" }, 400);
        const result = await finishOAuth(runtime(), { platform: inst.platform }, code, state);
        return json({ ok: result.ok, error: result.error }, result.ok ? 200 : 400);
      }
    }

    /* ───────── repo browsing (all POST; paths live in the JSON body) ───────── */
    if (head === "code" && second && req.method === "POST") {
      const body = await bodyJson(req);
      const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
      const provider = inst.adapter;
      const code = provider.code;
      if (!code) throw new ForgeHttpError("This platform does not support repositories", { status: 400, code: "bad_request" });
      const cfg = await cfgOf(inst, { refresh: true });
      const repo = repoOfBody(body);
      const ref = body.ref ? String(body.ref) : undefined;
      const safePath = normalizeRepoPath(String(body.path || ""));

      if (second === "tree") {
        if (!code.listTree) throw new ForgeHttpError("This platform does not support directory browsing", { status: 400, code: "bad_request" });
        const entries = await code.listTree(cfg, provider.httpFor(cfg), repo, { ref, path: safePath || undefined });
        return json({ ok: true, entries });
      }

      if (second === "file") {
        if (!code.getFile) throw new ForgeHttpError("This platform does not support file reads", { status: 400, code: "bad_request" });
        if (!safePath) throw new ForgeHttpError("path is required", { status: 400, code: "bad_request" });
        const file = await code.getFile(cfg, provider.httpFor(cfg), repo, { ref, path: safePath });
        const buf = file.encoding === "base64" ? Buffer.from(file.content || "", "base64") : Buffer.from(file.content || "", "utf8");
        const size = file.size || buf.length;
        const ext = (safePath.split(".").pop() || "").toLowerCase();
        const image = IMAGE_EXT.has(ext);
        const binary = !image && (BINARY_EXT.has(ext) || buf.subarray(0, 4096).includes(0));
        if (image || binary) {
          const { token } = issueBlobToken({ provider: inst.id, repo, ref, path: safePath, download: false });
          return json({ ok: true, kind: image ? "image" : "binary", blobToken: token, size, path: safePath });
        }
        let text = buf.toString("utf8");
        const truncated = Buffer.byteLength(text, "utf8") > TEXT_LIMIT;
        if (truncated) text = text.slice(0, TEXT_LIMIT) + "\n… (truncated)";
        return json({ ok: true, kind: "text", text, size, truncated, path: safePath });
      }

      if (second === "blob-ticket") {
        const items = Array.isArray(body.items) ? body.items : [body];
        const out = [];
        for (const raw of items) {
          const p = normalizeRepoPath(String((raw as Record<string, unknown>).path || ""));
          if (!p) continue;
          const { token } = issueBlobToken({ provider: inst.id, repo, ref, path: p, download: !!(raw as Record<string, unknown>).download });
          out.push({ path: p, token, download: !!(raw as Record<string, unknown>).download });
        }
        return json({ ok: true, items: out });
      }

      if (second === "commits") {
        if (!code.listCommits) throw new ForgeHttpError("This platform does not support commit history", { status: 400, code: "bad_request" });
        const page = Math.max(1, Number(body.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 30));
        const out = await code.listCommits(cfg, provider.httpFor(cfg), repo, { ref, path: safePath || undefined, page, pageSize });
        return json({ ok: true, ...out });
      }

      if (second === "commit") {
        if (!code.getCommit) throw new ForgeHttpError("This platform does not support commit details", { status: 400, code: "bad_request" });
        const sha = String(body.sha || "").trim();
        if (!sha) throw new ForgeHttpError("sha is required", { status: 400, code: "bad_request" });
        const commit = await code.getCommit(cfg, provider.httpFor(cfg), repo, { sha });
        return json({ ok: true, commit });
      }

      if (second === "editor-copy") {
        if (!code.getFile) throw new ForgeHttpError("This platform does not support file reads", { status: 400, code: "bad_request" });
        if (!safePath) throw new ForgeHttpError("path is required", { status: 400, code: "bad_request" });
        const file = await code.getFile(cfg, provider.httpFor(cfg), repo, { ref, path: safePath });
        const buf = file.encoding === "base64" ? Buffer.from(file.content || "", "base64") : Buffer.from(file.content || "", "utf8");
        if (buf.length > 2 * 1024 * 1024) throw new ForgeHttpError("File too large (>2MB) — download or clone the repo to view", { status: 413, code: "bad_request" });
        const base = (safePath.split("/").pop() || "file").replace(/[^A-Za-z0-9._-]/g, "_");
        const dir = join(getStore().dirs.cacheDir, "aiti-codehub", "remote", inst.id);
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `${(ref || "head").replace(/[^A-Za-z0-9._-]/g, "_")}-${base}`);
        if (existsSync(out)) { try { chmodSync(out, 0o644); } catch { /* ignore */ } }
        writeFileSync(out, buf, { mode: 0o444 });
        try { chmodSync(out, 0o444); } catch { /* ignore */ }
        return json({ ok: true, path: out });
      }

      if (second === "local") {
        const roots = getStore().global().localRoots;
        const result = findLocalClone({
          repo: {
            cloneSsh: repo.cloneSsh || (body.cloneSsh ? String(body.cloneSsh) : undefined),
            cloneHttp: repo.cloneHttp || (body.cloneHttp ? String(body.cloneHttp) : undefined),
            path: repo.path,
          },
          roots,
          cwd: body.cwd ? String(body.cwd) : undefined,
        });
        return json({ ok: true, ...result });
      }
    }

    /* ───────── blob stream (opaque token; no repo/path in URL) ───────── */
    if (head === "code" && second === "blob" && third && req.method === "GET") {
      const target = resolveBlobToken(third);
      if (!target) throw new ForgeHttpError("blob token is expired or invalid", { status: 404, code: "not_found" });
      const inst = bind(target.provider);
      const provider = inst.adapter;
      const code = provider.code;
      if (!code?.getFile) throw new ForgeHttpError("This platform does not support file reads", { status: 400, code: "bad_request" });
      const cfg = await cfgOf(inst, { refresh: true });
      const file = await code.getFile(cfg, provider.httpFor(cfg), target.repo, { ref: target.ref, path: target.path });
      const buf = file.encoding === "base64" ? Buffer.from(file.content || "", "base64") : Buffer.from(file.content || "", "utf8");
      if (buf.length > 10 * 1024 * 1024) throw new ForgeHttpError("File too large (>10MB) — clone the repo to view", { status: 413, code: "bad_request" });
      const ext = (target.path.split(".").pop() || "").toLowerCase();
      const headers = new Headers({
        "content-type": MIME_BY_EXT[ext] || "application/octet-stream",
        "content-length": String(buf.length),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      if (target.download) headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(target.path.split("/").pop() || "file")}`);
      else headers.set("content-disposition", "inline");
      return new Response(buf, { status: 200, headers });
    }

    /* ───────── authenticated file proxy (Yunxiao images / attachments) ───────── */
    if (head === "file" && req.method === "GET") {
      const inst = bind(q.get("provider") || "", q.get("account") || undefined);
      const provider = inst.adapter;
      const fp = provider.fileProxy;
      if (!fp) throw new ForgeHttpError("This platform does not support file proxying", { status: 400, code: "bad_request" });
      const cfg = await cfgOf(inst, { refresh: true });
      if (!cfg.token) throw new ForgeHttpError("Not signed in — work-item attachments are unavailable", { status: 401, code: "auth" });

      const workitemId = String(q.get("workitemId") || "");
      const fileId = String(q.get("fileId") || "");
      const download = q.get("download") === "1";

      let source: string;
      let name = fileId;
      let contentType = "";
      if (workitemId && fileId && fp.resolve) {
        const resolved = await fp.resolve(cfg, provider.httpFor(cfg), { workitemId, fileId });
        source = resolved.url;
        name = resolved.name || name;
        contentType = resolved.contentType || "";
      } else {
        // Legacy/direct URL mode (e.g. a provider that exposes a stable file URL).
        const rawUrl = String(q.get("url") || "");
        let target: URL;
        try { target = new URL(rawUrl); } catch { throw new ForgeHttpError("url is not a valid address", { status: 400, code: "bad_request" }); }
        const hostOk = fp.allowedHosts.some((h) => target.hostname === h || target.hostname.endsWith("." + h));
        const pathOk = fp.pathPrefixes.some((p) => target.pathname.startsWith(p));
        if (!hostOk || !pathOk) throw new ForgeHttpError("File URL is not allow-listed", { status: 400, code: "bad_request" });
        source = target.toString();
      }

      let srcUrl: URL;
      try { srcUrl = new URL(source); } catch { throw new ForgeHttpError("Invalid file URL", { status: 502, code: "network" }); }
      const ossOk = srcUrl.hostname.endsWith(".aliyuncs.com") || srcUrl.hostname.endsWith(".aliyun.com");
      if (!ossOk) throw new ForgeHttpError("File URL is not on the Aliyun OSS allow-list", { status: 502, code: "network" });

      const upstream = await fetch(srcUrl, { redirect: "follow" });
      if (!upstream.ok) {
        const status = upstream.status === 401 || upstream.status === 403 ? 401 : 502;
        return json({ ok: false, error: `Attachment fetch failed (HTTP ${upstream.status})` }, status);
      }
      const out = new Headers();
      const upstreamType = upstream.headers.get("content-type");
      if (contentType) out.set("content-type", contentType);
      else if (upstreamType) out.set("content-type", upstreamType);
      out.set("cache-control", "private, max-age=300");
      out.set("x-content-type-options", "nosniff");
      if (download) out.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      else out.set("content-disposition", "inline");
      return new Response(upstream.body, { status: 200, headers: out });
    }

    /* ───────── work items ───────── */
    if (head === "workitems") {
      if (second === "scopes" && req.method === "GET") {
        const inst = bind(q.get("provider") || "", q.get("account") || undefined);
        const provider = inst.adapter;
        if (!provider.workItems) throw new ForgeHttpError("This platform does not support work items", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const page = await provider.workItems.listScopes(cfg, provider.httpFor(cfg), paging(q));
        return json({ ok: true, ...page });
      }
      if (second === "seen" && req.method === "POST") {
        const body = await bodyJson(req);
        const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
        const scopeId = String(body.scopeId || "").trim();
        if (!scopeId) throw new ForgeHttpError("scopeId is required", { status: 400, code: "bad_request" });
        const mark = getStore().markSeen(inst.id, scopeId, {
          scopeKind: body.scopeKind ? String(body.scopeKind) : undefined,
          scopeLabel: body.scopeLabel ? String(body.scopeLabel) : undefined,
        });
        return json({ ok: true, seen: mark });
      }
      if (second === "counts" && req.method === "POST") {
        const body = await bodyJson(req);
        const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
        const provider = inst.adapter;
        if (!provider.workItems?.counts) throw new ForgeHttpError("This platform does not support item counts", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const http = provider.httpFor(cfg);
        const store = getStore();
        const seen = store.seenMarks(inst.id);
        const refresh = body.refresh === true;
        const marks = Array.isArray(body.scopes) ? body.scopes as Record<string, unknown>[] : [];
        const ids = marks.map((m) => String(m.scopeId || m.id || "")).filter(Boolean).slice(0, 20);
        const kindOf = new Map(marks.map((m) => [String(m.scopeId || m.id || ""), String(m.scopeKind || (m.scopeKind === "project" ? "project" : "repo"))]));
        const labelOf = new Map(marks.map((m) => [String(m.scopeId || m.id || ""), String(m.scopeLabel || m.name || m.id || "")]));
        const results: Record<string, unknown> = {};
        const CONC = 5;
        let idx = 0;
        async function worker(): Promise<void> {
          while (idx < ids.length) {
            const id = ids[idx++];
            const cacheKey = `wi-counts:${id}:${seen[id]?.seenAt ?? 0}`;
            if (!refresh) {
              const hit = store.cacheGet<unknown>(inst.id, "wi-counts", cacheKey, 5 * 60 * 1000);
              if (hit) { results[id] = hit; continue; }
            }
            try {
              const counts = await provider.workItems!.counts!(cfg, http, { kind: (kindOf.get(id) === "project" ? "project" : "repo") as "project" | "repo", id, label: labelOf.get(id) || id }, seen[id]?.seenAt);
              const out = { ...counts, seenAt: seen[id]?.seenAt ?? null };
              store.cacheSet(inst.id, "wi-counts", cacheKey, out);
              results[id] = out;
            } catch (e) {
              results[id] = { error: (e as Error).message };
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, ids.length)) }, worker));
        const partial = Object.values(results).some((r) => r && typeof r === "object" && "error" in (r as Record<string, unknown>));
        return json({ ok: true, counts: results, partial });
      }
      if (second && third === "comments" && req.method === "GET") {
        const inst = bind(q.get("provider") || "", q.get("account") || undefined);
        const provider = inst.adapter;
        if (!provider.workItems) throw new ForgeHttpError("This platform does not support work items", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const scope = scopeOf(q);
        const item = await provider.workItems.get(cfg, provider.httpFor(cfg), scope, second);
        const comments = await provider.workItems.comments(cfg, provider.httpFor(cfg), item);
        return json({ ok: true, comments });
      }
      if (second && req.method === "GET") {
        const inst = bind(q.get("provider") || "", q.get("account") || undefined);
        const provider = inst.adapter;
        if (!provider.workItems) throw new ForgeHttpError("This platform does not support work items", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const scope = scopeOf(q);
        const item = await provider.workItems.get(cfg, provider.httpFor(cfg), scope, second);
        getStore().addRecent({
          provider: inst.id,
          kind: "workitem",
          id: item.id,
          label: `#${item.key} ${item.title}`,
          sub: scope.label,
          scopeKind: scope.kind,
          scopeId: scope.id,
        });
        return json({ ok: true, item, usage: getStore().usage(inst.id, item.id) });
      }
      if (!second && req.method === "GET") {
        const inst = bind(q.get("provider") || "", q.get("account") || undefined);
        const provider = inst.adapter;
        if (!provider.workItems) throw new ForgeHttpError("This platform does not support work items", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const scope = scopeOf(q);
        const page = await provider.workItems.list(cfg, provider.httpFor(cfg), scope, filterOf(q), paging(q));
        return json({ ok: true, ...page });
      }
    }

    /* ───────── code ───────── */
    if (head === "code") {
      const inst = bind(q.get("provider") || "", q.get("account") || undefined);
      const provider = inst.adapter;
      const code = provider.code;
      if (!code) throw new ForgeHttpError("This platform does not support repositories", { status: 400, code: "bad_request" });
      if (second === "namespaces" && req.method === "GET") {
        if (!code.listNamespaces) throw new ForgeHttpError("This platform has no namespaces", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const page = await code.listNamespaces(cfg, provider.httpFor(cfg), q.get("parentId") || undefined, paging(q));
        return json({ ok: true, ...page });
      }
      if (second === "repos" && req.method === "GET") {
        const cfg = await cfgOf(inst, { refresh: true });
        const view = q.get("view") || "mine";
        const http = provider.httpFor(cfg);
        if (view === "starred" || view === "forks") {
          const fn = view === "starred" ? code.listStarred : code.listForks;
          if (!fn) throw new ForgeHttpError("This platform does not support this view", { status: 400, code: "bad_request" });
          const page = await fn(cfg, http, paging(q));
          return json({ ok: true, ...page });
        }
        const page = await code.listRepos(cfg, http, q.get("ns") || undefined, paging(q));
        return json({ ok: true, ...page });
      }
      if (second === "search" && req.method === "GET") {
        if (!code.searchRepos) throw new ForgeHttpError("This platform does not support repository search", { status: 400, code: "bad_request" });
        const kw = (q.get("q") || "").trim();
        if (!kw) return json({ ok: true, items: [], page: 1, pageSize: 30, hasMore: false });
        const cfg = await cfgOf(inst, { refresh: true });
        const page = await code.searchRepos(cfg, provider.httpFor(cfg), kw, paging(q));
        return json({ ok: true, ...page });
      }
      if (second === "branches" && req.method === "GET") {
        const cfg = await cfgOf(inst, { refresh: true });
        const repo = repoOf(q);
        const page = await code.listBranches(cfg, provider.httpFor(cfg), repo, paging(q));
        return json({ ok: true, ...page });
      }
      if (second === "repo" && req.method === "GET") {
        if (!code.getRepo) throw new ForgeHttpError("This platform has no repository details", { status: 400, code: "bad_request" });
        const id = q.get("id") || "";
        if (!id) throw new ForgeHttpError("id is required", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const repo = await code.getRepo(cfg, provider.httpFor(cfg), id);
        return json({ ok: true, repo });
      }
      if (second === "mr" && req.method === "POST") {
        const body = await bodyJson(req);
        if (!code.createMR) throw new ForgeHttpError("This platform does not support creating merge requests yet", { status: 400, code: "bad_request" });
        const repo = body.repo as ForgeRepo | undefined;
        if (!repo?.id && !repo?.path) throw new ForgeHttpError("repo is required", { status: 400, code: "bad_request" });
        const title = String(body.title || "").trim();
        const sourceBranch = String(body.sourceBranch || "").trim();
        const targetBranch = String(body.targetBranch || "").trim();
        if (!title || !sourceBranch || !targetBranch) throw new ForgeHttpError("title / sourceBranch / targetBranch are required", { status: 400, code: "bad_request" });
        const cfg = await cfgOf(inst, { refresh: true });
        const mr = await code.createMR(cfg, provider.httpFor(cfg), repo as ForgeRepo, {
          title,
          sourceBranch,
          targetBranch,
          description: body.description ? String(body.description) : undefined,
          workItemIds: Array.isArray(body.workItemIds) ? body.workItemIds.map(String) : undefined,
        });
        return json({ ok: true, mr });
      }
    }

    /* ───────── state ───────── */
    if (head === "state") {
      if (!second && req.method === "GET") {
        const s = getStore().state();
        return json({
          ok: true,
          favorites: s.favorites,
          recents: s.recents.map((r) => ({ ...r, score: recentScore(r) })),
          usage: s.usage,
        });
      }
      if (second === "favorite" && req.method === "POST") {
        const body = await bodyJson(req);
        const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
        const provider = inst.adapter;
        const kind = body.kind === "projects" || body.kind === "repos" || body.kind === "branches" ? body.kind : null;
        const id = String(body.id || "");
        if (!kind || !id) throw new ForgeHttpError("kind/id are required", { status: 400, code: "bad_request" });
        const active = getStore().toggleFavorite(inst.id, kind, id);
        return json({ ok: true, active });
      }
      if (second === "usage" && req.method === "POST") {
        const body = await bodyJson(req);
        const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
        const provider = inst.adapter;
        const id = String(body.id || "");
        const kind = body.kind === "ai" || body.kind === "paste" || body.kind === "branch" ? body.kind : null;
        if (!id || !kind) throw new ForgeHttpError("id/kind are required", { status: 400, code: "bad_request" });
        const usage = getStore().markUsage(inst.id, id, kind, body.branch ? String(body.branch) : undefined);
        return json({ ok: true, usage });
      }
      if (second === "recent" && req.method === "POST") {
        const body = await bodyJson(req);
        const inst = bind(String(body.provider || ""), typeof body.account === "string" ? body.account : undefined);
        const provider = inst.adapter;
        const kind = body.kind === "project" || body.kind === "repo" || body.kind === "branch" ? body.kind : null;
        const id = String(body.id || "");
        if (!kind || !id) throw new ForgeHttpError("kind/id are required", { status: 400, code: "bad_request" });
        const recents = getStore().addRecent({
          provider: inst.id,
          kind,
          id,
          label: String(body.label || id),
          sub: body.sub ? String(body.sub) : undefined,
        });
        return json({ ok: true, recents });
      }
    }

    return json({ ok: false, code: "not_found", error: `unknown route: ${path.join("/")}` }, 404);
  } catch (e) {
    return errorResponse(e);
  }
}

/** Local helper: current access token (kept separate for readability). */
function rfgToken(cfg: ProviderConfig): string {
  return String(cfg.token || "");
}

export { DEFAULT_TEMPLATES };

const TEXT_LIMIT = 512 * 1024;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const BINARY_EXT = new Set(["zip", "gz", "tgz", "rar", "7z", "tar", "pdf", "exe", "dll", "so", "dylib", "class", "jar", "woff", "woff2", "ttf", "otf", "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "docx", "xlsx", "pptx"]);
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  txt: "text/plain", md: "text/markdown", json: "application/json", js: "text/javascript", ts: "text/typescript",
  html: "text/html", css: "text/css", xml: "application/xml", yml: "text/yaml", yaml: "text/yaml",
};

/** Reject absolute paths / traversal; normalize separators. */
function normalizeRepoPath(raw: string): string {
  const p = raw.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!p) return "";
  if (p.split("/").some((s) => s === ".." || s === ".")) {
    throw new ForgeHttpError("Invalid file path", { status: 400, code: "bad_request" });
  }
  return p;
}

function repoOfBody(body: Record<string, unknown>): ForgeRepo {
  const path = String(body.repoPath || body.repoId || "").trim();
  if (!path) throw new ForgeHttpError("repoPath is required", { status: 400, code: "bad_request" });
  return {
    id: String(body.repoId || path),
    name: String(body.repoName || path.split("/").pop() || path),
    path,
    defaultBranch: body.defaultBranch ? String(body.defaultBranch) : undefined,
    cloneSsh: body.cloneSsh ? String(body.cloneSsh) : undefined,
    cloneHttp: body.cloneHttp ? String(body.cloneHttp) : undefined,
  };
}
