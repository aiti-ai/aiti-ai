/**
 * State payload for a handle-backed session (attach / spawn / extension backends).
 *
 * The frontend contract is `AgentStateResponse` in `hooks/useAgentSession.ts`:
 * `capabilities` and `backendSource` are read from *inside* `state`
 * (`liveState.capabilities` / `liveState.backendSource`). A top-level copy never
 * reaches the client, which left bridged/spawn sessions without capabilities —
 * edit-from-here then took the local `navigate_tree` path and the pi spawn
 * backend answered `Capability "navigate_tree" is not supported` (HTTP 500),
 * so the edit silently did nothing.
 *
 * Both /api/sessions/[id]/state branches (bridged adapters and wrapped provider
 * handles) go through here so the declaration cannot drift from its reader again.
 */
export function mergeHandleState(
  state: Record<string, unknown> | null | undefined,
  capabilities: unknown,
  backendSource: string | undefined,
): Record<string, unknown> | null {
  const extra = {
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(backendSource !== undefined ? { backendSource } : {}),
  };
  if (state) return { ...state, ...extra };
  // No get_state payload (dead/slow backend): keep the declarations readable —
  // the old wrapped branch already returned a capabilities-only object here.
  return Object.keys(extra).length > 0 ? extra : null;
}
