/**
 * PiWebTitle — the host sidebar title (Pi Web + version easter egg + online docs link).
 *
 * Standalone module (unified dock design §7-2): AppShell lazy-loads SessionSidebar via
 * next/dynamic (loaded only in the fallback state), but the takeover-state Header still
 * needs this component — extracting it here allows a static import without dragging
 * SessionSidebar/FileExplorer back into the main bundle.
 */
import { useState, useEffect, useRef, useCallback } from "react";

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

/** Host sidebar title (Pi Web + version easter egg + docs link). In takeover state it is
 *  passed through to the extension Header via the sidebarContent extra's renderTitle
 *  factory (unified dock design §3.4 component factory contract). */
export function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 3, minWidth: "6ch" }}>
      <button
        onClick={handleClick}
        style={{
          background: "none", border: "none", padding: 0, cursor: "default",
          fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
          color: showVersion ? "var(--accent)" : "var(--text)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {display}
      </button>
      {/* Online docs link (NEXT_PUBLIC_DOCS_URL, hidden when unset) — clicking the title remains the version easter egg; ↗ is the external link */}
      {process.env.NEXT_PUBLIC_DOCS_URL && (
        <a
          href={process.env.NEXT_PUBLIC_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="Docs"
          aria-label="Docs"
          style={{
            fontSize: 12, lineHeight: 1, padding: "0 1px",
            color: "var(--text-muted)", textDecoration: "none", cursor: "pointer",
            transition: "color 0.12s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          ↗
        </a>
      )}
    </span>
  );
}

