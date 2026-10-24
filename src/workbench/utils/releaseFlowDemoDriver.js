// The release flow runs every task through a driver:
//
//   driver.run(taskId, context, io) -> Promise<result>
//
// `context` carries the brief, the platform profile and the prepared input of
// the task (see useReleaseFlow). `io.log(text, tone)` appends a log line,
// `io.progress(fraction)` reports progress and `io.wait(ms)` pauses, rejecting
// once the run is cancelled. A failure rejects with an Error whose `code`
// names it. This demo driver only simulates: it touches no database, file,
// SVN working copy, Cocos editor or GM server. A real driver can replace it
// task by task with the same contract.

import {
  DEMO_COCOS_FAILURE_LOG,
  DEMO_COCOS_LOG,
  DEMO_REVISION,
  DEMO_SVN_UPDATES,
  DEMO_TRANSFER_SHEETS,
} from "./releaseFlowDemo.js";

export class ReleaseTaskError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

function timestamp(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function joinWindowsPath(...parts) {
  return parts.filter(Boolean).join("\\").replace(/\\{2,}/g, "\\");
}

async function steps(io, lines, totalMs, { from = 0, to = 1, tone = "" } = {}) {
  const pause = lines.length ? totalMs / lines.length : 0;
  for (const [index, line] of lines.entries()) {
    await io.wait(pause);
    io.log(line, tone);
    io.progress(from + ((to - from) * (index + 1)) / lines.length);
  }
}

async function syncDatabase(context, io) {
  const { platform, syncPlan, now } = context;
  const snapshot = joinWindowsPath("snapshots", platform.targetDatabase, `${timestamp(now()).replace(/[ -]/g, "")}.sql`);
  io.log(`preflight ${platform.sourceDatabase} → ${platform.targetDatabase}: ${syncPlan.tables.length} tables, ${syncPlan.excluded.length} excluded`);
  await io.wait(500);
  io.log(`snapshot ${platform.targetDatabase} → ${snapshot}`);
  io.progress(0.08);
  await io.wait(600);
  const batches = [];
  for (let index = 0; index < syncPlan.tables.length; index += 4) batches.push(syncPlan.tables.slice(index, index + 4));
  await steps(
    io,
    batches.map((batch) => `copy ${batch.map((table) => `${table.name} (${table.rows})`).join(", ")}`),
    2800,
    { from: 0.1, to: 0.9 },
  );
  await io.wait(400);
  io.log(`verify ${syncPlan.tables.length} tables: row counts and checksums match`, "success");
  io.progress(1);
  return {
    tables: syncPlan.tables.length,
    excluded: syncPlan.excluded.length,
    rows: syncPlan.tables.reduce((sum, table) => sum + table.rows, 0),
    snapshot,
  };
}

async function writePlans(context, io) {
  const { plan, platform } = context;
  if (!plan.statements.length) {
    await io.wait(400);
    io.log(`${platform.targetDatabase}: nothing to change`, "success");
    return { ...plan.counts, statements: 0 };
  }
  io.log(`begin transaction on ${platform.targetDatabase}`);
  await steps(io, plan.statements, 300 * plan.statements.length + 300);
  io.log(`commit · ${plan.counts.open + plan.counts.close} rows updated, audit recorded`, "success");
  return { ...plan.counts, statements: plan.statements.length };
}

async function updateSvn(context, io) {
  const { platform, demo } = context;
  io.log(`svn update "${platform.targetClient}"`);
  io.log(`Updating '${platform.targetClient}':`);
  const updates = DEMO_SVN_UPDATES.map((entry) => (demo.conflicts || entry.action !== "C" ? entry : { ...entry, action: "U" }));
  await steps(io, updates.map((entry) => `${entry.action}    ${entry.path}`), 2200, { to: 0.9 });
  await io.wait(300);
  const conflicts = updates.filter((entry) => entry.action === "C").map((entry) => entry.path);
  io.log(`Updated to revision ${DEMO_REVISION}.`);
  if (conflicts.length) {
    io.log("Summary of conflicts:", "warning");
    io.log(`  Text conflicts: ${conflicts.length}`, "warning");
  }
  io.progress(1);
  return { revision: DEMO_REVISION, updated: updates.length - conflicts.length, conflicts, resolved: 0 };
}

const ACCEPT_OPTIONS = Object.freeze({ theirs: "theirs-full", mine: "mine-full", manual: "working" });

async function resolveSvnConflicts(context, io) {
  const { conflicts, previous } = context;
  await steps(
    io,
    conflicts.flatMap((entry) => [
      `svn resolve --accept ${ACCEPT_OPTIONS[entry.choice]} "${entry.path}"`,
      `Resolved conflicted state of '${entry.path}'`,
    ]),
    350 * conflicts.length + 300,
  );
  io.log(`working copy at revision ${previous?.revision ?? DEMO_REVISION}, no conflicts left`, "success");
  return { ...previous, conflicts: previous?.conflicts || [], resolved: conflicts.length, choices: conflicts.map((entry) => entry.choice) };
}

async function syncFiles(context, io) {
  const { platform, files } = context;
  io.log(`copy ${platform.sourceClient} → ${platform.targetClient}`);
  io.log(`${files.excluded.length} files excluded by rules`);
  const actions = [
    ...files.copy.map((entry) => `${entry.status === "A" ? "add " : "copy"}  ${entry.path}`),
    ...files.remove.map((entry) => `del   ${entry.path}`),
  ];
  await steps(io, actions, 2600, { to: 0.96 });
  await io.wait(300);
  io.log(`${files.copy.length} copied, ${files.remove.length} removed`, "success");
  io.progress(1);
  const count = (status) => files.copy.filter((entry) => entry.status === status).length;
  return { added: count("A"), modified: count("M"), deleted: files.remove.length, excluded: files.excluded.length };
}

async function runTransfer(context, io) {
  const { platform, template, now } = context;
  const script = template?.scriptPath || `${template?.name || "conversion"}.bat`;
  const output = joinWindowsPath("D:\\Versions\\tools\\output", timestamp(now()));
  io.log(`> "${script}"`);
  await steps(io, DEMO_TRANSFER_SHEETS.map((sheet) => `export ${sheet}.xlsx → props/${sheet}.json … ok`), 2600, { to: 0.7 });
  await io.wait(400);
  io.log(`output package: ${output}`);
  io.progress(0.8);
  await io.wait(600);
  const copiedFiles = DEMO_TRANSFER_SHEETS.length * 2 + 22;
  io.log(`copy ${copiedFiles} files → ${joinWindowsPath(platform.targetClient, "assets")}`, "success");
  io.progress(1);
  return { template: template?.name || "", outputDir: output, copiedFiles };
}

async function confirmDiff(context, io) {
  const { diff } = context;
  await io.wait(300);
  io.log(`${diff.length} changed files reviewed`, "success");
  const count = (status) => diff.filter((file) => file.status === status).length;
  return { files: diff.length, modified: count("M"), added: count("A"), deleted: count("D") };
}

async function buildCocos(context, io) {
  const { platform, cocos, demo, attempt } = context;
  io.log(`> ${cocos.command.display}`);
  const fill = (line) => line
    .replace("{version}", platform.cocosVersion)
    .replace("{project}", platform.targetClient)
    .replace("{config}", platform.buildConfig);
  if (demo.buildFailure && attempt === 1) {
    await steps(io, DEMO_COCOS_LOG.slice(0, 8).map(([line]) => fill(line)), 2600, { to: 0.55 });
    for (const line of DEMO_COCOS_FAILURE_LOG.slice(1)) io.log(line, "error");
    throw new ReleaseTaskError("buildFailed", "Cocos build failed", { exitCode: 34 });
  }
  const pause = 4800 / DEMO_COCOS_LOG.length;
  for (const [line, progress] of DEMO_COCOS_LOG) {
    await io.wait(pause);
    io.log(fill(line), progress === 1 ? "success" : "");
    io.progress(progress);
  }
  io.log("exit code 36", "success");
  return {
    exitCode: 36,
    outputDir: joinWindowsPath(platform.targetClient, "build", platform.buildPlatform),
    sizeBytes: 33_974_272,
    files: 1286,
  };
}

async function gmCall(io, lines, result, totalMs = 900) {
  io.log(lines[0]);
  await steps(io, lines.slice(1), totalMs);
  return result;
}

function gmTasks(context) {
  const { schedule, results, gmFiles } = context;
  const { activity: activityFile, server: serverFile, client: clientFile, clientVersion } = gmFiles;
  const build = results["build.cocos"] || {};
  return {
    "gm.activityUpload": (io) => gmCall(io, [`upload ${activityFile} (182 KB)`, "uploaded · activity version #318"], { file: activityFile, version: 318 }),
    "gm.activityCurrent": (io) => gmCall(io, ["set current activity version #318", "ok"], { version: 318 }),
    "gm.activityReload": (io) => gmCall(io, ["reload activities on all game servers", "game-1 … ok", "game-2 … ok", "12 activities reloaded"], { activities: 12 }, 1400),
    "gm.clientUpload": async (io) => {
      io.log(`upload ${clientFile} (${((build.sizeBytes || 0) / 1048576).toFixed(1)} MB)`);
      for (let percent = 10; percent <= 100; percent += 10) {
        await io.wait(320);
        io.progress(percent / 100);
      }
      io.log(`uploaded · client version ${clientVersion}`, "success");
      return { file: clientFile, sizeBytes: build.sizeBytes || 0, version: clientVersion };
    },
    "gm.serverUpload": (io) => gmCall(io, [`upload ${serverFile} (48.2 MB)`, "uploading … 50%", "uploading … 100%", "uploaded · server version #207"], { file: serverFile, version: 207 }, 1800),
    "gm.serverCurrent": (io) => gmCall(io, ["set current server version #207", "ok · applies on next restart"], { version: 207 }),
    "gm.maintenance": (io) => gmCall(io, [`schedule maintenance ${schedule.maintenanceStart} → ${schedule.maintenanceEnd}`, "ok"], { start: schedule.maintenanceStart, end: schedule.maintenanceEnd }),
    "gm.clientOpen": (io) => gmCall(io, [`schedule client update ${clientVersion} at ${schedule.clientOpenAt}`, "ok"], { at: schedule.clientOpenAt, version: clientVersion }),
    "gm.restart": (io) => gmCall(io, [
      "compile server #207",
      "compile ok · 0 warnings",
      "stop game-1 … game-4",
      "start game-1 … game-4",
      "load activity version #318",
      "4 / 4 servers healthy",
    ], { servers: 4, version: 207 }, 4200),
    "gm.open": (io) => gmCall(io, ["end maintenance and open servers", "4 / 4 servers accept logins"], { at: context.now().toISOString() }, 1100),
  };
}

const TASK_RUNNERS = Object.freeze({
  "db.sync": syncDatabase,
  "db.plans": writePlans,
  "client.svn": updateSvn,
  "client.svnResolve": resolveSvnConflicts,
  "client.sync": syncFiles,
  "client.transfer": runTransfer,
  "client.diff": confirmDiff,
  "build.cocos": buildCocos,
});

export function createReleaseDemoDriver() {
  return {
    demo: true,
    async run(taskId, context, io) {
      const runner = TASK_RUNNERS[taskId];
      if (runner) return runner(context, io);
      const gm = gmTasks(context)[taskId];
      if (gm) return gm(io);
      throw new ReleaseTaskError("unknownTask", `Unknown task ${taskId}`);
    },
  };
}
