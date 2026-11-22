type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
  onClose: () => void;
}

export function SystemPromptPanel({ loading, prompt, translate, onClose }: Props) {
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      {/* Header bar: title + close at the top-right (parity with the session-info
          popover's sticky top bar in AppShell). */}
      <div className="system-prompt-header">
        <span className="system-prompt-title">{translate("system.prompt")}</span>
        <button
          type="button"
          className="system-prompt-close"
          title={translate("i18n.close")}
          aria-label={translate("i18n.close")}
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className="system-prompt-scroll">
        {prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-header {
          display: flex;
          flex-shrink: 0;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 16px 7px;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-title {
          color: var(--text);
          font-size: 11px;
          font-weight: 700;
        }
        .system-prompt-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          padding: 0;
          color: var(--text-muted);
          background: var(--bg-panel);
          border: 1px solid var(--border);
          border-radius: 4px;
          cursor: pointer;
          flex: 0 0 auto;
          transition: color 0.12s, border-color 0.12s;
        }
        .system-prompt-close:hover {
          color: var(--accent);
          border-color: var(--accent);
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
