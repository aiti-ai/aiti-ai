import assert from "node:assert/strict";
import test from "node:test";
import { parseParagraph, detectOptions, splitQuestions, formatQuote, extractFilePaths, summarizeSegment, encodeFilePathForApi, extractUrls, mergeExternalRoots, candidatesFromRoots, selfNameCandidates } from "../client/src/recognize.js";

test("question: closed yes/no with action → 好，X / 不用", () => {
  const segs = parseParagraph("要我帮你修改这个文件吗？");
  assert.equal(segs.length, 1);
  const opts = segs[0].options;
  assert.ok(opts && opts.length === 2);
  assert.equal(opts[0].label, "好，帮你修改这个文件");
  assert.equal(opts[0].value, "是的");
  assert.equal(opts[1].value, "不用了");
});

test("question: A 还是 B explicit choice", () => {
  const segs = parseParagraph("用 A 方案还是 B 方案？");
  assert.equal(segs.length, 1);
  const opts = segs[0].options;
  assert.ok(opts && opts.length === 2);
  assert.deepEqual(opts.map((o) => o.value), ["A 方案", "B 方案"]);
});

test("question: open-ended question → no options (fallback plain quote)", () => {
  const segs = parseParagraph("这个接口怎么实现？");
  assert.ok(segs.length >= 1);
  assert.equal(segs[0].options, null);
});

test("question: long action (>16 chars) still gets 好，X summary", () => {
  // 长度限制移除：action 超长时 label 截断显示摘要，不再降级纯 是/否
  const segs = parseParagraph("是否保持与原版一致（p/li/tr）？");
  const opts = segs[0].options;
  assert.ok(opts && opts.length === 2);
  assert.ok(opts[0].label.startsWith("好，"), `expected 好，X, got ${opts[0].label}`);
  assert.equal(opts[1].label, "不用");
});

test("question: English yes/no → action-aware Yes/No buttons", () => {
  const opts = parseParagraph("Should I proceed?").flatMap((s) => s.options ?? []);
  assert.deepEqual(opts.map((o) => o.label), ["Yes, proceed", "No"]);
  assert.deepEqual(opts.map((o) => o.value), ["Yes", "No"]);
});

test("question: English yes/no without trailing '?' (streaming tail) still recognized", () => {
  const opts = parseParagraph("Do you want me to add tests").flatMap((s) => s.options ?? []);
  assert.deepEqual(opts.map((o) => o.label), ["Yes, add tests", "No"]);
});

test("question: English offer 'let me know if you want me to X' → Yes/No with action", () => {
  const opts = parseParagraph("Done. Let me know if you'd like me to continue.").flatMap((s) => s.options ?? []);
  assert.deepEqual(opts.map((o) => o.label), ["Yes, continue", "No"]);
});

test("question: English generic inversion keeps plain Yes/No (no action label)", () => {
  const opts = parseParagraph("Is it done?").flatMap((s) => s.options ?? []);
  assert.deepEqual(opts.map((o) => o.label), ["Yes", "No"]);
});

test("question: English 'X or Y' choice strips lead-in frames", () => {
  const cases = [
    ["Would you prefer tabs or spaces?", ["tabs", "spaces"]],
    ["Do you want to use A or B?", ["A", "B"]],
    ["Can I use A or B?", ["A", "B"]],
    ["Use shell or python?", ["shell", "python"]],
  ];
  for (const [text, want] of cases) {
    const opts = parseParagraph(text).flatMap((s) => s.options ?? []);
    assert.deepEqual(opts.map((o) => o.value), want, text);
  }
});

test("question: English open-ended / request questions → no options", () => {
  for (const text of [
    "When should we ship?",
    "Whose branch should we merge?",
    "Which one do you prefer?",
    "Can you explain the architecture?",
    "Can you help me fix this?",
  ]) {
    assert.equal(parseParagraph(text)[0].options, null, text);
  }
});

