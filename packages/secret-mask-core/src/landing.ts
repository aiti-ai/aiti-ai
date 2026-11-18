/**
 * Landing policy (G1): where real values are allowed to live on disk.
 *
 *   plain      values stay in the session file (current behaviour) — they can
 *              be recovered by grepping the session; the leak surface is
 *              "anything that can read ~/.pi/agent/sessions".
 *   vault      on-disk redaction ON + values are led into the encrypted vault
 *              (the vault package implements the landing callback).
 *   ephemeral  on-disk redaction ON + values exist only in this process
 *              memory; they vanish when the process exits (by design).
 *
 * This module only owns the policy; the hooks that apply it (message_end and
 * friends) live in the host packages.
 */

export type LandingMode = "plain" | "vault" | "ephemeral";

export const LANDING_MODES: readonly LandingMode[] = ["plain", "vault", "ephemeral"];

/** Modes a mask-only host supports (no library to receive values). */
export const MASK_LANDING_MODES: readonly LandingMode[] = ["plain", "ephemeral"];

export const DEFAULT_LANDING: LandingMode = "plain";

export function isLandingMode(value: string): value is LandingMode {
  return (LANDING_MODES as readonly string[]).includes(value);
}

/** True when persisted messages must be scrubbed at message_end. */
export function redactOnDisk(mode: LandingMode): boolean {
  return mode !== "plain";
}

export function landingText(mode: LandingMode): string {
  switch (mode) {
    case "plain":
      return "plain — values stay in the session file (grep-able; recovery works by re-detection or /secret load)";
    case "vault":
      return "vault — session file is redacted; values are stored in the encrypted vault (/vault add) and re-mount via vault_get";
    case "ephemeral":
      return "ephemeral — session file is redacted; values live in this process only and are unrecoverable after exit";
  }
}

export function landingChangeWarning(next: LandingMode, previous: LandingMode): string | undefined {
  if (next === previous) return undefined;
  if (next === "ephemeral") return "ephemeral: values registered from now on are not persisted anywhere — if you lose this process you must provide them again.";
  if (next === "vault") return "vault: new values should be entered with /vault add (encrypted, cross-session). Session-only values stay in memory.";
  if (next === "plain") return "plain: messages from now on keep real values in the session file again.";
  return undefined;
}
