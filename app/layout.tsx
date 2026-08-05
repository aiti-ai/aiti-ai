import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import { withBasePath } from "@/lib/base-path";
import "katex/dist/katex.min.css";
import "./globals.css";

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
            __html: `(function(){try{var t=localStorage.getItem("pi-theme");if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate">
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
