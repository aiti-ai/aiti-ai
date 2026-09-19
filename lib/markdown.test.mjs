import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeDisplayMath, escapeRawHtmlTags, markdownUrlTransform, markdownDataImageUrlTransform } from "./markdown.ts";

describe("markdownDataImageUrlTransform / markdownUrlTransform", () => {
  const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  it("allows data:image through for <img src> (markdown images -> the file-editor viewer)", () => {
    assert.equal(markdownDataImageUrlTransform(gif, "src", { tagName: "img" }), gif);
    assert.equal(markdownUrlTransform(gif, "src", { tagName: "img" }), gif);
  });

  it("non-img contexts (<a href> etc.) do not allow data: (prevents same-origin navigation via data:text/html)", () => {
    const evil = "data:text/html;base64,PGI+aGk8L2I+";
    assert.equal(markdownDataImageUrlTransform(evil, "href", { tagName: "a" }), "");
    assert.equal(markdownUrlTransform(evil, "href", { tagName: "a" }), "");
    // img src only accepts data:image/ as well
    assert.equal(markdownDataImageUrlTransform(evil, "src", { tagName: "img" }), "");
  });

  it("file: is only allowed by markdownUrlTransform (which has an in-app file handler)", () => {
    const fileUrl = "file:///home/me/project/report.html";
    assert.equal(markdownUrlTransform(fileUrl, "href", { tagName: "a" }), fileUrl);
    assert.equal(markdownDataImageUrlTransform(fileUrl, "href", { tagName: "a" }), "");
  });

  it("plain http(s) URLs go through default sanitization (kept as-is)", () => {
    assert.equal(markdownDataImageUrlTransform("https://x/y.png", "src", { tagName: "img" }), "https://x/y.png");
  });
});

describe("escapeRawHtmlTags", () => {
  it("escapes an HTML tag at line start (inline-raw-HTML trap)", () => {
    assert.equal(
      escapeRawHtmlTags("<button> 📌 收藏\n· 尺寸: 55×22px"),
      "&lt;button> 📌 收藏\n· 尺寸: 55×22px",
    );
  });

  it("escapes tags embedded mid-text (second pick payload)", () => {
    assert.equal(
      escapeRawHtmlTags("如果没有去 <button> 📌\n· 尺寸: 26×26px"),
      "如果没有去 &lt;button> 📌\n· 尺寸: 26×26px",
    );
  });

  it("escapes closing tags and attributes", () => {
    assert.equal(
      escapeRawHtmlTags("a <div class=\"x\">b</div> c"),
      "a &lt;div class=\"x\">b&lt;/div> c",
    );
  });

  it("keeps fenced code blocks verbatim", () => {
    const input = "前\n```html\n<div>code</div>\n```\n后";
    assert.equal(escapeRawHtmlTags(input), input);
  });

  it("keeps tilde-fenced blocks verbatim", () => {
    const input = "前\n~~~\n<div>code</div>\n~~~\n后";
    assert.equal(escapeRawHtmlTags(input), input);
  });

  it("preserves CRLF line endings", () => {
    assert.equal(escapeRawHtmlTags("<div> 一\r\n二\r\n三"), "&lt;div> 一\r\n二\r\n三");
  });

  it("keeps inline code spans verbatim", () => {
    assert.equal(escapeRawHtmlTags("用 `<div>` 和 `a < b` 测试"), "用 `<div>` 和 `a < b` 测试");
  });

  it("keeps GFM autolinks and comparisons intact", () => {
    assert.equal(
      escapeRawHtmlTags("看 <https://example.com> 和 <mailto:a@b.c>，a < b，<3"),
      "看 <https://example.com> 和 <mailto:a@b.c>，a < b，<3",
    );
  });

  it("is idempotent for already-escaped entities", () => {
    assert.equal(escapeRawHtmlTags("&lt;div&gt;"), "&lt;div&gt;");
  });
});

