Main-thread smoothness detector: a small panel in the corner of the page — a rAF seconds counter + a 0-100 smoothness score (Apdex-anchored, color tiers). **When the main thread stalls, the counter freezes and the score drops off a cliff**; minimize it to a corner icon for long sessions and open it later to see the session average.

---

## Four ways to use it

### 1. Pages of this instance (pi-web)

Off by default in the aiti-ai build (turn on "Enable detector" under Feature Management in the extension manager). The panel can be dragged and minimized; position / scoring / minimize toggles are listed under Feature Management below.

### 2. Inject into any website: script tag

The external build is a single-file IIFE — any page can load it with a `<script>` tag (cross-origin allowed, publicApi declared):

```html
<script src="{{aiti-url}}/api/extensions/{{ext-id}}/aiti-cpu-meter.js" defer></script>
```

> `{{aiti-url}}` is replaced with **this pi-web instance's external address** (including the `/dev` prefix) — paste it into the target site and it works.

### 3. Inject into any website: bookmarklet (no site changes)

Create a browser bookmark, paste the line below as its URL (click "Copy"), then click the bookmark on any page to attach the detector:

```js
javascript:(function(){var s=document.createElement('script');s.src='{{aiti-url}}/api/extensions/{{ext-id}}/aiti-cpu-meter.js';s.defer=1;document.body.appendChild(s)})();void 0
```

### 4. Site-wide automatic injection: service-tunnels

After installing [service-tunnels](http://aiti.pw/extensions/service-tunnels.html), tick "CPU smoothness detector" in its public config — proxied/public page HTML gets injected automatically, no per-page script needed.

---

## Jank analysis (🤖 ask AI)

The 🤖 "Ask AI" button in the panel header hands the live data (smoothness score / long tasks / LoAF script attribution / jank snapshot) to `aiti-helper`, which starts a "debug page jank" AI session to find the root cause and propose a fix.

## How the numbers work

- The counter = real time since the previous frame; a main thread hogged by a long task freezes the counter
- The 0-100 smoothness score is Apdex-anchored on the long-task ratio, with color tiers (green ≥ 90 / yellow ≥ 70 / red < 70)
- Session stats: average score / running time / lowest score, accumulating even while minimized
