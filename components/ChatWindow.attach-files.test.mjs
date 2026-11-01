import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const { dropMentionText, splitDroppedItems } = await jiti.import("../lib/file-upload-client.ts");
const { buildFileAtMentionsText } = await jiti.import("../lib/file-fuzzy.ts");

const sourceText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ChatWindow.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Runs one of ChatWindow's useCallback bodies against the given scope. */
function chatWindowCallback(name, context) {
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

const photo = new File(["x"], "photo.png", { type: "image/png" });
const report = new File(["x"], "report.pdf", { type: "application/pdf" });
const log = new File(["x"], "server.log", { type: "" });

/** Shared scope stubbing the composer ref, notices, and the upload API. */
function makeScope({ cwd = "/project", response } = {}) {
  const calls = { images: [], uploads: [], mentions: [], notices: [], refreshed: 0 };
  const scope = {
    session: null,
    newSessionCwd: cwd,
    chatInputRef: {
      current: {
        addImages: (images) => calls.images.push(...images),
        insertText: (text) => calls.mentions.push(text),
      },
    },
    addNotice: (notice) => calls.notices.push([notice.type, notice.message]),
    t: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    onFilesUploaded: () => { calls.refreshed += 1; },
    splitDroppedItems,
    dropMentionText,
    buildFileAtMentionsText,
    uploadFiles: async (target, uploads, strategy, _onProgress, ensureDir) => {
      calls.uploads.push([target, uploads.map((file) => file.name), strategy, ensureDir === true]);
      return response;
    },
  };
  scope.uploadAttachedFiles = chatWindowCallback("uploadAttachedFiles", scope);
  scope.uploadDroppedFiles = chatWindowCallback("uploadDroppedFiles", scope);
  scope.onDrop = chatWindowCallback("onDrop", scope);
  scope.onAttachFiles = chatWindowCallback("onAttachFiles", scope);
  return { scope, calls };
}

/** Picks files with the composer's attach button. */
async function attach(files, options) {
  const { scope, calls } = makeScope(options);
  scope.onAttachFiles(files);
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

/** Drops files onto the chat area. */
async function drop(files, options) {
  const { scope, calls } = makeScope(options);
  scope.onDrop(files.map((file) => ({ kind: "file", file })));
  await new Promise((resolve) => setImmediate(resolve));
  return calls;
}

test("the attach button sends images to the composer and documents to .pi-attachments (#1101)", async () => {
  const mixed = await attach([photo, report, log], {
    response: { status: 207, data: { uploaded: ["report.pdf"], skipped: ["server.log"] } },
  });
  // Images attach to the prompt; documents land in the session's git-hidden
  // attachments directory (auto-created server-side) and are mentioned there.
  assert.deepEqual(mixed.images, [photo]);
  assert.deepEqual(mixed.uploads, [["/project/.pi-attachments", ["report.pdf", "server.log"], "skip", true]]);
  assert.deepEqual(mixed.mentions, ["@.pi-attachments/report.pdf @.pi-attachments/server.log "]);
  assert.deepEqual(mixed.notices, [
    ["success", 'chat.attachUploaded {"count":1}'],
    ["warning", 'chat.attachAlreadyExists {"names":"server.log"}'],
  ]);
  // The file explorer keeps hiding .pi-attachments (its own .gitignore), so no refresh is needed.
  assert.equal(mixed.refreshed, 0);

  const imagesOnly = await attach([photo]);
  assert.deepEqual(imagesOnly.images, [photo]);
  assert.deepEqual(imagesOnly.uploads, []);
  assert.deepEqual(imagesOnly.notices, []);
});

test("without a working directory, picked files behave like a drop there (#1101)", async () => {
  const calls = await attach([photo, report], { cwd: null });
  assert.deepEqual(calls.images, [photo]);
  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.notices, [["warning", "chat.dropNeedsCwd"]]);
});

test("drag-and-drop keeps uploading into the project root (#1101)", async () => {
  const calls = await drop([report], {
    response: { status: 200, data: { uploaded: ["report.pdf"] } },
  });
  // Dropping is the explicit "add to my project" flow: project root, no ensure, no auto git hiding.
  assert.deepEqual(calls.uploads, [["/project", ["report.pdf"], "skip", false]]);
  assert.deepEqual(calls.mentions, ["@report.pdf "]);
  assert.deepEqual(calls.notices, [["success", 'chat.dropUploaded {"count":1}']]);
  assert.equal(calls.refreshed, 1);
});

test("wires the attach handler into the main composer only", () => {
  assert.match(sourceText, /cwd=\{session\?\.cwd \?\? newSessionCwd\}[\s\S]*?onAttachFiles=\{onAttachFiles\}/); // 合并：中间隔本地新增 props（宽松）
  assert.equal((sourceText.match(/onAttachFiles=/g) ?? []).length, 1);
});
