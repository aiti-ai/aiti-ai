// Shared tolerant-parsing helpers for usage payload normalizers.
// Field-missing → skip; missing critical data → throw (fail-soft per adapter).

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80);
  return cleaned || undefined;
}

export function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

export function nonnegative(value: unknown): number | undefined {
  const result = number(value);
  return result !== undefined && result >= 0 ? result : undefined;
}

export function nonnegativeInteger(value: unknown): number | undefined {
  const result = nonnegative(value);
  return result !== undefined && Number.isSafeInteger(result) ? result : undefined;
}

export function decimal(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value) && value.length <= 64) return value;
  return undefined;
}

export function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Epoch seconds from ms/seconds numbers or ISO strings (reset timestamps). */
export function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1_000);
  }
  const numeric = number(value);
  if (numeric === undefined) return undefined;
  // Values >= 1e12 are milliseconds; smaller values are already epoch seconds.
  return Math.floor(numeric >= 1e12 ? numeric / 1_000 : numeric);
}

export function windowLabel(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "Limit";
  const minutes = Math.ceil(seconds / 60);
  if (minutes >= 10_080) return "Weekly";
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}
