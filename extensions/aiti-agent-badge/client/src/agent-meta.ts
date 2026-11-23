/**
 * Agent display metadata for the badge.
 *
 * Colors / short labels intentionally match session-manager's list badges so
 * the same agent reads the same in the sidebar and the composer. Descriptions
 * live in the extension i18n table (`badge.agent.<key>.desc`).
 */

export const AGENT_META = {
  pi: { short: "Pi", color: "#0ea5e9" },
  claude: { short: "CC", color: "#d97757" },
  qoder: { short: "Qo", color: "#22c55e" },
  qodercn: { short: "Qc", color: "#16a34a" },
  codex: { short: "Cx", color: "#6366f1" },
  gemini: { short: "Gx", color: "#3b82f6" },
  trae: { short: "Tr", color: "#06b6d4" },
  cursor: { short: "Cu", color: "#8b5cf6" },
  "cursor-ide": { short: "Ci", color: "#a78bfa" },
  opencode: { short: "Oc", color: "#ec4899" },
  zcode: { short: "Zc", color: "#38bdf8" },
  codebuddy: { short: "Cb", color: "#0052d9" },
  dsh: { short: "Ds", color: "#f97316" },
  windsurf: { short: "Dv", color: "#06b6d4" },
  cline: { short: "Cl", color: "#f59e0b" },
  goose: { short: "Go", color: "#84cc16" },
  amp: { short: "Am", color: "#e11d48" },
  factory: { short: "Fx", color: "#8b5cf6" },
  antigravity: { short: "Ag", color: "#1a73e8" },
  acp: { short: "Acp", color: "#8b5cf6" },
  omp: { short: "Omp", color: "#f97316" },
  default: { short: "Ai", color: "#64748b" },
};

export function agentMeta(agent: string) {
  return AGENT_META[agent] ?? AGENT_META.default;
}

/** Short badge text; unknown agents fall back to two readable characters. */
export function agentShort(agent: string, label?: string) {
  const meta = agentMeta(agent);
  if (meta !== AGENT_META.default) return meta.short;
  const text = String(label || agent || "AI").trim();
  return text.slice(0, 2).toUpperCase() || "AI";
}

const luminance = (hex: string): number => {
  const value = String(hex).replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const channel = (index: number): number => {
    let c = parseInt(full.slice(index, index + 2), 16) / 255;
    c = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return c;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
};

const contrast = (a: string, b: string): number => {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const blend = (a: string, b: string, ratio: number): string => {
  const parse = (hex: string): number[] => [0, 2, 4].map((i) => parseInt(String(hex).replace("#", "").slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const to = (value: number): string => Math.round(value).toString(16).padStart(2, "0");
  return "#" + [r1 + (r2 - r1) * ratio, g1 + (g2 - g1) * ratio, b1 + (b2 - b1) * ratio].map(to).join("");
};

/** Keep brand colors readable on the current panel background. */
export function ensureReadability(hex: string, ratio = 5.5): string {
  try {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
    const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    const background = dark ? "#242424" : "#f5f5f5";
    if (contrast(hex, background) >= ratio) return hex;
    const anchor = dark ? "#e8e8e8" : "#1a1a1a";
    let low = 0;
    let high = 1;
    for (let i = 0; i < 10; i++) {
      const mid = (low + high) / 2;
      if (contrast(blend(hex, anchor, mid), background) >= ratio) high = mid;
      else low = mid;
    }
    return blend(hex, anchor, high);
  } catch {
    return hex;
  }
}
