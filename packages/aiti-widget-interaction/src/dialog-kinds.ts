import type { InteractionRequestInput, InteractionResult } from "./types.ts";

export type DialogKind = "confirm" | "choose" | "input" | "form" | "file" | "directory" | "notify" | "custom";

export interface DialogSpec {
  kind: DialogKind;
  /** Main question/instruction (zenity --text). */
  text?: string;
  /** Card title; also the window title. */
  title?: string;
  detail?: string;
  okLabel?: string;
  cancelLabel?: string;
  options?: string[];
  defaultValue?: string;
  placeholder?: string;
  password?: boolean;
  /** Multi-field form (zenity --forms). */
  fields?: Array<{
    label: string;
    type?: "text" | "password" | "number" | "combo";
    options?: string[];
    required?: boolean;
    placeholder?: string;
    defaultValue?: string;
    pattern?: string;
  }>;
  /** Joins form values on stdout (default "|"). */
  separator?: string;
  /** Input validation regex (kind=input). */
  pattern?: string;
  multiple?: boolean;
  /** Glob filters, e.g. ["*.png", "*.jpg"]. */
  filters?: string[];
  /** Milliseconds; 0/undefined = wait forever. */
  timeoutMs?: number;
  /** Custom page URL (kind=custom). */
  page?: string;
  /** Arbitrary host payload for custom pages. */
  data?: unknown;
}

const DEFAULT_TITLES: Record<Exclude<DialogKind, "custom">, string> = {
  confirm: "Confirm",
  choose: "Choose",
  input: "Input",
  form: "Form",
  file: "Choose file",
  directory: "Choose folder",
  notify: "Notice",
};

/** Map a CLI dialog spec onto the shared interaction protocol. */
export function dialogToRequest(spec: DialogSpec): InteractionRequestInput {
  const text = String(spec.text || "");
  const title = String(spec.title || DEFAULT_TITLES[spec.kind as Exclude<DialogKind, "custom">] || "aiti-dialog");
  const detail = String(spec.detail || "");
  const timeoutMs = Math.max(0, Number(spec.timeoutMs) || 0);
  const ok = String(spec.okLabel || (spec.kind === "confirm" ? "OK" : "OK"));
  const cancel = String(spec.cancelLabel || "Cancel");

  if (spec.kind === "confirm") {
    return {
      kind: "confirm",
      title,
      message: text,
      detail,
      timeoutMs,
      actions: [
        { id: "approve", label: ok, kind: "primary", value: true },
        { id: "reject", label: cancel, kind: "secondary", value: false },
      ],
    };
  }
  if (spec.kind === "choose") {
    const options = (spec.options || []).map((option) => String(option)).filter(Boolean);
    if (!options.length) throw new Error("choose requires at least one --options value");
    return { kind: "choose", title, message: text, detail, timeoutMs, options: options.map((option) => ({ id: option, label: option })), actions: [] };
  }
  if (spec.kind === "input") {
    return {
      kind: "input",
      title,
      message: text,
      detail,
      timeoutMs,
      input: {
        placeholder: String(spec.placeholder || ""),
        defaultValue: String(spec.defaultValue || ""),
        secret: spec.password === true,
        pattern: spec.pattern ? String(spec.pattern) : undefined,
      },
      actions: [{ id: "submit", label: ok, kind: "primary" }],
    };
  }
  if (spec.kind === "form") {
    const fields = (spec.fields || []).map((field, index) => {
      const type = field.type === "password" || field.type === "number" || field.type === "combo" ? field.type : "text";
      return {
        id: `f${index + 1}`,
        label: String(field.label || `Field ${index + 1}`),
        type,
        placeholder: field.placeholder ? String(field.placeholder) : undefined,
        defaultValue: field.defaultValue !== undefined ? String(field.defaultValue) : undefined,
        options: type === "combo" ? (field.options || []).map(String) : undefined,
        required: field.required === true,
        pattern: field.pattern ? String(field.pattern) : undefined,
      };
    });
    if (!fields.length) throw new Error("form requires at least one field");
    return {
      kind: "form",
      title,
      message: text,
      detail,
      timeoutMs,
      form: { fields, separator: String(spec.separator || "|") },
      actions: [
        { id: "submit", label: ok, kind: "primary" },
        { id: "cancel", label: cancel, kind: "secondary" },
      ],
    };
  }
  if (spec.kind === "file" || spec.kind === "directory") {
    return {
      kind: "pick_path",
      title,
      message: text,
      detail,
      timeoutMs,
      pick: {
        mode: spec.kind === "directory" ? "directory" : "file",
        multiple: spec.multiple === true,
        extensions: (spec.filters || []).map((f) => String(f)),
      },
      actions: [
        { id: "pick", label: ok, kind: "primary" },
        { id: "cancel", label: cancel, kind: "secondary" },
      ],
    };
  }
  if (spec.kind === "notify") {
    return {
      kind: "notify",
      title,
      message: text,
      detail,
      timeoutMs,
      actions: [{ id: "dismiss", label: ok, kind: "primary" }],
    };
  }
  // custom
  return {
    kind: "custom",
    title,
    message: text,
    detail,
    timeoutMs,
    custom: { pageUrl: String(spec.page || ""), data: spec.data },
    data: spec.data,
    actions: [],
  };
}

