## Bring AI into the page you are developing

AI should not guess at a screen from the outside — it should actually see the page. Once injected, AI works with you **on the same page**:
select elements (`[element N]` lands straight in the AI input), read console / network, run CDP-like commands, freeze and release events.

📖 **5-minute quick start**: [aiti.pw/devtools/quick-start.html](https://aiti.pw/devtools/quick-start.html)

Debugging your own frontend project takes two steps (Vite example — injection starts with the dev server):

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

Other carriers (webpack / Rspack / Nuxt / Astro / browser extension / IDE plugin) and the full walkthrough live at
[aiti.pw/devtools/quick-start.html](https://aiti.pw/devtools/quick-start.html) — keep AI on your pages permanently.
