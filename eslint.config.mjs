import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  // demo/ is a separate Next.js project with its own lint config.
  // extensions/ hosts the ported pi-web extension packages (mirror of the
// private source repo). They are independent projects with their own build/lint lifecycle —
// same policy as demo/. See AGENTS.md "extensions/".
  // pi-plugins/ + packages/ are independently published npm packages (@aiti-ai/*, gated by
  // publish-npm's release-audit); integrations/ are separate ext mirrors (dsh/opencode);
  // bin/ + tools/ are plain node launchers/tooling (CommonJS by design). All carry their own
  // toolchains — excluded from the Next app's lint scope, same policy as extensions//demo.
  { ignores: ["demo/**", "extensions/**", "pi-plugins/**", "packages/**", "integrations/**", "bin/**", "tools/**", "vendor/**"] },
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      "**/.next/**",
      "**/.next-*/**", // any PI_WEB_DIST_DIR variant (.next-dev/.next-aiti/...)
      "**/node_modules/**",
      ".docker-build-context/**", // local docker staging mirror (build.sh assembly; never in git/CI)
    ],
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // Fork uses deliberate manual memoization (stable callbacks reading
      // refs, scalar-length deps). eslint-plugin-react-hooks ≥7.1 flags these
      // as "Compilation Skipped" — an optimizer hint, not a bug. Keep them
      // hand-written and silence the noise, same as the other compiler rules.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
  {
    // ExtSlots hosts the extension-runtime react shim: deliberately loose hook signatures
    // mirroring React's own internal types (generic plumbing across the host↔extension
    // boundary). Precise generics here only produce `as unknown as X` noise, not safety.
    files: ["components/ExtSlots.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-empty-object-type": "off" },
  },
];

export default eslintConfig;
