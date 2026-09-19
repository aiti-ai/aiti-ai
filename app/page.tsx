import { Suspense } from "react";
import { cookies, headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { getSlotDeclarations } from "@/lib/ext/registry";
import { I18nProvider } from "@/hooks/useI18n";
import { resolveBrowserLocale } from "@/lib/i18n/registry";
import type { Locale } from "@/lib/i18n/types";

/**
 * Server-side detection of the initial UI locale: read the pi-locale cookie
 * first (written by the inline script in <head>), falling back to parsing the
 * Accept-Language header when missing. Lets the very first SSR render already
 * match the user's language, avoiding a client-side re-switch.
 */
async function detectInitialLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const cookieVal = cookieStore.get("pi-locale")?.value;
  if (cookieVal === "en" || cookieVal === "zh-CN") return cookieVal;

  const headerStore = await headers();
  const acceptLang = headerStore.get("accept-language");
  if (acceptLang) {
    const langs = acceptLang.split(",").map((l) => l.split(";")[0].trim()).filter(Boolean);
    return resolveBrowserLocale(langs);
  }
  return "en";
}

export default async function Home() {
  const initialLocale = await detectInitialLocale();
  // [startup design §5] Server-authoritative slot declaration table: the first
  // frame can already decide "who takes over slots such as sidebarContent" —
  // when a takeover exists, the host fallback sidebar is not mounted (otherwise
  // it would immediately fetch a full /api/sessions only to be replaced).
  // Returns null when the registry is not ready (the client treats that as
  // "unknown" and behavior falls back to the original logic).
  const slotDeclarations = getSlotDeclarations();
  return (
    <Suspense>
      <I18nProvider initialLocale={initialLocale}>
        <AppShell extSlotDeclarations={slotDeclarations} />
      </I18nProvider>
    </Suspense>
  );
}
