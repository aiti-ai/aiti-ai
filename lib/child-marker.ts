/**
 * Node-only env marker stamping.
 *
 * Must live in a dynamically imported module (never statically imported from
 * instrumentation.ts): turbopack compiles instrumentation.ts for the Edge
 * runtime too, and its static analysis flags `process.pid` as an unsupported
 * Node API — an "Ecmascript file had an error" compile failure that makes the
 * dev server recompile (and push a Fast Refresh) on *every* request.
 */
export function stampChildMarker(): void {
  process.env.PI_WEB_CHILD_MARKER ??= `pi-web-${process.pid}-${Date.now().toString(36)}`;
}
