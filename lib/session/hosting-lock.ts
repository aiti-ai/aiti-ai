/**
 * Hosting-switch single-flight registry.
 *
 * A switch stops the old agent process before starting the new one. Session
 * read routes (`/api/sessions/[id]`, `/state`) that land in this window would
 * otherwise see no live handle / a mid-rewrite placeholder and return 404
 * (observed as a console error after switching an external agent). They await
 * the in-flight switch instead.
 *
 * globalThis: dev/HMR module copies must share one registry.
 */

type SwitchFlight = Promise<unknown>;

declare global {
  var __sessionHostingSwitchFlights: Map<string, SwitchFlight> | undefined;
}

function flights(): Map<string, SwitchFlight> {
  if (!globalThis.__sessionHostingSwitchFlights) globalThis.__sessionHostingSwitchFlights = new Map();
  return globalThis.__sessionHostingSwitchFlights;
}

export function hostingSwitchFlight(id: string): SwitchFlight | undefined {
  return id ? flights().get(id) : undefined;
}

export function trackHostingSwitch(id: string, flight: SwitchFlight): void {
  if (!id) return;
  flights().set(id, flight);
  void flight.finally(() => {
    if (flights().get(id) === flight) flights().delete(id);
  }).catch(() => undefined);
}

/** Await an in-flight switch for this id (no-op when none). */
export async function waitForHostingSwitch(id: string): Promise<void> {
  const flight = hostingSwitchFlight(id);
  if (flight) await flight.catch(() => undefined);
}
