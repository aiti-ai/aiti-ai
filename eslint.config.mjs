import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      "**/.next/**",
      "**/.next-*/**", // any PI_WEB_DIST_DIR variant (.next-dev/.next-aiti/...)
      "**/node_modules/**",
    ],
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // Fork uses deliberate manual memoization (stable callbacks reading
      // refs, scalar-length deps). eslint-plugin-react-hooks ≥7.1 flags these
      // as "Compilation Skipped" — an optimizer hint, not a bug. Keep them
      // hand-written and silence the noise, same as the other compiler rules.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default eslintConfig;
