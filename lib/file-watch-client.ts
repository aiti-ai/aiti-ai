// Bus adapter helper for file watches (single SSE convergence for page events; a FileViewer-specific
// wrapper over lib/event-bus-client.ts): when the bus is available → POST a wantWatch ticket to register
// (the server side in lib/file-watch-registry starts fs.watch inline) + subscribe to the bus "file-watch"
// type filtered by watchId; once the ticket succeeds, dispatch the named "connected" event (the original
// SSE connection-established semantics: the watcher is in place, so the caller can pull a snapshot right
// then without a gap). When unavailable → return null, and the caller falls back to the plain watch SSE
// (buildTicketUrl → EventSource).
//
// Frame→named-event reassembly is done by this adapter (change/gone/error are field-for-field identical
// to the original SSE), so the caller's connected/change/error listeners need zero changes.
// Lifecycle: close() unsubscribes + POSTs /api/files/watch-stop (the server also auto-stops after 30min
// idle as a backstop).
import { getEventBus, type BusEventSource } from "./event-bus-client.ts";
import { apiUrl } from "./base-path.ts";

export function openFileWatchBus(filePath: string): BusEventSource | null {
  const bus = getEventBus(`/api/files/watch?path=${encodeURIComponent(filePath)}`, {
    topic: "file-watch",
  });
  if (!bus) return null;

  let watchId: string | null = null;
  let closed = false;
  const stopRemote = (id: string) => {
    void fetch(apiUrl("/api/files/watch-stop"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watchId: id }),
    }).catch(() => { /* noop: the 30min idle auto-stop is the backstop */ });
  };

  // Override close: unsubscribe from the bus + explicit watch-stop (the component cleanup's es.close() lands here)
  const originalClose = bus.close.bind(bus);
  bus.close = () => {
    if (closed) return;
    closed = true;
    originalClose();
    if (watchId) stopRemote(watchId);
  };

  // Ticket registration (wantWatch): success → named "connected"; failure → onerror (caller marks disconnected)
  void fetch(apiUrl("/api/files/ticket"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, type: "watch", wantWatch: true }),
  })
    .then((r): Promise<{ watchId?: string } | null> => (r.ok ? r.json() : Promise.resolve(null)))
    .then((t) => {
      if (closed) {
        // Closed in the meantime: the server may already have registered → stop immediately (explicit cleanup ahead of the 30min backstop, leak prevention)
        if (t?.watchId) stopRemote(t.watchId);
        return;
      }
      if (!t?.watchId) {
        bus.onerror?.(new Event("error"));
        return;
      }
      watchId = t.watchId;
      bus.dispatchNamed("connected", { type: "connected", filePath });
    })
    .catch(() => {
      if (!closed) bus.onerror?.(new Event("error"));
    });

  return bus;
}
