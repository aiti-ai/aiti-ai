import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import { withBasePath } from "@/lib/base-path";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";

// next/font/google requires fetching Noto Sans Mono from Google Fonts at
// build time — unreachable on CN networks, so use a local system mono stack
// instead (the CSS var keeps its name so globals.css needs no change).
const notoSansMono = { variable: "--font-noto-mono" };

export const metadata: Metadata = {
  title: "Pi Web",
  description: "Pi Web interface for the pi coding agent",
  applicationName: "Pi Web",
  manifest: withBasePath("/manifest.webmanifest"),
  icons: {
    icon: [
      {
        url: withBasePath("/icons/icon-192.png"),
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: withBasePath("/icons/apple-touch-icon.png"),
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pi Web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className={`${notoSansMono.variable} notranslate`} suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");var dark=t==="dark"||((t==null||t===""||t==="auto")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(dark)document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            // 在 React hydrate 前同步探测界面语言，写入 window.__PI_LOCALE__
            // 供 I18nProvider 懒初始化读取，同时写 cookie 供下次 SSR 命中。
            // 注意：try 块必须包住下方赋值，不能提前闭合（否则 catch 孤儿 → 整个内联脚本解析失败）。
            __html: `(function(){try{var l=localStorage.getItem("pi-locale");if(l!=="en"&&l!=="zh-CN"){var langs=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];for(var i=0;i<langs.length;i++){var n=langs[i].toLowerCase();if(n==="zh"||n.startsWith("zh-")){l="zh-CN";break}if(n==="en"||n.startsWith("en-")){l="en";break}}if(!l)l="en"}window.__PI_LOCALE__=l;document.documentElement.lang=l;document.cookie="pi-locale="+l+";path=/;max-age=31536000;SameSite=Lax"}catch(e){window.__PI_LOCALE__="en"}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            // 全局静默良性 ResizeObserver loop 报错（同一帧内布局反复变化，通知延后送达，
            // 浏览器按 uncaught error 派发；页面 ResizeObserver 众多 + 流式输出/拖动窗口时偶发，非功能 bug）。
            // 必须内联在 head：Next app-globals 启动即注册自己的 window error listener 且不检查
            // defaultPrevented，只有比它先注册并 stopImmediatePropagation 才能拦住 dev overlay 弹窗。
            __html: `(function(){window.addEventListener("error",function(e){try{var m=e.message||"";if(m.indexOf("ResizeObserver loop")===0){e.stopImmediatePropagation();e.preventDefault()}}catch(err){}})})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
        <PwaRegistration />
        {/* crash-rescue 场景③（编译期错误）：dev overlay Build Error → 引导进 /rescue.html（public/ 静态页，
            不进编译图，模块图坏时依然可达）。仅监听 dev overlay（<nextjs-portal>），prod 天然惰性。
            全新加载时 500 错误页不含本 layout，由 nginx /dev location sub_filter 注入同一脚本兑底。 */}
        <script src={withBasePath("/rescue-hook.js")} async />
      </body>
    </html>
  );
}
