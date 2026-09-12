import { Suspense } from "react";
import { cookies, headers } from "next/headers";
import { AppShell } from "@/components/AppShell";
import { getSlotDeclarations } from "@/lib/ext/registry";
import { I18nProvider } from "@/hooks/useI18n";
import { resolveBrowserLocale } from "@/lib/i18n/registry";
import type { Locale } from "@/lib/i18n/types";

/**
 * 服务端探测初始界面语言：优先读 pi-locale cookie（由 <head> 内联脚本写入），
 * 缺失时解析 Accept-Language 头。让 SSR 首次渲染即命中用户语言，避免客户端二次切换。
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
  // [开页方案 §5] 服务端权威的插槽声明表：首帧就能裁决「谁接管 sidebarContent 等槽」——
  // 有接管者时不挂宿主回退侧栏（否则它会立即拉一次全量 /api/sessions 又被替换）。
  // 注册表未就绪返回 null（客户端按「未知」处理，行为回退到原逻辑）。
  const slotDeclarations = getSlotDeclarations();
  return (
    <Suspense>
      <I18nProvider initialLocale={initialLocale}>
        <AppShell extSlotDeclarations={slotDeclarations} />
      </I18nProvider>
    </Suspense>
  );
}
