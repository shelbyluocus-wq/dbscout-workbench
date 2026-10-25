// Server state during a maintenance release, derived from the GM tasks and the
// server clock: running → scheduled → closing → maintenance → (restarting) →
// ready to open → opening → restored.

export const SERVER_PHASES = Object.freeze([
  "running", "scheduled", "closing", "maintenance", "restarting", "readyToOpen", "opening", "restored",
]);

/** The visible stages of a maintenance and the phases each one covers. */
export const MAINTENANCE_STAGES = Object.freeze([
  Object.freeze({ id: "schedule", phases: Object.freeze(["running"]) }),
  Object.freeze({ id: "wait", phases: Object.freeze(["scheduled"]) }),
  Object.freeze({ id: "close", phases: Object.freeze(["closing"]) }),
  Object.freeze({ id: "work", phases: Object.freeze(["maintenance", "restarting"]) }),
  Object.freeze({ id: "open", phases: Object.freeze(["readyToOpen", "opening"]) }),
  Object.freeze({ id: "live", phases: Object.freeze(["restored"]) }),
]);

export function serverPhase(tasks) {
  const status = (id) => tasks?.[id]?.status || "idle";
  if (status("gm.open") === "done") return "restored";
  if (status("gm.open") === "running") return "opening";
  if (status("gm.restart") === "running") return "restarting";
  if (status("gm.shutdown") === "done") return status("gm.restart") === "done" ? "readyToOpen" : "maintenance";
  if (status("gm.shutdown") === "running") return "closing";
  if (status("gm.maintenance") === "done") return "scheduled";
  return "running";
}

export function stageIndex(phase) {
  return Math.max(0, MAINTENANCE_STAGES.findIndex((stage) => stage.phases.includes(phase)));
}

/** "running" players are steady, a reopened server fills up again. */
export function onlinePlayers(phase, { now, openedAt = 0, base }) {
  if (phase === "running" || phase === "scheduled") return base + Math.round(Math.sin(now / 47000) * 18);
  if (phase !== "restored" || !openedAt) return 0;
  return Math.min(base, Math.floor(Math.max(0, now - openedAt) / 1000) * 23);
}

/** A datetime-local value ("2026-10-24T10:00") as epoch milliseconds. */
export function localInputTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute).getTime();
}

export function toLocalInput(time) {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Start a quarter of an hour from now on a five-minute mark, for two hours. */
export function suggestedWindow(now) {
  const step = 5 * 60000;
  const start = Math.ceil((now + 15 * 60000) / step) * step;
  return { start: toLocalInput(start), end: toLocalInput(start + 2 * 3600000) };
}

/** "01:04:09" or "04:09" for a span in milliseconds. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
