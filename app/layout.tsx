import type { Metadata, Viewport } from "next";
import { ConnGuard } from "@/components/ConnGuard";
import { PwaRegistration } from "@/components/PwaRegistration";
import { withBasePath } from "@/lib/base-path";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";
import "./sidebar.css";
import "./sidebar-menu.css";

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
            __html: THEME_INIT_SCRIPT,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            // Probe the UI language synchronously before React hydrates and write
            // window.__PI_LOCALE__ for I18nProvider's lazy init; also set a cookie
            // so the next SSR hit matches.
            // Note: the try block must wrap the assignment below and must not close
            // early (otherwise the catch is orphaned → the whole inline script fails to parse).
            __html: `(function(){try{var l=localStorage.getItem("pi-locale");if(l!=="en"&&l!=="zh-CN"){var langs=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];for(var i=0;i<langs.length;i++){var n=langs[i].toLowerCase();if(n==="zh"||n.startsWith("zh-")){l="zh-CN";break}if(n==="en"||n.startsWith("en-")){l="en";break}}if(!l)l="en"}window.__PI_LOCALE__=l;document.documentElement.lang=l;document.cookie="pi-locale="+l+";path=/;max-age=31536000;SameSite=Lax"}catch(e){window.__PI_LOCALE__="en"}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            // Globally silence benign "ResizeObserver loop" errors (layout churns
            // repeatedly within one frame, notifications arrive late, and the browser
            // dispatches them as uncaught errors; the page has many ResizeObservers, so
            // this happens occasionally during streaming output / window dragging — not
            // a functional bug).
            // Must be inlined in the head: Next app-globals registers its own window
            // error listener at startup without checking defaultPrevented; only a
            // listener registered earlier that calls stopImmediatePropagation can stop
            // the dev overlay popup.
            __html: `(function(){window.addEventListener("error",function(e){try{var m=e.message||"";if(m.indexOf("ResizeObserver loop")===0){e.stopImmediatePropagation();e.preventDefault()}}catch(err){}})})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
        <ConnGuard />
        <PwaRegistration />
        {/* crash-rescue scenario ③ (compile-time errors): dev overlay Build Error → guide the
            user to /rescue.html (a public/ static page outside the compile graph, still
            reachable when the module graph is broken). Only listens on the dev overlay
            (<nextjs-portal>); prod is naturally inert. On a fresh load the 500 error page
            does not include this layout, so the nginx /dev location sub_filter injects the
            same script as a fallback. */}
        <script src={withBasePath("/rescue-hook.js")} async />
      </body>
    </html>
  );
}
