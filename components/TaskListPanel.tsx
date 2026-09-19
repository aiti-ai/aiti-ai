"use client";
/**
 * TaskListPanel · Session task-list panel (read-only mirror of the agent's
 * working plan).
 *
 * Data source: useAgentSession task_update events + get_state seed (backend
 * sessions derive it from TodoWrite-family tool events; the protocol has no
 * write methods → display only, no operation primitives of any kind).
 * Auto-expands while a task is in progress, collapses when everything is
 * completed/pending; renders nothing when tasks is empty (harmless on backends
 * where it is always empty).
 * Ref: internal design doc (agent task-list panel) §2.3-P4.
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export type SessionTask = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: string;
};

const STATUS_ICON: Record<SessionTask["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
};

export function TaskListPanel({ tasks }: { tasks: SessionTask[] }) {
  const { t } = useI18n();
  const hasActive = tasks.some((task) => task.status === "in_progress");
  // Activity follow: any in_progress → expand; all completed/pending → collapse
  // (manual toggles still snap back to follow activity)
  const [expanded, setExpanded] = useState(hasActive);
  useEffect(() => { setExpanded(hasActive); }, [hasActive]);

  if (tasks.length === 0) return null;
  const done = tasks.filter((task) => task.status === "completed").length;
  const current = tasks.find((task) => task.status === "in_progress");

  return (
    <div style={{
      marginBottom: 8,
      border: "1px solid var(--border)",
      borderRadius: 6,
      background: "var(--bg-panel)",
      overflow: "hidden",
    }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={t("chat.tasksToggle")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          border: "none",
          background: "transparent",
          color: "var(--fg)",
          cursor: "pointer",
          padding: "6px 10px",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{t("chat.tasksProgress").replace("{done}", String(done)).replace("{total}", String(tasks.length))}</span>
        {current && (
          <span style={{ color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {STATUS_ICON.in_progress} {current.content}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "var(--fg-muted)", whiteSpace: "nowrap" }}>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <ul style={{ margin: 0, padding: "2px 10px 7px 10px", listStyle: "none", borderTop: "1px solid var(--border)" }}>
          {tasks.map((task, i) => (
            <li key={`${i}-${task.content.slice(0, 24)}`} style={{
              display: "flex",
              alignItems: "baseline",
              gap: 6,
              padding: "2px 0",
              fontSize: 11,
              lineHeight: 1.5,
              ...(task.status === "completed" ? { color: "var(--fg-muted)", textDecoration: "line-through" } : {}),
              ...(task.status === "in_progress" ? { fontWeight: 600 } : {}),
            }}>
              <span style={{ whiteSpace: "nowrap" }} aria-hidden>{STATUS_ICON[task.status]}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{task.content}</span>
              {task.priority === "high" && task.status !== "completed" && (
                <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>high</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
