import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRelationTools } from "./relationTools.mjs";

function tools() {
  const registrations = new Map();
  const requests = [];
  registerRelationTools((name, config, handler) => registrations.set(name, { config, handler }), {
    async request(op, payload) { requests.push({ op, ...payload }); return { ok: true }; },
  });
  return { registrations, requests };
}

test("all relation tools require explicit targets and forward through the bounded endpoint", async () => {
  const { registrations, requests } = tools();
  for (const { config } of registrations.values()) assert.equal(config.inputSchema.safeParse({}).success, false);
  const tool = registrations.get("read_reference_rows");
  const input = tool.config.inputSchema.parse({ connectionId: "c", database: "db", relationId: "reward.items[]>goods.id", rowIdentity: { id: "9007199254740999" } });
  await tool.handler(input);
  assert.equal(requests[0].func, "read_reference_rows");
  assert.equal(requests[0].args.rowIdentity.id, "9007199254740999");
  assert.equal(requests[0].args.limit, 50);
  assert.equal(tool.config.inputSchema.safeParse({ ...input, rowIdentity: { id: 9007199254740999 } }).success, false);
});

test("rule changes require explicit confirmation and bounded declarative parsers", () => {
  const { registrations } = tools();
  const apply = registrations.get("apply_relation_rule");
  const args = { connectionId: "c", database: "db", previewId: "550e8400-e29b-41d4-a716-446655440000" };
  assert.equal(apply.config.inputSchema.safeParse(args).success, false);
  assert.equal(apply.config.inputSchema.safeParse({ ...args, confirmed: true }).success, true);
  const preview = registrations.get("preview_relation_rule");
  const draft = { sourceTable: "rewards", sourceColumn: "items", targetTable: "goods", targetColumn: "id", evidence: "code and column comment" };
  assert.equal(preview.config.inputSchema.safeParse({ ...args, draft }).success, true);
  for (const parser of [{ type: "eval", code: "return 1001" }, { type: "token", delimiter: "|", index: 999 }]) {
    assert.equal(preview.config.inputSchema.safeParse({ ...args, draft: { ...draft, parser } }).success, false);
  }
});

test("history is opt-in, rare-branch preview offsets are bounded and code cursors bind the query", () => {
  const { registrations } = tools();
  const scope = { connectionId: "c", database: "db" };
  const rules = registrations.get("get_relation_rules").config.inputSchema.parse(scope);
  assert.equal(rules.includeHistory, false);
  assert.equal(rules.limit, 50);
  const search = registrations.get("search_relation_code").config.inputSchema;
  assert.equal(search.safeParse({ ...scope, keyword: "goods", cursor: { manifest: "hash", file: 1, line: 5 } }).success, false);
  assert.equal(search.safeParse({ ...scope, keyword: "goods", cursor: { manifest: "hash", query: "bound-query", file: 1, line: 5, fileHash: "file-hash" } }).success, true);
  const preview = registrations.get("preview_relation_rule").config.inputSchema;
  const draft = { sourceTable: "rewards", sourceColumn: "items", targetTable: "goods", targetColumn: "id", evidence: "source", parser: { type: "keys", delimiter: "json" } };
  assert.equal(preview.parse({ ...scope, draft, sampleOffset: 1000 }).sampleOffset, 1000);
  assert.equal(preview.safeParse({ ...scope, draft, sampleOffset: -1 }).success, false);
  assert.equal(preview.safeParse({ ...scope, draft: { ...draft, parser: { type: "keys", delimiter: ";" } } }).success, false);
});
