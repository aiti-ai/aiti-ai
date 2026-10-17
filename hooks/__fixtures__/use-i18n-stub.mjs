// i18n stub for hook tests: useAgentSession (aiti fork) reads useI18n() for its
// message table; tests only care about control flow, so t() echoes the key.
export function useI18n() {
  return { t: (key, params) => key, locale: "en", setLocale() {}, supportedLocales: ["en"] };
}
export default useI18n;
