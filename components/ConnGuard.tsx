"use client";

import { useEffect } from "react";
import { installConnGuard } from "@/lib/conn-guard";

/** 全页连接池防抱死守护挂载点：在根布局安装一次 fetch 观测（幂等）。 */
export function ConnGuard() {
  useEffect(() => {
    installConnGuard();
  }, []);
  return null;
}