/**
 * zenity-compatible exit code: 0 answered, 1 cancelled, 5 timeout.
 * Callers map 2 (usage) / 4 (runtime) themselves.
 */
export function dialogExitCode(result: InteractionResult): number {
  if (result.status === "timeout") return 5;
  if (result.status === "cancelled") return 1;
  if (result.status === "error") return 4;
  if (result.action === "cancel" || result.action === "reject") return 1;
  if (result.approved === false) return 1;
  return 0;
}

function stringValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.label === "string") return record.label;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.paths)) return record.paths.map(String).join("\n");
    if (typeof record.path === "string") return record.path;
    if (typeof record.id === "string") return record.id;
  }
  return "";
}

/** Value printed on stdout (one path per line for file/directory picks). */
export function dialogStdout(result: InteractionResult, spec: DialogSpec): string {
  if (result.status !== "answered") return "";
  if (spec.kind === "confirm") return "";
  if (spec.kind === "notify") return "";
  if (spec.kind === "form") {
    const form = result.value as { values?: Record<string, string>; order?: string[] } | undefined;
    const separator = spec.separator ?? "|";
    if (form && form.values) {
      const order = form.order && form.order.length ? form.order : Object.keys(form.values);
      return order.map((id) => String(form.values?.[id] ?? "")).join(separator);
    }
    return "";
  }
  const fromValue = stringValue(result.value);
  if (fromValue) return fromValue;
  if (spec.kind === "input") return "";
  return "";
}

/** Window title shown by the shell (falls back to the card title). */
export function dialogWindowTitle(spec: DialogSpec): string {
  return String(spec.title || DEFAULT_TITLES[spec.kind as Exclude<DialogKind, "custom">] || "aiti-dialog");
}

/** Suggested initial window size per kind. */
export function dialogWindowSize(spec: DialogSpec): { width: number; height: number } {
  if (spec.kind === "confirm") return { width: 420, height: 190 };
  if (spec.kind === "notify") return { width: 400, height: 160 };
  if (spec.kind === "input") return { width: 460, height: 230 };
  if (spec.kind === "choose") {
    const rows = Math.max(1, Math.min(8, (spec.options || []).length));
    return { width: 460, height: 170 + rows * 34 };
  }
  if (spec.kind === "form") {
    const rows = Math.max(1, Math.min(10, (spec.fields || []).length));
    return { width: 480, height: 190 + rows * 58 };
  }
  if (spec.kind === "file" || spec.kind === "directory") return { width: 460, height: 210 };
  return { width: 560, height: 300 };
}

/** Placement flags shared by every dialog kind (`--x/--y/--display/--center`). */
export interface DialogPlacementInput {
  x?: string | number;
  y?: string | number;
  display?: string | number;
  center?: boolean;
}

export interface DialogPlacement {
  x?: number;
  y?: number;
  display?: string | number;
  center?: boolean;
}

/**
 * Normalize CLI placement flags for the widget window.
 *
 * Duplicated/NaN coordinates are dropped instead of forwarding garbage to the shell;
 * `--display` stays a string so monitor names ("HDMI-A-0", "primary") pass through.
 */
export function dialogWindowPlacement(input: DialogPlacementInput = {}): DialogPlacement {
  const number = (value: string | number | undefined): number | undefined => {
    if (value === undefined || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const display = input.display === undefined || input.display === "" ? undefined : input.display;
  const placement: DialogPlacement = {};
  const x = number(input.x);
  const y = number(input.y);
  if (x !== undefined) placement.x = x;
  if (y !== undefined) placement.y = y;
  if (display !== undefined) placement.display = display;
  if (input.center === true) placement.center = true;
  return placement;
}
