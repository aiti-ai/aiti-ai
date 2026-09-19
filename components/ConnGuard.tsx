"use client";

import { useEffect } from "react";
import { installConnGuard } from "@/lib/conn-guard";

/** Mount point for the app-wide connection-pool anti-deadlock guard: installs the fetch observer once in the root layout (idempotent). */
export function ConnGuard() {
  useEffect(() => {
    installConnGuard();
  }, []);
  return null;
}
