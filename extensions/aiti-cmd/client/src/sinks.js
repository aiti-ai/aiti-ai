/**
 * aiti-cmd client · share-sink provider (「命令收藏」as a fixed share target)
 *
 * Contract owned by aiti-msg-share: topic `share-sink` items are LOCAL sinks rendered in
 * the share dialog's favourites section (no upload, no URL, no redaction). They are a
 * different registry from content-share target providers on purpose.
 *
 * Shape:
 *   { id, order?, label, icon?, accepts?(payload), save(payload) }
 *   save → { ok, message?, action?: { label, run } }
 *   payload = { kind, text, title, tags, ...original payload }
 *   (text = unredacted body, page-info stamp already stripped by the consumer)
 */
export function registerShareSink(ctx, kit, store) {
  const { t, api } = kit;
  const sink = {
    id: "aiti-cmd.command",
    order: 10,
    get label() { return t("cmd.app.sink.label"); },
    icon: { svg: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
    // A command is short text: reject whole sessions/images/files and anything long. Multi-line
    // selections stay allowed (a && b chains, heredoc-ish one-liners).
    accepts: (payload) => {
      const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return false;
      if (payload.kind === "image" || payload.kind === "file") return false;
      // length is the real filter — the user may edit the body down to a command before saving
      return text.length <= 500;
    },
    async save(payload) {
      // messages often quote commands as "$ npm run dev" — drop the prompt symbol, it is not
      // part of the command (a leading "$ " only; shell variables are unaffected)
      const text = String(payload?.text || "").split("\n").map((line) => line.replace(/^\s*\$\s+/, "")).join("\n").trim();
      if (!text) return { ok: false, message: t("cmd.k171") };
      const firstLine = text.split("\n").map((s) => s.trim()).find(Boolean) || text;
      const name = firstLine.slice(0, 60);
      try {
        const r = await fetch(api("/commands"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, cmd: text, cwd: payload.cwd || undefined, tags: payload.tags ? String(payload.tags).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [], source: "message" }),
        }).then((x) => x.json());
        if (!r || !r.ok) return { ok: false, message: (r && r.error) || t("cmd.k92") };
        const id = r.command && r.command.id;
        return {
          ok: true,
          message: t("cmd.app.sink.saved") + name,
          action: { label: t("cmd.app.openFavorites"), run: () => store.openApp("favorites", id ? { focus: id } : {}) },
        };
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) };
      }
    },
  };
  try { return ctx.registerTopicItem?.("share-sink", sink) || null; } catch { return null; }
}
