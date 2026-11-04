import { useEffect, useState } from "react";

/** 小屏判定（matchMedia，无宿主依赖——dialogs 槽 props 不携带 isMobile）。 */
export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 640px)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}
