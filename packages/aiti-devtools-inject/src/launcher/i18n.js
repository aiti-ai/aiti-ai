// i18n: English-source translator (vscode-ext l10n pattern, commit 7f54e59c)
//   - Source code writes English strings; English text itself is the key
//   - zh language + bundle hit -> Chinese translation; otherwise English fallback
//   - Placeholders: t('Copied: {0}', x) -> positional {0} {1} substitution
//   - Language: navigator.language zh* -> 'zh' (zero regression for existing users);
//     options panel may override via setLang (persisted in localStorage __dbg_lang)
import ZH_CN from './locales/zh-cn.js';

var langCache = null; // detected/override result; null = detect on next getLang()

function detectLang() {
  try {
    var saved = localStorage.getItem('__dbg_lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (e) {}
  try {
    var nav = String((typeof navigator !== 'undefined' && (navigator.language || navigator.userLanguage)) || 'en');
    return /^zh/i.test(nav) ? 'zh' : 'en';
  } catch (e) { return 'en'; }
}

// Current UI language ('zh' | 'en'); cached after first detection
export function getLang() {
  if (langCache !== 'zh' && langCache !== 'en') langCache = detectLang();
  return langCache;
}

// Manual override ('zh' | 'en' | null=auto/follow browser); persisted
export function setLang(l) {
  langCache = (l === 'zh' || l === 'en') ? l : null;
  try {
    if (l === 'zh' || l === 'en') localStorage.setItem('__dbg_lang', l);
    else localStorage.removeItem('__dbg_lang');
  } catch (e) {}
}

// Raw stored preference (null = auto/follow browser); options panel uses it to render the select
export function getLangPref() {
  try { return localStorage.getItem('__dbg_lang'); } catch (e) { return null; }
}

// Translate: zh + bundle hit -> translation; else English source. {0}..{n} positional args.
export function t(key) {
  var s = key;
  if (getLang() === 'zh') {
    var hit = ZH_CN[key];
    if (typeof hit === 'string') s = hit;
  }
  for (var i = 1; i < arguments.length; i++) {
    s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
  }
  return s;
}