test("question: English ';' stays inside the sentence → choice keeps both halves", () => {
  // ASCII ';' splits CJK sentences only; splitting here used to strand "or wait?"
  const segs = parseParagraph("Shall I update the docs; or wait?");
  assert.equal(segs.length, 1, JSON.stringify(segs.map((s) => s.text)));
  assert.deepEqual(segs[0].options?.map((o) => o.value), ["update the docs", "wait"]);
});

test("splitQuestions: Chinese ';' still splits sentences", () => {
  const segs = parseParagraph("先改 A 吗；还是先改 B？");
  assert.ok(segs.length >= 2, JSON.stringify(segs.map((s) => s.text)));
});

test("splitQuestions: 。 and ！ end sentences → per-sentence rows + clean action labels", () => {
  const segs = parseParagraph("已经改好了。要我加测试吗？");
  assert.deepEqual(segs.map((s) => s.text), ["已经改好了。", "要我加测试吗？"]);
  assert.deepEqual(segs[1].options?.map((o) => o.label), ["好，加测试", "不用"]);

  const bang = parseParagraph("改完了！要发布吗？");
  assert.deepEqual(bang.map((s) => s.text), ["改完了！", "要发布吗？"]);
  assert.deepEqual(bang[1].options?.map((o) => o.label), ["好，要发布", "不用"]);
});

test("splitQuestions: brackets/quotes protect their content (；？ stay inside the pair)", () => {
  assert.deepEqual(splitQuestions("选A（说明1；继续），B（说明2；继续）"), ["选A（说明1；继续），B（说明2；继续）"]);
  assert.deepEqual(splitQuestions("选 A（不确定？）还是 B？"), ["选 A（不确定？）还是 B？"]);
  assert.deepEqual(splitQuestions("他说「真的吗？」，然后走了。"), ["他说「真的吗？」，然后走了。"]);
});

test("splitQuestions: URL query and code '?' stay intact", () => {
  assert.deepEqual(splitQuestions("看 https://x.io/a?b=1 这个链接吗？"), ["看 https://x.io/a?b=1 这个链接吗？"]);
  assert.deepEqual(splitQuestions("访问 /dev/?tab=1 页面。要我刷新吗？"), ["访问 /dev/?tab=1 页面。", "要我刷新吗？"]);
  assert.deepEqual(splitQuestions("调用 foo(a?b:c) 还是 bar()？"), ["调用 foo(a?b:c) 还是 bar()？"]);
});

test("question: 'or/还是' inside brackets is not the option separator", () => {
  const cn = parseParagraph("用 A（支持 Python or Go）还是 B（支持 JS）？")[0].options;
  assert.deepEqual(cn.map((o) => o.value), ["A（支持 Python or Go）", "B（支持 JS）"]);
  const en = parseParagraph("Use A (supports Python or Go) or B (supports JS)?")[0].options;
  assert.deepEqual(en.map((o) => o.value), ["A (supports Python or Go)", "B (supports JS)"]);
  const q = parseParagraph("选 A（不确定？）还是 B？")[0].options;
  assert.deepEqual(q.map((o) => o.value), ["A（不确定？）", "B"]);
});

test("question: enumerated options with parenthetical notes (选 A（…），B（…）)", () => {
  const opts = parseParagraph("选A（说明1，继续），B（说明2，继续）")[0].options;
  assert.deepEqual(opts.map((o) => o.value), ["A（说明1，继续）", "B（说明2，继续）"]);
  // no lead-in / no bracketed items → not an option list
  assert.equal(detectOptions("看 A 图，B 图"), null);
});

test("label truncation keeps brackets balanced (no dangling opener)", () => {
  const opts = parseParagraph("选 A（这是一个很长的说明文字用来触发截断继续继续继续）还是 B？")[0].options;
  assert.equal(opts[0].label, "A（这是一个很长的说明文…）");
});

test("question: English multi-sentence → action frame found in the last sentence", () => {
  assert.deepEqual(parseParagraph("Tests pass. Should I proceed?")[0].options.map((o) => o.label), ["Yes, proceed", "No"]);
  assert.deepEqual(
    parseParagraph("The build is green. Would you like me to deploy it?")[0].options.map((o) => o.label),
    ["Yes, deploy it", "No"],
  );
});

