"use client";

import { useEffect, useState } from "react";

/** Helper for yielding to connection-pool starvation (deadlock-free; lib/conn-guard):
 *  yield/rebuild signals for file/media watch-style SSE connections.
 *
 *  Uses the window "piwe-conn-starve" broadcast protocol (same channel as the
 *  running broker / bridge-client).
 *
 *  Usage: reference the returned starved / epoch inside a watch useEffect (add
 *  them to the dependency array):
 *    const { starved: connStarved, epoch: connEpoch } = useConnStarvation();
 *    useEffect(() => {
 *      if (connStarved) return;          // starved: do not connect (cleanup already closed the old connection)
 *      ...existing connection logic...
 *    }, [...existing deps, connStarved, connEpoch]);
 *  starve → epoch increments → the effect re-runs, cleanup closes the old connection and the gate
 *  prevents rebuilding (freeing the socket so fetch can get through);
 *  unstarve → epoch increments again → the effect re-runs and rebuilds the connection.
 *  Fully event-driven, zero polling. */
export function useConnStarvation(): { starved: boolean; epoch: number } {
  const [state, setState] = useState({ starved: false, epoch: 0 });
  useEffect(() => {
    const handler = (ev: Event) => {
      const starved = Boolean((ev as CustomEvent<{ starved?: boolean }>).detail?.starved);
      setState((prev) => (prev.starved === starved ? prev : { starved, epoch: prev.epoch + 1 }));
    };
    window.addEventListener("piwe-conn-starve", handler);
    return () => window.removeEventListener("piwe-conn-starve", handler);
  }, []);
  return state;
}