describe("normalizeDisplayMath", () => {
  describe("single-line $$…$$", () => {
    it("splits a single-line block into three lines", () => {
      assert.equal(normalizeDisplayMath("$$a + b$$"), "$$\na + b\n$$");
    });

    it("preserves the indent of the surrounding list item", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  $$a + b$$\n- next"),
        "- item:\n  $$\n  a + b\n  $$\n- next",
      );
    });
  });

  describe("multi-line blocks with glued delimiters", () => {
    it("moves a glued opening delimiter to its own line", () => {
      const input = "$$\n\\frac{a}{b} = c\n<d$$\n\nafter";
      assert.equal(normalizeDisplayMath(input), "$$\n\\frac{a}{b} = c\n<d\n$$\n\nafter");
    });

    it("moves a glued closing delimiter to its own line", () => {
      const input = "$$\nx = y\nz = w$$\n\nafter";
      assert.equal(normalizeDisplayMath(input), "$$\nx = y\nz = w\n$$\n\nafter");
    });
  });

  describe("blocks nested in GFM list items", () => {
    it("re-indents lazy content lines of an indented bare-fence block", () => {
      const input = "- item:\n  $$\nx = y\n  $$\n- next";
      assert.equal(normalizeDisplayMath(input), "- item:\n  $$\n  x = y\n  $$\n- next");
    });

    it("re-indents partially indented content lines", () => {
      const input = "- item:\n  $$\n x = y\n  $$\n- next";
      assert.equal(normalizeDisplayMath(input), "- item:\n  $$\n  x = y\n  $$\n- next");
    });

    it("does not use a sibling list item's formula as a closing fence", () => {
      const input = "- first\n  $$x = y\n- second\n  $$z = w$$\n- third";
      assert.equal(
        normalizeDisplayMath(input),
        "- first\n  $$x = y\n- second\n  $$\n  z = w\n  $$\n- third",
      );
    });

    it("does not scan a bare fence past a sibling list item", () => {
      const input = "- first\n  $$\nx = y\n- second\n  $$z = w$$\n- third";
      assert.equal(
        normalizeDisplayMath(input),
        "- first\n  $$\nx = y\n- second\n  $$\n  z = w\n  $$\n- third",
      );
    });
  });

  describe("blocks that must stay untouched", () => {
    it("leaves a top-level block with detached delimiters untouched", () => {
      const input = "$$\n\\frac{a}{b}\n$$\n\nend";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("leaves content inside fenced code blocks untouched", () => {
      const input = "```\n$$ not math $$\n$$\n```\n\nreal $$x = 1$$ end";
      const normalized = normalizeDisplayMath(input);
      assert.ok(normalized.includes("```\n$$ not math $$\n$$\n```"));
      // every `$$` is preserved: 3 inside the fence + 2 in inline math
      assert.equal(normalized.match(/\$\$/g)?.length, 5);
    });

    it("leaves inline math and plain prose untouched", () => {
      const input = "text $x = 1$ and $$a + b$$ more";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("does not treat a glued opener with mid-line $$ as a block", () => {
      const input = "$$x$$ and text";
      assert.equal(normalizeDisplayMath(input), input);
    });
  });

  describe("\\[ … \\] blocks", () => {
    it("normalizes single-line brackets", () => {
      assert.equal(normalizeDisplayMath("\\[a + b\\]"), "$$\na + b\n$$");
    });

    it("keeps content indented when nested in a list item", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  \\[a + b\\]\n- next"),
        "- item:\n  $$\n  a + b\n  $$\n- next",
      );
    });

    it("normalizes multi-line brackets without double-indenting", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  \\[\n  x = y\n  \\]\n- next"),
        "- item:\n  $$\n  x = y\n  $$\n- next",
      );
    });
  });

  describe("loose [ … ] formula blocks", () => {
    it("normalizes model-emitted bracket-only formula lines", () => {
      assert.equal(
        normalizeDisplayMath("[ C(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S(\\hat{y}^{(i)}, \\hat{y}^{(j)}) ]"),
        "$$\nC(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S(\\hat{y}^{(i)}, \\hat{y}^{(j)})\n$$",
      );
    });

    it("leaves ambiguous bracket-only Markdown untouched", () => {
      for (const input of [
        "[普通说明文字]",
        "[See note (important)]",
        "[status=ready]",
        "[yes/no]",
        "[API_v2]\n\n[API_v2]: https://example.com/docs",
        "[C:\\Users\\alex]",
        "[\\\\server\\share]",
        "[https://example.com/\\alpha]",
      ]) {
        assert.equal(normalizeDisplayMath(input), input);
      }
    });
  });
});
