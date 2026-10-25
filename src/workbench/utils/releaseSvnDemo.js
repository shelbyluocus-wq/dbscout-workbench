// The simulated working copy of an update's diff step: the platform client
// after the copy and the table conversion (DEMO_DIFF_FILES). Commit and revert
// only change what the update remembers (run.svnDemo); nothing touches a disk,
// a working copy or a server. The browser preview's mock backend serves the
// SVN tool from the same files.

import { DEMO_DIFF_FILES, DEMO_REVISION } from "./releaseFlowDemo.js";

const ITEMS = Object.freeze({ M: "modified", A: "added", D: "deleted" });

// Earlier commits of the release branch the log shows (simulated).
export const DEMO_SVN_LOG = Object.freeze([
  { revision: DEMO_REVISION, author: "release", date: "", message: "同步开发版本到平台客户端", paths: [{ action: "M", kind: "file", path: "/release/jswz/assets/props/props/heroprop.json" }] },
  { revision: DEMO_REVISION - 6, author: "release", date: "", message: "更新热更新清单", paths: [{ action: "M", kind: "file", path: "/release/jswz/assets/resources/version.manifest" }] },
  { revision: DEMO_REVISION - 21, author: "release", date: "", message: "合并 10/21 版本", paths: [{ action: "M", kind: "dir", path: "/release/jswz/assets" }] },
]);

export function demoUnifiedDiff(file) {
  if (!file || file.binary) return "";
  return [
    `Index: ${file.path}`,
    "===================================================================",
    `--- ${file.path}\t(revision ${DEMO_REVISION})`,
    `+++ ${file.path}\t(working copy)`,
    ...file.lines,
  ].join("\n");
}

export function demoStatusEntry(file) {
  return { path: file.path, item: ITEMS[file.status] || "modified", props: "none", kind: "file", treeConflict: false, locked: false };
}

function daysAgo(now, days) {
  return new Date(now - days * 86400000).toISOString();
}

/**
 * A source for useSvnWorkspace over the demo files. `memory` is the update's
 * svnDemo record; `wait` lets tests skip the pauses.
 */
export function createDemoSvnSource({ memory, platformId = () => "", files = DEMO_DIFF_FILES, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const settled = () => new Set([...memory.committed, ...memory.reverted]);
  const pending = () => files.filter((file) => !settled().has(file.path));
  return {
    kind: "demo",
    async info(root) {
      const url = `^/release/${platformId()}/jswz`;
      return { root, url, relativeUrl: url, repositoryRoot: "", revision: DEMO_REVISION + memory.revision, simulated: true };
    },
    async status() {
      return pending().map(demoStatusEntry);
    },
    async fileDiff(root, path) {
      const file = files.find((entry) => entry.path === path);
      return { path, diff: demoUnifiedDiff(file), content: null, binary: Boolean(file?.binary), tooLarge: false, encoding: "utf-8" };
    },
    async commit(root, paths, message) {
      await wait(500);
      memory.revision += 1;
      const revision = DEMO_REVISION + memory.revision;
      memory.committed.push(...paths);
      memory.commits = [{ revision, message, paths: [...paths], at: now() }, ...(memory.commits || [])].slice(0, 20);
      return { revision, added: [], deleted: [], output: "", simulated: true };
    },
    async revert(root, paths) {
      await wait(300);
      memory.reverted.push(...paths);
      return { paths, output: "", simulated: true };
    },
    async resolve(root, paths) {
      return { paths, output: "", simulated: true };
    },
    async log() {
      const time = now();
      const own = (memory.commits || []).map((commit) => ({
        revision: commit.revision,
        author: "blackcat",
        date: new Date(commit.at).toISOString(),
        message: commit.message,
        paths: commit.paths.map((path) => ({ action: "M", kind: "file", path: `/release/jswz/${path}` })),
      }));
      return [...own, ...DEMO_SVN_LOG.map((entry, index) => ({ ...entry, date: daysAgo(time, [1, 4, 9][index] || 12) }))];
    },
    async pickFolder() {
      return null;
    },
  };
}
