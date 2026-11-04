// 纯数据表（自 dbg-launcher.js 闭包提取）
export var DANGER_COMMANDS = {
      'DOM.removeNode': '删除页面元素（不可恢复）',
      'Page.reload': '重载目标页面',
      'Page.navigate': '导航到其他地址',
      'Storage.localStorageClear': '清空 localStorage（持久数据）',
      'Storage.localStorageSet': '写入 localStorage（持久数据）',
    }

export var GESTURE_COMMANDS = {
      'Browser.copy': '复制到剪贴板',
      'Browser.paste': '读取剪贴板内容（浏览器可能弹授权）',
      'Browser.pickFile': '选择本地文件（弹文件选择器；小文件直接返回内容/小图片转 dataUrl）',
      'Browser.share': '系统分享面板（标题/文本/链接）',
      'Browser.download': '下载文件',
      'Browser.openWindow': '打开新窗口',
      'Browser.fullscreen': '进入全屏',
      'Browser.play': '播放音视频（自动播放策略）',
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
