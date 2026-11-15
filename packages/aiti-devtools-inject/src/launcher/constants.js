import { t } from './i18n.js';
// 纯数据表（自 dbg-launcher.js 闭包提取）
export var DANGER_COMMANDS = {
      'DOM.removeNode': t('Delete page element (irreversible)'),
      'Page.reload': t('Reload target page'),
      'Page.navigate': t('Navigate to another URL'),
      'Storage.localStorageClear': t('Clear localStorage (persistent data)'),
      'Storage.localStorageSet': t('Write localStorage (persistent data)'),
    }

export var GESTURE_COMMANDS = {
      'Browser.copy': t('Copy to clipboard'),
      'Browser.paste': t('Read clipboard (browser may ask permission)'),
      'Browser.pickFile': t('Pick a local file (opens file picker; small files return content / small images as dataUrl)'),
      'Browser.share': t('System share sheet (title/text/link)'),
      'Browser.download': t('Download file'),
      'Browser.openWindow': t('Open new window'),
      'Browser.fullscreen': t('Enter fullscreen'),
      'Browser.play': t('Play media (autoplay policy)'),
      // Page.captureScreenshot 不在 gesture/danger 列表：页面渲染截取无需用户手势、无危险副作用——
      //   直接进 launcher 截屏卡流程（意图说明 → 可先调整页面 → 预览确认才发送）
    }

export var HOST_NAV_KEYS = {
      ArrowUp: 'topN', ArrowDown: 'bottomN', ArrowLeft: 'leftN', ArrowRight: 'rightN',
      PageUp: 'prev', PageDown: 'next', Home: 'first', End: 'last',
      Backspace: 'up', Delete: 'up', Enter: 'downOrNext',
    }

export var AI_WIN_DEFAULTS = { left: null, top: 18, right: 18, width: 400, height: 560, smallHeightPct: 0, popupLayout: 'float' };

// ---- 存储 key ----
export var DBG_STATE_KEY = '__dbg_state__';
export var OPT_KEY = '__dbg_opts__';
export var DEFAULT_RELEASE_KEY = '__dbg_default_release__';
export var PROFILES_KEY = '__dbg_profiles__';
export var AI_WIN_KEY = '__dbg_ai_win__';
export var DBG_SHOW_KEY = '__dbg_show_debug__';