test("question: Chinese '要 A 还是 B' strips the bare lead-in", () => {
  const opts = parseParagraph("已完成。要 A 还是 B？")[1].options;
  assert.deepEqual(opts.map((o) => o.value), ["A", "B"]);
});

test("splitQuestions: statement-only paragraphs stay one row (no row explosion)", () => {
  const t = "已完成。下一步我会运行测试。日志在 /tmp/a.md。";
  assert.deepEqual(splitQuestions(t), [t]);
});

test("splitQuestions: question before/after 。 splits, and the question row keeps options", () => {
  // question first (the 。 tail must not be glued into the action label)
  const prev = parseParagraph("要我改吗。然后我会跑测试。");
  assert.deepEqual(prev.map((s) => s.text), ["要我改吗。", "然后我会跑测试。"]);
  assert.deepEqual(prev[0].options?.map((o) => o.label), ["好，改", "不用"]);

  // question in the middle → three rows, only the middle one has options
  const mid = parseParagraph("部署完成。要发布吗？我会等确认。");
  assert.deepEqual(mid.map((s) => s.text), ["部署完成。", "要发布吗？", "我会等确认。"]);
  assert.deepEqual(mid[1].options?.map((o) => o.label), ["好，要发布", "不用"]);
  assert.equal(mid[0].options, null);
  assert.equal(mid[2].options, null);
});

test("nested brackets: inner 'or' is ignored, label truncation stays balanced", () => {
  const opts = parseParagraph("用 A（支持 X（旧版）or Y）还是 B？")[0].options;
  assert.deepEqual(opts.map((o) => o.value), ["A（支持 X（旧版）or Y）", "B"]);
  assert.equal(opts[0].label, "A（支持 X（旧版）or…）");
});

test("brackets: unbalanced opener (streaming) does not block sentence splitting", () => {
  const segs = splitQuestions("他说“好的。要我改吗？");
  assert.deepEqual(segs, ["他说“好的。", "要我改吗？"]);
  // balanced leading note must not swallow the boundary behind it
  assert.deepEqual(splitQuestions("（提示）要我改吗？"), ["（提示）要我改吗？"]);
  assert.deepEqual(parseParagraph("（提示）要我改吗？")[0].options?.map((o) => o.value), ["是的", "不用了"]);
});

test("question: 【】 notes work for splitting and enumeration", () => {
  assert.deepEqual(splitQuestions("选A【说明1；继续】，B【说明2；继续】"), ["选A【说明1；继续】，B【说明2；继续】"]);
  const opts = parseParagraph("选A【说明1；继续】，B【说明2；继续】")[0].options;
  assert.deepEqual(opts.map((o) => o.value), ["A【说明1；继续】", "B【说明2；继续】"]);
});

test("question: enumeration supports 3+ items and ASCII brackets", () => {
  const three = parseParagraph("选 A（快），B（稳），C（省）")[0].options;
  assert.deepEqual(three.map((o) => o.value), ["A（快）", "B（稳）", "C（省）"]);
  const en = parseParagraph("Option A (fast), B (slow)?")[0].options;
  assert.deepEqual(en.map((o) => o.value), ["A (fast)", "B (slow)"]);
});

test("truncation: ASCII bracket notes also close when cut", () => {
  const opts = parseParagraph("Use A (a very long explanatory note that keeps going and going) or B (short)?")[0].options;
  assert.equal(opts[0].label, "A (a very lo…)");
});

test("splitQuestions: straight double quotes protect their content", () => {
  assert.deepEqual(splitQuestions('他说 "真的要改吗？" 然后走了。'), ['他说 "真的要改吗？" 然后走了。']);
  // unmatched straight quote (streaming tail) must not block sentence boundaries
  assert.deepEqual(splitQuestions('他说 "好的。要我改吗？'), ['他说 "好的。', '要我改吗？']);
});

test("question: quoted question still gets actions (wrapper quotes stripped)", () => {
  assert.deepEqual(parseParagraph('"Should I proceed?"')[0].options.map((o) => o.label), ["Yes, proceed", "No"]);
  assert.deepEqual(parseParagraph("「要我改吗？」")[0].options.map((o) => o.label), ["好，改", "不用"]);
});

