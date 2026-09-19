/**
 * PiWebTitle —— 宿主左栏标题（Pi Web + 版本彩蛋 + 在线文档链接）。
 *
 * 独立模块（统一 dock 方案 §7-2）：AppShell 对 SessionSidebar 做 next/dynamic 懒加载
 * （回退态才加载），而接管态 Header 仍需本组件——抽到这里可静态导入且不把
 * SessionSidebar/FileExplorer 拖回主包。
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

/** 宿主左栏标题（Pi Web + 版本彩蛋 + 文档链接）。接管态经 sidebarContent extra
 *  的 renderTitle 工厂透传给扩展 Header（统一 dock 方案 §3.4 组件工厂契约）。 */
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
      {/* 在线文档链接（NEXT_PUBLIC_DOCS_URL，未设置则隐藏）——点标题仍是版本号彩蛋，↗ 才是外链 */}
      {process.env.NEXT_PUBLIC_DOCS_URL && (
        <a
          href={process.env.NEXT_PUBLIC_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          title="文档"
          aria-label="文档"
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

