/**
 * WP-A 单测 —— recognize.ts（node:test，表驱动）。
 * 运行：npx tsx --test pi-git-trace/lib/recognize.test.mjs
 *
 * 平台过滤（各系统跑各的测试）：多数用例断言 POSIX 绝对路径语义
 *（/home、/tmp、/repos 等——Windows 上 normalize 成盘符路径，断言必然不等），
 * 标 SKIP_ON_WIN 仅 Linux 执行；跨平台成立的用例（cwd 内写不误报、isWithinPath）两边都跑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseBashTargets, parseToolWritePath, isWithinPath } from "./recognize.ts";

const HOME = "/home/tester";
const CWD = "/home/tester/work/pi-proj";
const OPTS = { home: HOME };
const SKIP_ON_WIN = process.platform === "win32" ? "POSIX 绝对路径语义用例（/home、/tmp 等），仅 Linux 跑" : false;

test("cd 邻仓 && sed -i 写：switchedDirs + cwdEscapes", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(
    `cd ~/workspace/pi-web && sed -i 's/a/b/' src/x.ts`,
    CWD,
    OPTS,
  );
  assert.deepEqual(r.switchedDirs, [`${HOME}/workspace/pi-web`]);
  assert.ok(r.cwdEscapes.includes(`${HOME}/workspace/pi-web/src/x.ts`));
});

test("git -C dir：计入 switchedDirs，无写目标不误报", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`git -C /repos/other status`, CWD, OPTS);
  assert.deepEqual(r.switchedDirs, ["/repos/other"]);
  assert.deepEqual(r.cwdEscapes, []);
});

test("改基点旗标：npm --prefix / systemctl --root=后缀 / env -C", { skip: SKIP_ON_WIN }, () => {
  const r1 = parseBashTargets(`npm --prefix /opt/app run build`, CWD, OPTS);
  assert.ok(r1.switchedDirs.includes("/opt/app"));
  const r2 = parseBashTargets(`systemctl --root=/srv/ro enable u`, CWD, OPTS);
  assert.ok(r2.switchedDirs.includes("/srv/ro"));
  const r3 = parseBashTargets(`env -C /srv/x make`, CWD, OPTS);
  assert.ok(r3.switchedDirs.includes("/srv/x"));
});

test("tar -C 组合词 -Cdir", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`tar -C/repo -xf a.tgz`, CWD, OPTS);
  assert.ok(r.switchedDirs.includes("/repo"));
});

test("/tmp 重定向：cwdEscapes", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`echo x > /tmp/1.log`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, ["/tmp/1.log"]);
  const r2 = parseBashTargets(`echo x >> /tmp/2.log 2> /tmp/2.err`, CWD, OPTS);
  assert.ok(r2.cwdEscapes.includes("/tmp/2.log"));
  assert.ok(r2.cwdEscapes.includes("/tmp/2.err"));
});

test("cwd 内写不误报", () => {
  const r = parseBashTargets(`echo hi >> out.txt && cp a.txt b.txt`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, []);
  assert.deepEqual(r.switchedDirs, []);
});

test("writeTargets：cwd 内写目标也收集（P0-3b 命中仓判定），escape 目标包含在内，/dev/null 剔除", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`echo hi >> out.txt && cp a.txt sub/b.txt`, CWD, OPTS);
  assert.ok(r.writeTargets.includes(`${CWD}/out.txt`));
  assert.ok(r.writeTargets.includes(`${CWD}/sub/b.txt`));
  const r2 = parseBashTargets(`echo x > /tmp/1.log && echo y > /dev/null`, CWD, OPTS);
  assert.ok(r2.writeTargets.includes("/tmp/1.log"));
  assert.ok(!r2.writeTargets.includes("/dev/null"));
  const r3 = parseBashTargets(`git status`, CWD, OPTS);
  assert.deepEqual(r3.writeTargets, []);
});

test("writeTargets（win32 形态：反斜杠字面 + 相对目标解析）", { skip: process.platform !== "win32" ? "仅 Windows 跑" : false }, () => {
  const WCWD = "C:\\repos\\demo";
  const r = parseBashTargets(`echo hi >> out.txt && cp a.txt sub\\b.txt`, WCWD, { home: "C:\\Users\\t" });
  const joined = JSON.stringify(r);
  assert.ok(joined.includes("out.txt"), `目标丢失：${joined.slice(0, 200)}`);
  assert.ok(joined.includes("b.txt"), `目标丢失：${joined.slice(0, 200)}`);
  assert.ok(!joined.includes("C:repos"), `反斜杠被吃：${joined.slice(0, 200)}`);
});

test("heredoc body 不识别、重定向目标正常", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(
    `cat <<'EOF' > /tmp/x\nrm -rf /\nEOF`,
    CWD,
    OPTS,
  );
  assert.deepEqual(r.cwdEscapes, ["/tmp/x"]);
});

test("子 shell：内部 cd 被识别、基点不外泄", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`(cd /other && echo x > f) ; echo y > rel.txt`, CWD, OPTS);
  assert.ok(r.switchedDirs.includes("/other"));
  assert.ok(r.cwdEscapes.includes("/other/f"));
  // 子 shell 结束后基点还原：rel.txt 在 CWD 内，不逃逸
  assert.ok(!r.cwdEscapes.some((p) => p.endsWith("rel.txt")));
});

test("pushd/popd 回退基点", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(
    `cd /base/a && pushd /base/b && popd && echo x > rel.txt`,
    "/base/c",
    OPTS,
  );
  assert.ok(r.switchedDirs.includes("/base/a"));
  assert.ok(r.switchedDirs.includes("/base/b"));
  assert.ok(r.cwdEscapes.includes("/base/a/rel.txt"));
});

test("cp/mv 目标为最后一个参数；cp -t 目标目录", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`cp a.txt /tmp/b.txt`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, ["/tmp/b.txt"]);
  const r2 = parseBashTargets(`cp -t /tmp/d a b`, CWD, OPTS);
  assert.deepEqual(r2.cwdEscapes, ["/tmp/d"]);
  const r3 = parseBashTargets(`mv x y`, CWD, OPTS);
  assert.deepEqual(r3.cwdEscapes, []);
});

test("tee / sudo tee：全部参数为写目标", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`echo x | tee /etc/x.conf`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, ["/etc/x.conf"]);
  const r2 = parseBashTargets(`sudo tee /etc/y.conf`, CWD, OPTS);
  assert.deepEqual(r2.cwdEscapes, ["/etc/y.conf"]);
});

test("sed -i.bak 多文件：脚本表达式跳过、其余为目标", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`sed -i.bak -e 's/1/2/' f1 f2`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, []);
  const r2 = parseBashTargets(`sed -i 's/1/2/' /etc/f`, CWD, OPTS);
  assert.deepEqual(r2.cwdEscapes, ["/etc/f"]);
});

test("dd of= / /dev/null 忽略 / $VAR 不可解析跳过", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`dd of=/tmp/img bs=1`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, ["/tmp/img"]);
  const r2 = parseBashTargets(`echo x > /dev/null && echo y > $OUT/f`, CWD, OPTS);
  assert.deepEqual(r2.cwdEscapes, []);
});

test("管道后段照常识别；换行分段", { skip: SKIP_ON_WIN }, () => {
  const r = parseBashTargets(`ls | grep x\necho z > /tmp/z.log`, CWD, OPTS);
  assert.deepEqual(r.cwdEscapes, ["/tmp/z.log"]);
});

test("parseToolWritePath：相对/~/缺参", { skip: SKIP_ON_WIN }, () => {
  assert.equal(parseToolWritePath({ file_path: "src/a.ts" }, CWD, HOME), `${CWD}/src/a.ts`);
  assert.equal(parseToolWritePath({ path: "~/b.md" }, CWD, HOME), `${HOME}/b.md`);
  assert.equal(parseToolWritePath({ path: "/abs/x" }, CWD, HOME), "/abs/x");
  assert.equal(parseToolWritePath({}, CWD, HOME), null);
  assert.equal(parseToolWritePath({ path: 42 }, CWD, HOME), null);
  assert.equal(parseToolWritePath(undefined, CWD, HOME), null);
});

test("isWithinPath 基本语义", () => {
  assert.equal(isWithinPath("/a/b", "/a/b/c"), true);
  assert.equal(isWithinPath("/a/b", "/a/b"), true);
  assert.equal(isWithinPath("/a/b", "/a/bc"), false);
  assert.equal(isWithinPath("/a/b", "/x/y"), false);
});

test("win32 词法：反斜杠是字面字符（路径不被吃）；POSIX 仍转义", () => {
  if (process.platform === "win32") {
    // win32 词法：\ 是字面字符。用 cp（writeLastArgCmds）让目标词真正落进 writeTargets，
    // 断言反斜杠路径完整保留、未退化成 C:reposdemox.ts（git add 不在写目标规则表，词不落盘，断言会空洞通过）
    const r = parseBashTargets(String.raw`cp src C:\repos\demo\x.ts`, String.raw`C:\repos\demo`, { home: String.raw`C:\Users\t` });
    const joined = JSON.stringify(r);
    assert.ok(r.writeTargets.length > 0, `win32 词法未产出写目标：${joined.slice(0, 200)}`);
    assert.ok(!joined.includes("C:repos"), `反斜杠被转义吃掉：${joined.slice(0, 200)}`);
  } else {
    // POSIX：\ 转义空格 → 单词 foo bar（cp 尾参 = 写目标；git add 不在写目标规则表，词不落盘）
    const r = parseBashTargets("cp src foo\\ bar", CWD, OPTS);
    const joined = JSON.stringify(r);
    assert.ok(joined.includes("foo bar"), `POSIX 转义语义被破坏：${joined.slice(0, 200)}`);
  }
});