test("splitQuestions: ellipsis / em dash / '...' end a sentence before a question", () => {
  assert.deepEqual(splitQuestions("已经改好了……要我改吗？"), ["已经改好了……", "要我改吗？"]);
  assert.deepEqual(splitQuestions("改完了——要发布吗？"), ["改完了——", "要发布吗？"]);
  assert.deepEqual(splitQuestions("Done... Should I proceed?"), ["Done...", "Should I proceed?"]);
  assert.deepEqual(parseParagraph("已经改好了……要我改吗？")[1].options.map((o) => o.label), ["好，改", "不用"]);
});

test("splitQuestions: mid-sentence ellipsis/dash and version ranges don't split", () => {
  assert.deepEqual(splitQuestions("我改了……但是没测。要测吗？"), ["我改了……但是没测。", "要测吗？"]);
  assert.deepEqual(splitQuestions("版本 v1...3 发布了吗？"), ["版本 v1...3 发布了吗？"]);
  assert.deepEqual(splitQuestions("A——B 要改吗？"), ["A——B 要改吗？"]);
});

test("question: streaming tail — blockquote stays literal", () => {
  // 引号内下划线不得剥（PI_WEB_BASE_DOMAIN 之类）
  const segs = parseParagraph("访问 aan_web.example.com 吗？");
  const opts = segs[0].options;
  assert.ok(opts && opts.length === 2);
});

test("formatQuote: prefixes each line with > and appends answer line", () => {
  const out = formatQuote("第一行\n第二行", "是的");
  assert.equal(out, "> 第一行\n> 第二行\n是的");
});

test("extractFiles: dir/name.ext, bare source file, trailing-slash dir", () => {
  const out = extractFilePaths("看 docs/plan.md 和 src/main.ts，还有 assets/ 目录");
  const paths = out.map((p) => p.path);
  assert.ok(paths.includes("docs/plan.md"));
  assert.ok(paths.includes("src/main.ts"));
  assert.ok(paths.includes("assets"));
  const dir = out.find((p) => p.path === "assets");
  assert.equal(dir.isDir, true);
});

test("extractFiles: ~/ .pi ./ 前缀保留，../ 规范化", () => {
  const out = extractFilePaths("部署到 ~/.pi/web/extensions/ 和 ./client/src/，看 .pi/config 里");
  assert.ok(out.some((p) => p.path === "~/.pi/web/extensions" && p.isDir));
  assert.ok(out.some((p) => p.path === "./client/src" && p.isDir));
  assert.ok(out.some((p) => p.path === ".pi/config"));
});

test("extractFiles: 无尾斜杠目录保留 isDir=false（调用方 meta/list 双试修正）", () => {
  const out = extractFilePaths("cd pi-web-ext/aiti-helper && node tools/deploy.mjs");
  const dir = out.find((p) => p.path === "pi-web-ext/aiti-helper");
  assert.ok(dir, "应提取 pi-web-ext/aiti-helper，实际：" + JSON.stringify(out));
  assert.equal(dir.isDir, false); // 文本无法判断 → 交给校验双试
  assert.ok(out.some((p) => p.path === "tools/deploy.mjs" && !p.isDir));
});

test("extractFiles: dedupe", () => {
  const out = extractFilePaths("a.md 和 a.md 和 b.ts");
  assert.equal(out.length, 2);
});

