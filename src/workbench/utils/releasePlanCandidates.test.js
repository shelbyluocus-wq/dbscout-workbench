import assert from "node:assert/strict";
import { test } from "node:test";
import { t } from "../i18n/index.js";
import { useReleaseWorkspace } from "../composables/useReleaseWorkspace.js";
import {
  buildPlanNameOptions,
  buildPlanRefOptions,
  classifyHeropropCategory,
  mergePlanCandidates,
} from "./releasePlanCandidates.js";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("classifyHeropropCategory partitions heroprop IDs into hero, pet, spirit, and mount", () => {
  assert.equal(classifyHeropropCategory(1065), "hero");
  assert.equal(classifyHeropropCategory(5408), "pet");
  assert.equal(classifyHeropropCategory(5513), "spirit");
  assert.equal(classifyHeropropCategory(6518), "mount");
  assert.equal(classifyHeropropCategory(99), null);
});

test("mergePlanCandidates prioritizes closed DB rows and filters heroprop by category range", () => {
  const dbRows = [
    { keys: [1001], name: "圣堂骑士", flag: 1 },
    { keys: [1065], name: "永夜魅影", flag: 0 },
    { keys: [6518], name: "霜狼战骑", flag: 0 },
  ];
  const heroes = mergePlanCandidates({ category: "hero", dbRows, memoItems: [], builtinItems: [] });
  assert.deepEqual(
    heroes.map((item) => ({ name: item.name, ref: item.ref, flag: item.flag })),
    [
      { name: "永夜魅影", ref: "1065", flag: 0 },
      { name: "圣堂骑士", ref: "1001", flag: 1 },
    ],
  );

  const mounts = mergePlanCandidates({ category: "mount", dbRows, memoItems: [], builtinItems: [] });
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].name, "霜狼战骑");
  assert.equal(mounts[0].ref, "6518");

  const nameOpts = buildPlanNameOptions(heroes, t);
  assert.equal(nameOpts[0].value, "永夜魅影");
  assert.match(nameOpts[0].detail, /1065/);
  const refOpts = buildPlanRefOptions(heroes, t);
  assert.equal(refOpts[0].value, "1065");
  assert.match(refOpts[0].detail, /永夜魅影/);
});

test("useReleaseWorkspace removePlanEntries batch-deletes multiple plans and loadPlanCandidates queries DB", async () => {
  const calls = [];
  const workspace = useReleaseWorkspace({
    storage: memoryStorage(),
    realMode: true,
    seed: false,
    ticker: () => () => {},
    connections: () => [{ id: "conn-243", kind: "mysql", host: "192.168.1.243", port: 8306 }],
    databasesByConnection: () => ({ "conn-243": ["newsg_4cfg", "newsg_249"] }),
    invoke: async (cmd, payload) => {
      calls.push({ cmd, payload });
      return {
        tableFound: true,
        rows: [
          { keys: [3, 1], name: "熔炼工坊", flag: 0 },
          { keys: [8, 2], name: "圣物共鸣", flag: 1 },
        ],
      };
    },
  });

  try {
    const a = workspace.addPlanEntry({ name: "英雄A", category: "hero", ref: "1081", notes: { douyin: "10/28 开放" } });
    const b = workspace.addPlanEntry({ name: "英雄B", category: "hero", ref: "1082", notes: { tap: "已开放" } });
    const c = workspace.addPlanEntry({ name: "英雄C", category: "hero", ref: "1083", notes: {} });

    const beforeCount = workspace.state.plans.items.length;
    const removed = workspace.removePlanEntries([a.id, c.id, "missing-id"]);
    assert.equal(removed, 2);
    assert.equal(workspace.state.plans.items.length, beforeCount - 2);
    assert.ok(workspace.state.plans.items.some((entry) => entry.id === b.id));
    assert.ok(!workspace.state.plans.items.some((entry) => entry.id === a.id || entry.id === c.id));

    const featureCandidates = await workspace.loadPlanCandidates("feature");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "release_list_plan_candidates");
    assert.equal(calls[0].payload.connectionId, "conn-243");
    assert.equal(calls[0].payload.table, "buildopenplatprop");
    assert.equal(featureCandidates[0].name, "熔炼工坊");
    assert.equal(featureCandidates[0].ref, "3 · 1");

    // Second call for same table uses cache.
    await workspace.loadPlanCandidates("feature");
    assert.equal(calls.length, 1);
  } finally {
    workspace.dispose();
  }
});
