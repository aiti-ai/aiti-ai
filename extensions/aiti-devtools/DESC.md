## 把 AI 请到页面开发现场

AI 不该对着屏幕瞎猜——它该真正看见页面。注入后 AI 与你在**同一个页面**上协作：
点选元素（`[元素N]` 直达 AI 输入框）、读 console / 网络、执行类 CDP 命令、事件冻结与放行。

📖 **5 分钟上手**：[aiti.pw/devtools/quick-start.html](https://aiti.pw/devtools/quick-start.html)

调试自己的前端项目只需两步（Vite 示例，dev server 启动即注入）：

```
pnpm add -D @aiti-ai/aiti-devtools-vite
```

```ts
// vite.config.ts
import { aitiDevtools } from '@aiti-ai/aiti-devtools-vite';
export default defineConfig({
  plugins: [aitiDevtools({ bridgeUrl: 'http://localhost:8777' })],
});
```

其他载体（webpack / Rspack / Nuxt / Astro / 浏览器扩展 / IDE 插件）与完整教程见
[aiti.pw/devtools/quick-start.html](https://aiti.pw/devtools/quick-start.html) ——让 AI 常驻你的网页。