test("extractFiles: Windows 盘符路径（反斜杠/正斜杠/UNC/尾分隔符目录）识别并归一化为 /", () => {
  // 回归——Windows 反斜杠路径此前完全不识别（只捞到裸文件名 SKILL.md），正斜杠形式丢盘符前缀
  const bs = extractFilePaths("Successfully wrote to D:\\workspace\\demo-repo\\pi-web-ext\\aiti-editor\\skills\\install-soffice\\SKILL.md");
  assert.ok(
    bs.some((p) => p.path === "D:/workspace/demo-repo/pi-web-ext/aiti-editor/skills/install-soffice/SKILL.md" && !p.isDir),
    JSON.stringify(bs),
  );
  const fwd = extractFilePaths("看 D:/workspace/pi-web/docs/plan.md 与 C:\\Users\\user\\.pi\\agent\\settings.json");
  assert.ok(fwd.some((p) => p.path === "D:/workspace/pi-web/docs/plan.md" && !p.isDir), JSON.stringify(fwd));
  assert.ok(fwd.some((p) => p.path === "C:/Users/user/.pi/agent/settings.json" && !p.isDir), JSON.stringify(fwd));
  const dirTrail = extractFilePaths("产物在 D:\\workspace\\pi-web\\.next-prod\\ 下");
  const d = dirTrail.find((p) => p.path === "D:/workspace/pi-web/.next-prod");
  assert.ok(d, JSON.stringify(dirTrail));
  assert.equal(d.isDir, true);
  const unc = extractFilePaths("共享盘 \\\\nas\\public\\docs\\a.md 有份说明");
  assert.ok(unc.some((p) => p.path === "//nas/public/docs/a.md" && !p.isDir), JSON.stringify(unc));
  // 相对反斜杠路径同权（Windows cwd 内相对引用）
  const rel = extractFilePaths("改了 pi-web-ext\\aiti-msg-smart\\client\\src\\recognize.js");
  assert.ok(rel.some((p) => p.path === "pi-web-ext/aiti-msg-smart/client/src/recognize.js" && !p.isDir), JSON.stringify(rel));
});

test("extractFiles: bare image/asset filename (git/截图叙述) recognized", () => {
  // 回归——裸文件名带图片后缀曾漏识别（viewer-new-layout.png 没被认出）
  const msg = "viewer-new-layout.png 是已跟踪文件（在 git ls-files 里）——绝不能删。";
  const paths = extractFilePaths(msg).map((p) => p.path);
  assert.ok(paths.includes("viewer-new-layout.png"), `应命中裸 png，实际：${JSON.stringify(paths)}`);
  assert.ok(extractFilePaths("图标 icon.svg").some((p) => p.path === "icon.svg"));
  assert.ok(extractFilePaths("打包 app.zip").some((p) => p.path === "app.zip"));
});

test("extractFiles: 裸词无后缀与版本串不误判", () => {
  // 无点号后缀的裸词不应命中；v1.2 的 .2 不是白名单后缀
  assert.equal(extractFilePaths("这个 png 文件很重要").length, 0);
  assert.equal(extractFilePaths("这是 version v1.2 的新版").length, 0);
});

test("extractFiles: MSYS 挂载形式（git-bash 输出 /d/...）识别并归一化为盘符", () => {
  // /d/foo、//d/foo → D:/foo；/usr/ 多字母首段不命中锚（不误转，保持旧相对行为）
  const msys = extractFilePaths("git-bash 里跑的 /d/workspace/demo-repo/pi-web-ext/aiti-msg-smart/client/src/recognize.js");
  assert.ok(
    msys.some((p) => p.path === "D:/workspace/demo-repo/pi-web-ext/aiti-msg-smart/client/src/recognize.js" && !p.isDir),
    JSON.stringify(msys),
  );
  const dbl = extractFilePaths("产物在 //d/workspace/pi-web/.next-prod/ 下");
  const d = dbl.find((p) => p.path === "D:/workspace/pi-web/.next-prod");
  assert.ok(d, JSON.stringify(dbl));
  assert.equal(d.isDir, true);
  const mixed = extractFilePaths("cd /d/workspace && 看 /d/workspace/pi-web/docs/plan.md");
  assert.ok(mixed.some((p) => p.path === "D:/workspace"), JSON.stringify(mixed)); // 无尾分隔符 isDir 交 probe 修正
  assert.ok(mixed.some((p) => p.path === "D:/workspace/pi-web/docs/plan.md" && !p.isDir), JSON.stringify(mixed));
  // 多字母 unix 根不转盘符（/usr/ 绝对候选，探测自然过滤）
  const unix = extractFilePaths("二进制在 /usr/local/bin/git.exe");
  assert.ok(!unix.some((p) => /^[A-Za-z]:/.test(p.path)), JSON.stringify(unix));
});

