/**
 * Browser-side client for @aiti-ai/widget-interaction.
 *
 * The host owns pending requests. This client only mirrors them over SSE and
 * submits answers over HTTP; a page refresh can recreate it without losing the
 * host callback.
 */

function withToken(url, token) {
  if (!token) return url;
  const u = new URL(url, location.href);
  u.searchParams.set("token", token);
  return u.toString();
}

function requestJson(url, options) {
  return fetch(url, options).then(async (res) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  });
}

/**
 * @param {{ baseUrl?: string, token?: string, onError?: (e: Error) => void }} [opts]
 */
export async function connectInteraction(opts = {}) {
  const params = new URLSearchParams(location.search);
  // Custom pages are opened with ?base=<broker origin>&token=<token>; the built-in
  // page is served by the broker itself and falls back to location.origin.
  const baseUrl = String(opts.baseUrl || params.get("base") || location.origin).replace(/\/+$/, "");
  const token = opts.token !== undefined ? String(opts.token) : params.get("token") || "";
  const requests = new Map();
  const requestListeners = new Set();
  const updateListeners = new Set();
  const resolvedListeners = new Set();
  const snapshotListeners = new Set();
  const errorListeners = new Set();
  let closed = false;
  let source = null;

  const api = (path) => withToken(`${baseUrl}${path}`, token);
  const emit = (set, ...args) => {
    for (const fn of set) {
      try { fn(...args); } catch (e) { reportError(e); }
    }
  };
  const reportError = (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (typeof opts.onError === "function") {
      try { opts.onError(err); } catch { /* ignore */ }
    }
    emit(errorListeners, err);
  };
  const upsert = (request) => {
    if (!request || !request.id) return;
    const existed = requests.has(request.id);
    requests.set(request.id, request);
    if (!existed) emit(requestListeners, request);
    else emit(updateListeners, request.id, request.state || {}, request);
  };
  const remove = (id, result) => {
    requests.delete(id);
    emit(resolvedListeners, id, result);
  };
  const handle = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "snapshot") {
      requests.clear();
      for (const request of event.requests || []) upsert(request);
      emit(snapshotListeners, listPending());
    } else if (event.type === "request") {
      upsert(event.request);
    } else if (event.type === "update") {
      if (event.request) requests.set(event.id, event.request);
      emit(updateListeners, event.id, event.state || {}, event.request);
    } else if (event.type === "resolved") {
      remove(event.id, event.result);
    }
  };
  const listPending = () => [...requests.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const refresh = async () => {
    const body = await requestJson(api("/interactions/pending"));
    requests.clear();
    for (const request of body.requests || []) upsert(request);
    emit(snapshotListeners, listPending());
  };

  const connect = async () => {
    if (closed) return;
    if (source) {
      try { source.close(); } catch { /* ignore */ }
    }
    source = new EventSource(api("/interactions/events"));
    source.onmessage = (message) => {
      try { handle(JSON.parse(message.data)); } catch (e) { reportError(e); }
    };
    source.onerror = () => {
      // EventSource reconnects automatically. Re-sync on the next open so a lost
      // snapshot while the page was backgrounded is recovered.
    };
    source.onopen = () => {
      void refresh().catch(reportError);
    };
  };

  await refresh();
  await connect();

  return {
    token,
    baseUrl,
    get requests() { return listPending(); },
    onRequest(fn) { requestListeners.add(fn); return () => requestListeners.delete(fn); },
    onUpdate(fn) { updateListeners.add(fn); return () => updateListeners.delete(fn); },
    onResolved(fn) { resolvedListeners.add(fn); return () => resolvedListeners.delete(fn); },
    onSnapshot(fn) { snapshotListeners.add(fn); return () => snapshotListeners.delete(fn); },
    onError(fn) { errorListeners.add(fn); return () => errorListeners.delete(fn); },
    async answer(id, payload = {}) {
      return requestJson(api(`/interactions/${encodeURIComponent(id)}/answer`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    async cancel(id) {
      return requestJson(api(`/interactions/${encodeURIComponent(id)}/cancel`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    },
    async resync() {
      await refresh();
    },
    close() {
      closed = true;
      try { source?.close(); } catch { /* ignore */ }
      source = null;
    },
  };
}
