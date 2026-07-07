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

  it("auto-approves read-only workbench navigation tools", () => {
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__open_table"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__focus_column"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__focus_row"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__focus_cell"), true);
  });

  it("auto-approves read-only database profile tools", () => {
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__get_database_profile"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__refresh_database_profile"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__search_database_profile"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-db__find_related_tables"), true);
  });

  it("normalizes SDK MCP-prefixed project tool names", () => {
    assert.equal(normalizeToolName("mcp__dbscout-project__list_project_files"), "list_project_files");
    assert.equal(normalizeToolName("mcp__dbscout-project__read_project_file"), "read_project_file");
  });

  it("auto-approves read-only project tools", () => {
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-project__list_project_files"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-project__search_project_files"), true);
    assert.equal(isAutoApprovedReadOnlyDbTool("mcp__dbscout-project__read_project_file"), true);
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