test("extractFiles: Unix 多字母根绝对路径保留前导 /（不再丢首斜杠当相对）", () => {
  // 回归（2026-09-16）——write 工具行 {"file_path": "/home/pi/….html"} 点击不识别：
  // PATH_SEG 此前无 /+多字母段 锚，匹配从 home 开始丢前导 / → 被当相对路径拼 cwd 探测必 404
  const json = extractFilePaths('{"file_path": "/home/pi/workspace/demo-repo/docs/mockups/session-manager-branch-chip-effect.html"}');
  assert.ok(
    json.some((p) => p.path === "/home/pi/workspace/demo-repo/docs/mockups/session-manager-branch-chip-effect.html" && !p.isDir),
    JSON.stringify(json),
  );
  // 与相对/盘符/MSYS 候选共存互不干扰
  const mixed = extractFilePaths("看 /tmp/a.md、docs/x.md、D:\\vms\\安装记录.md");
  assert.ok(mixed.some((p) => p.path === "/tmp/a.md" && !p.isDir), JSON.stringify(mixed));
  assert.ok(mixed.some((p) => p.path === "docs/x.md" && !p.isDir), JSON.stringify(mixed));
  assert.ok(mixed.some((p) => p.path === "D:/vms/安装记录.md" && !p.isDir), JSON.stringify(mixed));
});

test("extractFiles: Windows 中文文件名路径完整识别（CJK 段/末段不截断）", () => {
  // 回归——中文文件名此前被 \w（ASCII）字符类截断：D:\vms\win11arm\安装记录.md 只剩 D:/vms/win11arm
  const msg = "文档已生成：D:\\vms\\win11arm\\安装记录.md";
  const out = extractFilePaths(msg);
  assert.ok(out.some((p) => p.path === "D:/vms/win11arm/安装记录.md" && !p.isDir), JSON.stringify(out));
  // 全角冒号「：」（\uFF1A）不得误入路径前缀（被当目录吞「：D:\vms\win11arm\」）
  assert.ok(!out.some((p) => p.path.startsWith("：")), JSON.stringify(out));
  // 中间路径段含中文
  const mid = extractFilePaths("写到了 D:\\项目\\v1\\操作手册.pdf");
  assert.ok(mid.some((p) => p.path === "D:/项目/v1/操作手册.pdf" && !p.isDir), JSON.stringify(mid));
  // 正斜杠形式 + 中文文件名
  const fwd = extractFilePaths("看 D:/vms/win11arm/安装记录.md");
  assert.ok(fwd.some((p) => p.path === "D:/vms/win11arm/安装记录.md" && !p.isDir), JSON.stringify(fwd));
  // 裸中文文件名（前是空格 → 命中）
  const bare = extractFilePaths("已生成 安装记录.md 请查阅");
  assert.ok(bare.some((p) => p.path === "安装记录.md" && !p.isDir), JSON.stringify(bare));
});

test("extractFiles: 全角标点不误入路径段（全角冒号/句号）", () => {
  // 全角冒号「：」\uFF1A、全角句号「。」\u3002 不在 CJK 集（全角范围只取字母数字），不作为路径段字符
  assert.equal(
    extractFilePaths("文档：D:\\vms\\安装记录.md").find((p) => p.path.includes("安装记录"))?.path,
    "D:/vms/安装记录.md",
  );
  const r = extractFilePaths("完成了。文档生成 D:\\x\\安装记录.md");
  assert.ok(r.some((p) => p.path === "D:/x/安装记录.md" && !p.isDir), JSON.stringify(r));
  assert.ok(!r.some((p) => p.path.includes("。")), JSON.stringify(r));
});

test("mergeExternalRoots: MSYS 形式根归一化为盘符", () => {
  const roots = mergeExternalRoots("D:/workspace/demo-repo", [], [{ path: "/d/workspace/pi-web/" }, { path: "D:\\workspace\\other" }]);
  assert.deepEqual(roots, ["D:/workspace/pi-web", "D:/workspace/other"]);
});
test("extractUrls: strips trailing punctuation", () => {
  const urls = extractUrls("访问 https://example.com/docs ，或 https://x.io/a?b=1。");
  assert.deepEqual(urls, ["https://example.com/docs", "https://x.io/a?b=1"]);
});

