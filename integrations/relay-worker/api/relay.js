// Minimal Vercel Edge Relay Worker for pi-freeflow
// Deploy: push this as api/relay.js + vercel.json, or use Vercel CLI

const ALLOWED_TARGETS = ["https://opencode.ai", "https://api.kilo.ai"];

export const config = { runtime: "edge" };

export default async function handler(req) {
  if (!["GET", "POST", "HEAD", "OPTIONS"].includes(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const target = req.headers.get("x-relay-target");
  if (!target) {
    return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // Validate target
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: "invalid x-relay-target" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return new Response(JSON.stringify({ error: "forbidden protocol" }), { status: 403 });
  }

  const cleanTarget = target.replace(/\/$/, "");
  if (!ALLOWED_TARGETS.includes(cleanTarget)) {
    return new Response(JSON.stringify({ error: "Forbidden target" }), { status: 403 });
  }

  // Resolve relay path
  const relayPath = req.headers.get("x-relay-path") || "/";
  let finalUrl;
  try {
    finalUrl = new URL(relayPath, targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: "forbidden path" }), { status: 403 });
  }

  if (finalUrl.hostname !== targetUrl.hostname) {
    return new Response(JSON.stringify({ error: "host mismatch" }), { status: 403 });
  }

  // Forward request
  const headers = new Headers(req.headers);
  ["host", "connection", "content-length", "x-relay-target", "x-relay-path", "x-relay-auth"].forEach(h => headers.delete(h));

  try {
    const init = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = req.body;
      init.duplex = "half";
    }
    const response = await fetch(finalUrl.toString(), init);
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 502 });
  }
}
