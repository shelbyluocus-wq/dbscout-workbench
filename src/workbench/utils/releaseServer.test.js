import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAINTENANCE_STAGES,
  SERVER_PHASES,
  formatCountdown,
  localInputTime,
  onlinePlayers,
  serverPhase,
  stageIndex,
  suggestedWindow,
  toLocalInput,
} from "./releaseServer.js";

function tasks(statuses) {
  return Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }]));
}

test("the server phase follows the GM tasks from schedule to reopening", () => {
  const steps = [
    [{}, "running"],
    [{ "gm.maintenance": "done" }, "scheduled"],
    [{ "gm.maintenance": "done", "gm.shutdown": "running" }, "closing"],
    [{ "gm.maintenance": "done", "gm.shutdown": "done" }, "maintenance"],
    [{ "gm.maintenance": "done", "gm.shutdown": "done", "gm.restart": "running" }, "restarting"],
    [{ "gm.maintenance": "done", "gm.shutdown": "done", "gm.restart": "done" }, "readyToOpen"],
    [{ "gm.maintenance": "done", "gm.shutdown": "done", "gm.restart": "done", "gm.open": "running" }, "opening"],
    [{ "gm.maintenance": "done", "gm.shutdown": "done", "gm.restart": "done", "gm.open": "done" }, "restored"],
  ];
  assert.deepEqual(steps.map(([, phase]) => phase), [...SERVER_PHASES]);
  for (const [statuses, phase] of steps) assert.equal(serverPhase(tasks(statuses)), phase, phase);
  // A failed shutdown leaves the servers waiting for it.
  assert.equal(serverPhase(tasks({ "gm.maintenance": "done", "gm.shutdown": "failed" })), "scheduled");
});

test("every phase belongs to exactly one visible stage", () => {
  for (const phase of SERVER_PHASES) {
    assert.equal(MAINTENANCE_STAGES.filter((stage) => stage.phases.includes(phase)).length, 1, phase);
  }
  assert.equal(stageIndex("running"), 0);
  assert.equal(stageIndex("restarting"), stageIndex("maintenance"));
  assert.equal(stageIndex("restored"), MAINTENANCE_STAGES.length - 1);
});

test("players leave when the servers close and return after they open", () => {
  const base = 1284;
  const now = Date.UTC(2026, 9, 24, 2, 0);
  const running = onlinePlayers("running", { now, base });
  assert.ok(Math.abs(running - base) <= 18);
  assert.equal(onlinePlayers("maintenance", { now, base }), 0);
  assert.equal(onlinePlayers("restored", { now, openedAt: now, base }), 0);
  assert.equal(onlinePlayers("restored", { now: now + 10000, openedAt: now, base }), 230);
  assert.equal(onlinePlayers("restored", { now: now + 3600000, openedAt: now, base }), base);
});

test("schedule inputs convert to and from local time", () => {
  const time = localInputTime("2026-10-24T10:05");
  assert.equal(time, new Date(2026, 9, 24, 10, 5).getTime());
  assert.equal(toLocalInput(time), "2026-10-24T10:05");
  assert.ok(Number.isNaN(localInputTime("10:05")));
  // A quarter of an hour ahead on a five-minute mark, for two hours.
  assert.deepEqual(suggestedWindow(new Date(2026, 9, 24, 10, 32, 40).getTime()), {
    start: "2026-10-24T10:50",
    end: "2026-10-24T12:50",
  });
});

test("countdowns show hours only when needed and never go negative", () => {
  assert.equal(formatCountdown(4 * 60000 + 9000), "04:09");
  assert.equal(formatCountdown(3600000 + 4 * 60000 + 9000), "01:04:09");
  assert.equal(formatCountdown(1), "00:01");
  assert.equal(formatCountdown(-5000), "00:00");
});