test("summarizeSegment: short text unchanged", () => {
  assert.equal(summarizeSegment("你好"), "你好");
});

test("summarizeSegment: long text head…tail within budget", () => {
  const out = summarizeSegment("这是一段非常长的段落内容需要被截断成头部和尾部摘要的形式来适应按钮宽度预算");
  assert.ok(out.includes("…"), `expected ellipsis in ${out}`);
  assert.ok(out.length < 48, `expected shortened, got ${out}`);
  assert.ok(out.length > 12, `expected a fairly long summary, got ${out}`);
});

test("summarizeSegment: larger budget shows more text (viewport-aware caller)", () => {
  const text = "这是一段非常长的段落内容需要被截断成头部和尾部摘要的形式来适应按钮宽度预算，因此在窄屏上显示会偏短，宽屏则应当保留更多原文内容方便区分与选择";
  const narrow = summarizeSegment(text, 32);
  const wide = summarizeSegment(text, 64);
  assert.ok(!narrow.includes("\n"), "no newlines in summary");
  assert.ok(wide.length > narrow.length, `wider budget should keep more: narrow=${narrow} wide=${wide}`);
  assert.ok(wide.length < text.length, `still truncated at 64: ${wide}`);
  // 超大预算完整显示（不截断）
  assert.equal(summarizeSegment(text, 999), text);
  // 非法预算兑底默认 32
  assert.equal(summarizeSegment(text, -1), narrow);
  assert.equal(summarizeSegment(text, NaN), narrow);
});

test("parseParagraph: labelMax option widens option labels (viewport-aware caller)", () => {
  const segs = parseParagraph("要我帮你修改这个非常长的文件路径并且完成所有关联的配置项吗？");
  const opts = segs[0].options;
  assert.ok(opts && opts.length === 2);
  assert.ok(opts[0].label.includes("…"), `narrow label truncated: ${opts[0].label}`);
  const wideSegs = parseParagraph("要我帮你修改这个非常长的文件路径并且完成所有关联的配置项吗？", { labelMax: 30 });
  const wideOpts = wideSegs[0].options;
  assert.ok(!wideOpts[0].label.includes("…"), `wide label untruncated: ${wideOpts[0].label}`);
  assert.ok(wideOpts[0].label.length > opts[0].label.length);
});

test("encodeFilePathForApi: keeps / separators (no leading slash)", () => {
  assert.equal(encodeFilePathForApi("/home/user/a b.ts"), "home/user/a%20b.ts");
});

test("mergeExternalRoots: stores + watch paths, dedup, strip cwd/trailing slash, order", () => {
  const roots = mergeExternalRoots(
    "/home/pi/workspace/demo-repo",
    [{ root: "/home/pi/workspace/demo-repo/", role: "primary" }, { root: "/home/pi/workspace/pi-web", role: "secondary" }],
    [{ path: "/home/pi/workspace/pi-web" }, { path: "/home/pi/workspace/other-repo/" }],
  );
  // cwd 同名根被剔除；pi-web 去重保序；关注路径补充在后
  assert.deepEqual(roots, ["/home/pi/workspace/pi-web", "/home/pi/workspace/other-repo"]);
});

test("mergeExternalRoots: malformed entries tolerated", () => {
  assert.deepEqual(mergeExternalRoots("/w", null, undefined), []);
  assert.deepEqual(mergeExternalRoots("/w", [{}, { root: "" }, "x"], [{ nope: 1 }]), []);
});

