# 商店素材（store-assets）——三市场提交用图

> 生成方式：宣传图/图标 = 品牌模板（蓝紫渐变 #4facfe→#7c3aed + 白 a 黄火花 logo 标）经 sharp(librsvg) 渲染；截图 = 真实扩展 UI（demo 数据填充）经品牌背景合成 1280×800。
> 改文案/配色：直接改本目录对应 SVG/页面后重新渲染（脚本内联在生成命令历史里；模板常量见 PUBLISHING 流程）。

## 文件 → 商店槽位对照

| 文件 | 尺寸 | 去处 |
|---|---|---|
| `cws/promo-440x280.png` | 440×280 | CWS「Small promo tile」（必需） |
| `cws/promo-marquee-1400x560.png` | 1400×560 | CWS「Marquee promo」（可选，建议传） |
| `cws/screenshot-popup-1280x800.png` | 1280×800 | CWS / AMO 截图 ①：popup 按需启用 + AI 目标（合成营销图） |
| `cws/screenshot-options-1280x800.png` | 1280×800 | CWS / AMO 截图 ②：设置页（AI 目标探测 + 站点规则） |
| `edge/logo-300x300.png` | 300×300 | Edge Add-ons「Store logo」（必需） |
| `amo/icon-64x64.png` | 64×64 | AMO「Add-on icon」（建议） |
| `../icons/icon16/32/48/128.png` | — | manifest icons（构建自动拷贝，已在包内） |

## 三市场提交对照

- **CWS**：上传 `dist/aiti-devtools-chrome.zip` + 上表 cws/ 全部 + 隐私政策 `https://aiti.pw/privacy.html`
- **Edge Add-ons**：上传 `dist/aiti-devtools-chrome.zip`（同一份）+ `edge/logo-300x300.png` + 截图（1280×800 满足 ≥725×524）+ 隐私政策
- **AMO**：上传 `dist/aiti-devtools-firefox.xpi`（或走 unlisted 签名）+ `amo/icon-64x64.png` + 截图（1280×800 即可）

## 截图重制

demo 数据页在提交会话的 /tmp（会话清理后需重做）：复制 `dist/chrome/{popup,options}` 到临时目录 →
把状态/地址等字段替换为演示值 → 本地 serve → 浏览器 1280×800 截图 → sharp 合成到品牌背景。
