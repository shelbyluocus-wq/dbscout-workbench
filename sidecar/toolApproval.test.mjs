import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPermissionResult,
  isAutoApprovedReadOnlyDbTool,
  normalizeToolName,
} from "./toolApproval.mjs";

describe("tool approval classification", () => {
  it("normalizes SDK MCP-prefixed DB tool names", () => {
    assert.equal(normalizeToolName("mcp__dbscout-db__list_tables"), "list_tables");
    assert.equal(normalizeToolName("mcp__dbscout-db__run_read_query"), "run_read_query");
  });

  it("auto-approves read-only DB tools even when SDK prefixes the tool name", () => {
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__list_tables"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__describe_table"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__run_read_query"), true);
  });

  it("does not auto-approve write tools", () => {
    assert.equal(isAutoApprovedReadOnlyDbTool("run_write_query"), false);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__run_write_query"), false);
  });

  it("includes the original input when allowing tools", () => {
    const input = { database: "game_db", limit: 3 };
    assert.deepEqual(createPermissionResult("allow", input), {
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("includes denial messages for rejected tools", () => {
    assert.deepEqual(createPermissionResult("deny", {}, { message: "nope" }), {
      behavior: "deny",
      message: "nope",
    });
  });
});