test("candidatesFromRoots: relative path joined per root, absolute/~ skipped", () => {
  const roots = ["/home/pi/workspace/pi-web", "/home/pi/workspace/pi-prod"];
  assert.deepEqual(
    candidatesFromRoots("docs/pi-web-defork-roadmap.md", roots),
    ["/home/pi/workspace/pi-web/docs/pi-web-defork-roadmap.md", "/home/pi/workspace/pi-prod/docs/pi-web-defork-roadmap.md"],
  );
  assert.deepEqual(
    candidatesFromRoots("./docs/x.md", roots),
    ["/home/pi/workspace/pi-web/docs/x.md", "/home/pi/workspace/pi-prod/docs/x.md"],
  );
  assert.deepEqual(candidatesFromRoots("/abs/x.md", roots), []);
  assert.deepEqual(candidatesFromRoots("~/x.md", roots), []);
  assert.deepEqual(candidatesFromRoots("C:\\x.md", roots), []);
  assert.deepEqual(candidatesFromRoots("docs/x.md", []), []);
});

test("selfNameCandidates: rel 首段 = 基名 → 父目录 + rel（自带名字自引用）", () => {
  // user scenario: session cwd inside demo-repo, AI writes demo-repo/docs/... from the parent view (self-reference)
  assert.deepEqual(
    selfNameCandidates("demo-repo/docs/carbon-expert-hotswapagent-plugin-needs.md", "/home/pi/workspace/demo-repo"),
    ["/home/pi/workspace/demo-repo/docs/carbon-expert-hotswapagent-plugin-needs.md"],
  );
  // 外部根同理：会话处理过 cwd 外仓，按兄弟仓名引用
  assert.deepEqual(
    selfNameCandidates("pi-web/docs/x.md", "/home/pi/workspace/pi-web"),
    ["/home/pi/workspace/pi-web/docs/x.md"],
  );
  // 精确等于基名（裸目录名引用自己）
  assert.deepEqual(selfNameCandidates("demo-repo", "/home/pi/workspace/demo-repo"), ["/home/pi/workspace/demo-repo"]);
  // Windows 基/rel 反斜杠归一化
  assert.deepEqual(
    selfNameCandidates("demo-repo\\docs\\x.md", "D:\\workspace\\demo-repo"),
    ["D:/workspace/demo-repo/docs/x.md"],
  );
  // workspace 根作为分辨基：workspace/pi-web/… 也能解析
  assert.deepEqual(
    selfNameCandidates("workspace/pi-web/docs/x.md", "/home/pi/workspace"),
    ["/home/pi/workspace/pi-web/docs/x.md"],
  );
});

test("selfNameCandidates: 首段 ≠ 基名 → 无候选；绝对/~ /盘符跳过；基无父目录/非法跳过", () => {
  assert.deepEqual(selfNameCandidates("docs/x.md", "/home/pi/workspace/demo-repo"), []);
  assert.deepEqual(selfNameCandidates("pi-prod/docs/x.md", "/home/pi/workspace/demo-repo"), []);
  assert.deepEqual(selfNameCandidates("/abs/demo-repo/x.md", "/home/pi/workspace/demo-repo"), []);
  assert.deepEqual(selfNameCandidates("~/demo-repo/x.md", "/home/pi/workspace/demo-repo"), []);
  assert.deepEqual(selfNameCandidates("C:\\demo-repo\\x.md", "/home/pi/workspace/demo-repo"), []);
  assert.deepEqual(selfNameCandidates("demo-repo/x.md", "/"), []);
  assert.deepEqual(selfNameCandidates("demo-repo/x.md", "D:/"), []);
  assert.deepEqual(selfNameCandidates("", "/home/pi/workspace/demo-repo"), []);
  assert.deepEqual(selfNameCandidates("demo-repo/x.md", ""), []);
  assert.deepEqual(selfNameCandidates("demo-repo/x.md", "/home/pi/workspace/demo-repo/"), ["/home/pi/workspace/demo-repo/x.md"]);
});

test("extractFiles: 自带名字路径（自引用）正常提取——首段是 cwd 名", () => {
  // full chain: recognition first extracts demo-repo/docs/... as an ordinary relative path
  const out = extractFilePaths("参考 demo-repo/docs/carbon-expert-hotswapagent-plugin-needs.md 的方案");
  assert.ok(
    out.some((p) => p.path === "demo-repo/docs/carbon-expert-hotswapagent-plugin-needs.md" && !p.isDir),
    JSON.stringify(out),
  );
});