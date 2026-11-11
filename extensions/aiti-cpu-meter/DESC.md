主线程流畅度检测器：页面角落挂一块小面板——rAF 读秒 + 0-100 流畅度分（Apdex 锚定 + 颜色分层）。**主线程一卡，读秒就停、分数暴跌**；可最小化成长期挂角的小图标，收工点开看会话平均。

---

## 四种用法

### 1. 本实例页面（pi-web）

aiti-ai 版默认关闭（extman「功能管理」打开「启用检测器」）。面板可拖动、可最小化；位置/评分/最小化等开关见本页下方「功能管理」。

### 2. 注入任意网站：script 标签

外部版是单文件 IIFE，任何页面 `<script>` 加载即用（脚本跨站放行，已声明 publicApi）：

```html
<script src="{{aiti-url}}/api/extensions/{{ext-id}}/aiti-cpu-meter.js" defer></script>
```

> 上面的 `{{aiti-url}}` 会自动替换成**当前 pi-web 实例的外部地址**（含 `/dev` 前缀），粘贴到目标站即可用。

### 3. 注入任意网站：bookmarklet（免改目标站）

新建一个浏览器书签，URL 粘贴下面这行（点「复制」），之后在任意网页上点这个书签，检测器就挂上了：

```js
javascript:(function(){var s=document.createElement('script');s.src='{{aiti-url}}/api/extensions/{{ext-id}}/aiti-cpu-meter.js';s.defer=1;document.body.appendChild(s)})();void 0
```

### 4. 全站自动注入：service-tunnels

安装 [service-tunnels](http://aiti.pw/extensions/service-tunnels.html) 后，在它的公开配置里勾选「CPU 流畅度检测器」——代理/公开页面 HTML 自动注入，无需逐页加 script。

---

## 卡顿分析（🤖 问 AI）

面板标题栏 🤖「问 AI」：一键把现场数据（流畅度分/长任务/LoAF 脚本归因/卡顿快照）交给 `aiti-helper` 建「调试页面卡顿」AI 会话，定位卡顿根因并给修复建议。

## 数据口径

- 读秒 = 距上帧真实耗时；主线程被长任务占死时读秒冻结
- 流畅度分 0-100 由长任务占比 Apdex 锚定，颜色分层（绿 ≥ 90 / 黄 ≥ 70 / 红 < 70）
- 会话统计：平均分 / 运行时长 / 最低分，最小化态也持续累积
