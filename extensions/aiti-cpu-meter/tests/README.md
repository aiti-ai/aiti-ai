# aiti-cpu-meter · 测试页

`index.html` —— 模拟网站，用于手动验证检测器注入效果。

## 用法

```bash
# 本机起服务（任意静态服务器均可）
python3 -m http.server 8899 --bind 127.0.0.1 --directory tests/
# 浏览器打开 http://127.0.0.1:8899/index.html
# 调试监听模式（页面连 aiti-devtools 桥，agent 可监听/操作）：http://127.0.0.1:8899/index.html?aiti=1
```

页面自带：
- 持续旋转动画（rAF，空闲应绿 ~100 分）
- **卡顿模拟按钮**：❄ 冻结 2s（整页卡死 → 红）/ ⚡ 抖动 5s（断续 120ms → 黄）/ 🔥 持续高负载（长任务连发 → 橙红）/ ✋ 停止
- **注入方法**：页面上的 bookmarklet 一行（指向 pi-web 的外部版资产），贴控制台回车即注入；再执行一次卸载

## 验证要点

1. 空闲 ≥90 绿；冻结 2s → 跌破 50 红，~30s 回弹
2. 最小化 ⇄ 展开；FAB 拖动 + 位置记忆
3. 会话统计三行：运行时长 / 最低·最高·平均 / 总·1分·5分·10分 窗口平均
4. **✨ 问 AI**（v0.3）：面板标题栏 sparkles 按钮 → prompt 弹窗（附当前分/平均/最低/longtask）→
   提交后新标签页跳转到 pi-web 新建的「调试页面卡顿」会话（`/?session=<id>`）。
   控制台可验 `window.__aitiCpuMeter.report()`（含 LoAF 归因，Chrome 123+）。
   关闭按钮：URL 加 `meter-ask=0`
