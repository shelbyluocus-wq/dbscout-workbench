import assert from "node:assert/strict";
import { test } from "node:test";
import { canCommit, canRevert, isConflict, svnErrorCode, svnErrorDetail, useSvnWorkspace } from "./composables/useSvnWorkspace.js";
import { createDemoSvnSource } from "./utils/releaseSvnDemo.js";

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the demo working copy lists the converted files, shows their diffs and commits the checked ones", async () => {
  const memory = { committed: [], reverted: [], revision: 0, commits: [] };
  const records = [];
  const svn = useSvnWorkspace({
    source: createDemoSvnSource({ memory, platformId: () => "tw", wait: () => Promise.resolve(), now: () => Date.UTC(2026, 9, 24) }),
    onRecord: (record) => records.push(record),
  });
  assert.equal(await svn.open("D:\\jswz\\release\\tw\\jswz"), true);
  assert.equal(svn.state.info.revision, 52817);
  assert.equal(svn.state.entries.length, 7);
  assert.equal(svn.checkedPaths.value.length, 7, "changes start checked, as in a commit dialog");
  assert.equal(svn.state.selected, "assets/props/props/heroprop.json");
  assert.equal(svn.state.diff.hunks[0].header, "@@ -2002,7 +2002,7 @@");

  svn.select("assets/props/propsH5/props.bin");
  await settle();
  assert.equal(svn.state.diff.binary, true);

  svn.setChecked("assets/bundles/activity/P0/4.png", false);
  svn.state.message = "同步 10/24 版本";
  const result = await svn.commit();
  assert.equal(result.revision, 52818);
  assert.deepEqual(svn.state.entries.map((entry) => entry.path), ["assets/bundles/activity/P0/4.png"]);
  assert.equal(svn.state.message, "");
  assert.deepEqual([memory.commits[0].message, memory.commits[0].paths.length], ["同步 10/24 版本", 6]);
  assert.deepEqual([records[0].kind, records[0].outcome, records[0].simulated, records[0].details.paths.length], ["commit", "done", true, 6]);

  await svn.loadLog();
  assert.equal(svn.state.log[0].revision, 52818);
  await svn.revert(["assets/bundles/activity/P0/4.png"]);
  assert.deepEqual(svn.state.entries, []);
  assert.deepEqual(memory.reverted, ["assets/bundles/activity/P0/4.png"]);
});

test("conflicts and unversioned files are their own groups; failures keep svn's reason", async () => {
  const records = [];
  const source = {
    kind: "backend",
    info: async (root) => ({ root, url: "https://svn.example/jswz", revision: 5 }),
    status: async () => [
      { path: "a.ts", item: "modified", props: "none", kind: "file", treeConflict: false },
      { path: "b.ts", item: "conflicted", props: "none", kind: "file", treeConflict: false },
      { path: "new.txt", item: "unversioned", props: "none", kind: "file", treeConflict: false },
      { path: "dir", item: "normal", props: "none", kind: "dir", treeConflict: true },
    ],
    fileDiff: async (root, path, unversioned) => (unversioned
      ? { path, diff: "", content: "hello\r\nworld\r\n", binary: false, tooLarge: false, encoding: "utf-8" }
      : { path, diff: "", content: null, binary: false, tooLarge: false, encoding: "utf-8" }),
    commit: async () => {
      throw new Error("outOfDate: svn: E155011: File 'a.ts' is out of date");
    },
    revert: async (root, paths) => ({ paths, output: "" }),
    resolve: async (root, paths) => ({ paths, output: "" }),
    log: async () => [],
  };
  const svn = useSvnWorkspace({ source, onRecord: (record) => records.push(record) });
  await svn.open("/wc");
  assert.deepEqual(svn.conflicts.value.map((entry) => entry.path), ["b.ts", "dir"]);
  assert.deepEqual(svn.unversioned.value.map((entry) => entry.path), ["new.txt"]);
  assert.deepEqual(svn.checkedPaths.value, ["a.ts"], "unversioned files and conflicts start unchecked");

  svn.select("new.txt");
  await settle();
  assert.deepEqual(svn.state.diff.hunks[0].lines.map((line) => [line.kind, line.text]), [["added", "hello"], ["added", "world"]]);
  svn.select("dir");
  await settle();
  assert.equal(svn.state.diff.folder, true);

  svn.state.message = "fix";
  assert.equal(await svn.commit(), null);
  assert.equal(svn.state.notice.tone, "danger");
  assert.equal(svnErrorCode(svn.state.notice.error), "outOfDate");
  assert.deepEqual([records.at(-1).kind, records.at(-1).outcome], ["commit", "failed"]);
  assert.equal(svn.state.message, "fix", "a failed commit keeps the message");

  source.info = async () => {
    throw new Error("notWorkingCopy: svn: E155007: '/nope' is not a working copy");
  };
  assert.equal(await svn.open("/nope"), false);
  assert.equal(svnErrorCode(svn.state.error), "notWorkingCopy");
  assert.deepEqual(svn.state.entries, []);
});

test("what can be committed, reverted or needs resolving", () => {
  assert.equal(canCommit({ item: "normal", props: "modified" }), true);
  assert.equal(canCommit({ item: "conflicted", props: "none" }), false);
  assert.equal(canRevert({ item: "unversioned", props: "none" }), false);
  assert.equal(canRevert({ item: "missing", props: "none" }), true);
  assert.equal(isConflict({ item: "normal", props: "none", treeConflict: true }), true);
  assert.equal(svnErrorCode("plain text"), "failed");
  assert.equal(svnErrorDetail("auth: svn: E215004: No more credentials"), "svn: E215004: No more credentials");
});
