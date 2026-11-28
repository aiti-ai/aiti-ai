import test from "node:test";
import assert from "node:assert/strict";
import { buildConditions, createMR, getWorkItem, listComments, listProjects, listWorkItems } from "../providers/yunxiao/api.ts";

const cfg = { orgId: "o1", token: "t", authType: "pat" };
const scope = { kind: "project", id: "p1", label: "项目一" };

function fakeHttp({ data, json, headers = {} }) {
  const calls = [];
  return {
    calls,
    baseUrl: "https://api.example.com",
    async req(path, opts) {
      calls.push({ path, opts });
      return { data, status: 200, headers: new Headers(headers) };
    },
    async json(path, opts) {
      calls.push({ path, opts });
      return json ?? data;
    },
  };
}

const rawItem = {
  id: "w1",
  serialNumber: "CEXP-1",
  subject: "登录失败",
  categoryId: "Bug",
  status: { displayName: "进行中" },
  statusStageId: 2,
  assignedTo: { name: "alice" },
  creator: { name: "bob" },
  priority: 2,
  labels: [{ name: "p0" }],
  gmtCreate: "2026-01-01T00:00:00Z",
  gmtModified: "2026-01-02T00:00:00Z",
};

test("buildConditions: keyword identifier", () => {
  const r = buildConditions({ keyword: "#CEXP-42", excludeTerminal: true });
  const parsed = JSON.parse(r.conditions);
  assert.equal(parsed.conditionGroups[0][0].fieldIdentifier, "serialNumber");
  assert.deepEqual(parsed.conditionGroups[0][0].value, ["CEXP-42"]);
  assert.equal(parsed.conditionGroups[0][1].fieldIdentifier, "statusStage");
  assert.equal(r.category, "Req,Bug,Task,Risk,SubTask");
});

test("buildConditions: subject/description OR groups + extra AND, types", () => {
  const r = buildConditions({ keyword: "login", statuses: ["进行中"], excludeTerminal: true, assignee: "alice", types: ["Bug", "Task"] });
  const parsed = JSON.parse(r.conditions);
  assert.equal(parsed.conditionGroups.length, 2);
  assert.deepEqual(parsed.conditionGroups[0].map((c) => c.fieldIdentifier), ["subject", "status", "statusStage", "assignedTo"]);
  assert.deepEqual(parsed.conditionGroups[1].map((c) => c.fieldIdentifier), ["description", "status", "statusStage", "assignedTo"]);
  assert.equal(r.category, "Bug,Task");
});

test("buildConditions: only extra conditions", () => {
  const parsed = JSON.parse(buildConditions({ statuses: ["已完成"] }).conditions);
  assert.equal(parsed.conditionGroups.length, 1);
  assert.equal(parsed.conditionGroups[0][0].operator, "CONTAINS");
  assert.equal(buildConditions({}).conditions, "");
});

test("listProjects maps fields and pagination headers", async () => {
  const http = fakeHttp({ data: [{ identifier: "p1", name: "项目一" }, { id: "p2", name: "项目二" }], headers: { "x-total": "7", "x-total-pages": "2" } });
  const page = await listProjects(cfg, { page: 1, pageSize: 2 }, http);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].id, "p1");
  assert.equal(page.items[0].webUrl, "https://devops.aliyun.com/projex/project/p1");
  assert.equal(page.total, 7);
  assert.equal(page.hasMore, true);
  assert.equal(http.calls[0].path, "/oapi/v1/projex/organizations/o1/projects:search");
});

test("listWorkItems maps state/type/tags and paging", async () => {
  const http = fakeHttp({ data: [rawItem, { ...rawItem, id: "w2", serialNumber: "CEXP-2", statusStageId: 4 }], headers: { "x-total-pages": "1" } });
  const page = await listWorkItems(cfg, scope, { excludeTerminal: true }, { page: 1, pageSize: 50 }, http);
  assert.equal(page.items[0].key, "CEXP-1");
  assert.equal(page.items[0].type, "缺陷");
  assert.equal(page.items[0].state, "open");
  assert.equal(page.items[0].assignee, "alice");
  assert.deepEqual(page.items[0].tags, ["p0"]);
  assert.equal(page.items[0].scope.id, "p1");
  assert.equal(page.items[1].state, "closed");
  assert.equal(page.hasMore, false);
  const body = JSON.parse(JSON.stringify(http.calls[0].opts.body));
  assert.equal(body.spaceId, "p1");
  assert.equal(body.category, "Req,Bug,Task,Risk,SubTask");
  assert.match(body.conditions, /statusStage/);
});

test("getWorkItem flattens rich text and extracts custom fields", async () => {
  const http = fakeHttp({
    json: {
      ...rawItem,
      description: JSON.stringify({ jsonMLValue: ["root", {}, ["p", {}, "描述文本"], ["img", { src: "https://x/i.png" }]] }),
      sprint: { name: "S1" },
      participants: [{ name: "alice" }],
      customFieldValues: [{ fieldName: "环境", value: "prod" }],
    },
  });
  const item = await getWorkItem(cfg, scope, "w1", http);
  assert.equal(item.description, "描述文本");
  assert.equal(item.descriptionFormat, "richtext");
  assert.match(item.descriptionHtml, /描述文本/);
  assert.deepEqual(item.images, ["https://x/i.png"]);
  assert.deepEqual(item.extraFields.map((f) => f.label), ["Sprint", "参与人", "环境"]);
});

test("listComments flattens content", async () => {
  const http = fakeHttp({ json: [{ id: "c1", content: { htmlValue: "<p>hi</p>" }, user: { name: "alice" }, gmtCreate: "2026-01-01T00:00:00Z", top: true }] });
  const list = await listComments(cfg, { ...rawItem, id: "w1", key: "CEXP-1", title: "t", type: "", status: "", state: "open", tags: [], scope }, http);
  assert.equal(list[0].author, "alice");
  assert.equal(list[0].body, "hi");
  assert.equal(list[0].top, true);
});

test("createMR builds the request body and web URL fallback", async () => {
  const http = fakeHttp({ json: { localId: 9, title: "MR", sourceBranch: "feat", targetBranch: "master" } });
  const mr = await createMR(cfg, { id: "42", name: "repo", path: "group/repo" }, { sourceBranch: "feat", targetBranch: "master", title: "MR", description: "d" }, http);
  assert.equal(mr.webUrl, "https://codeup.aliyun.com/group/repo/change/9");
  assert.equal(http.calls[0].path, "/oapi/v1/codeup/organizations/o1/repositories/42/changeRequests");
  assert.equal(http.calls[0].opts.body.sourceProjectId, 42);
  assert.equal(http.calls[0].opts.body.triggerAIReviewRun, false);
});
