// Shared JSON response helper for route handlers.
//
// Deliberately NO Content-Encoding negotiation here: Next 16.4.6 strips
// route-handler "Content-Encoding" headers while keeping the compressed body,
// so a self-gzipped response reached nginx without its encoding declaration
// and the edge re-compression layer (conf.d/pi-web.conf) wrapped it in a
// second gzip layer — browsers then decoded one layer and handed raw gzip
// bytes to response.json() ("Unexpected token ''"). Regression proven by the
// minimal-repro matrix: pure Next 16.4.4 keeps the header, pure 16.4.6 strips
// it. Compression stays at the edge (nginx), exactly once.
export function jsonResponse(
  _request: Request,
  data: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
