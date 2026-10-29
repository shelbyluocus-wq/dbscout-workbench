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
  DEMO_BUILD_OUTPUT,
  DEMO_COCOS_FAILURE_LOG,
  DEMO_COCOS_LOG,
  DEMO_GM,
  DEMO_HOT_UPDATE,
  DEMO_HOT_UPDATE_BYTES,
  DEMO_PROPS_COUNT,
  DEMO_QA_MARKERS,
  DEMO_REVISION,
  DEMO_SERVERS,
  DEMO_SVN_UPDATES,
  DEMO_TRANSFER_SCRIPT,
  DEMO_TRANSFER_SHEETS,
  DEMO_WORKSPACE,
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

function chunks(list, size) {
  const result = [];
  for (let index = 0; index < list.length; index += size) result.push(list.slice(index, index + size));
  return result;
}

async function steps(io, lines, totalMs, { from = 0, to = 1, tone = "" } = {}) {
  const pause = lines.length ? totalMs / lines.length : 0;
  for (const [index, line] of lines.entries()) {
    await io.wait(pause);
    io.log(line, tone);
    io.progress(from + ((to - from) * (index + 1)) / lines.length);
  }
}

// The overwrite backs the platform database up first and never overwrites
// without that backup; the backup is what a restore returns to.
async function syncDatabase(context, io) {
  const { platform, syncPlan, now } = context;
  const at = now();
  const snapshot = joinWindowsPath("snapshots", platform.targetDatabase, `${timestamp(at).replace(/[ -]/g, "")}.sql`);
  io.log(`preflight ${platform.sourceDatabase} → ${platform.targetDatabase}: ${syncPlan.tables.length} tables, ${syncPlan.excluded.length} kept`);
  await io.wait(500);
  io.log(`backup ${platform.targetDatabase} → ${snapshot}`);
  io.progress(0.04);
  await io.wait(600);
  const backupTables = syncPlan.catalog.length;
  const backupRows = syncPlan.rows + 1820;
  io.log(`backup done · ${backupTables} tables, ${backupRows.toLocaleString("en-US")} rows`, "success");
  io.progress(0.08);
  await io.wait(300);
  await steps(
    io,
    chunks(syncPlan.tables, 12).map((batch) => `copy ${batch.map((table) => table.name).join(", ")}`),
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
    backup: {
      id: `backup-${at.getTime().toString(36)}`,
      at: at.toISOString(),
      database: platform.targetDatabase,
      tables: backupTables,
      rows: backupRows,
      path: snapshot,
      simulated: true,
    },
  };
}

async function restoreDatabase(context, io) {
  const { backup, platform } = context;
  if (!backup?.id) throw new ReleaseTaskError("noBackup");
  io.log(`restore ${platform.targetDatabase} ← ${backup.path}`);
  await steps(io, [
    `lock ${platform.targetDatabase}`,
    `drop and reload ${backup.tables} tables`,
    `${backup.rows.toLocaleString("en-US")} rows loaded`,
  ], 2200, { to: 0.9 });
  await io.wait(300);
  io.log(`verify ${backup.tables} tables against the backup: match`, "success");
  io.progress(1);
  return { backup, tables: backup.tables };
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
  // The demo can leave two files out, as when the development client misses them.
  const missingFiles = context.demo.missingFiles ? files.copy.slice(-2) : [];
  for (const entry of missingFiles) io.log(`missing in ${platform.sourceClient}: ${entry.path} (skipped)`, "warning");
  io.log(`${files.copy.length - missingFiles.length} copied, ${files.remove.length} removed`, missingFiles.length ? "warning" : "success");
  io.progress(1);
  const copied = files.copy.filter((entry) => !missingFiles.includes(entry));
  const count = (status) => copied.filter((entry) => entry.status === status).length;
  return {
    added: count("A"),
    modified: count("M"),
    deleted: files.remove.length,
    excluded: files.excluded.length,
    warnings: missingFiles.map((entry) => ({ code: "missing", path: entry.path })),
  };
}

async function runTransfer(context, io) {
  const { platform, template, now } = context;
  const script = template?.scriptPath || DEMO_TRANSFER_SCRIPT;
  const output = joinWindowsPath(DEMO_WORKSPACE, "tool\\生成配置\\output", platform.targetDatabase, timestamp(now()));
  io.log(`> "${script}"`);
  await steps(io, [
    ...DEMO_TRANSFER_SHEETS.map((sheet) => `export ${sheet} → props/${sheet}.json … ok`),
    `export ${DEMO_PROPS_COUNT - DEMO_TRANSFER_SHEETS.length} more sheets … ok`,
    "write src/props/propDataDefine.ts, propKeyFile.ts, propLstFile.ts",
  ], 2600, { to: 0.7 });
  await io.wait(400);
  io.log(`output package: ${output}`);
  io.progress(0.8);
  await io.wait(600);
  const copiedFiles = DEMO_PROPS_COUNT + 3;
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
  const output = joinWindowsPath(platform.targetClient, DEMO_BUILD_OUTPUT);
  io.log(`> ${cocos.command.display}`);
  const fill = (line) => line.replace("{version}", platform.cocosVersion).replace("{project}", platform.targetClient);
  if (demo.buildFailure && attempt === 1) {
    await steps(io, DEMO_COCOS_LOG.slice(0, 7).map(([line]) => fill(line)), 2400, { to: 0.5 });
    for (const line of DEMO_COCOS_FAILURE_LOG) io.log(line, "error");
    throw new ReleaseTaskError("buildFailed", "Cocos build failed", { exitCode: 34 });
  }
  const pause = 4200 / DEMO_COCOS_LOG.length;
  for (const [line, progress] of DEMO_COCOS_LOG) {
    await io.wait(pause);
    io.log(fill(line));
    io.progress(progress);
  }
  io.log("exit code 36", "success");
  // The client's own release guard: the build must not ship QA tooling.
  io.log(`> npm run qa:release -- "${joinWindowsPath(output, "data")}"`);
  await io.wait(700);
  io.log(`{ "checked": 1286, "findings": [] }  · no ${DEMO_QA_MARKERS.join(", ")} …`, "success");
  io.progress(0.97);
  await io.wait(400);
  io.log(`hot update ${DEMO_HOT_UPDATE.next}: project.manifest, version.manifest`, "success");
  io.progress(1);
  return {
    exitCode: 36,
    outputDir: output,
    sizeBytes: DEMO_HOT_UPDATE_BYTES,
    files: 9630,
    qaChecked: 1286,
    qaFindings: 0,
    hotUpdate: DEMO_HOT_UPDATE.next,
  };
}

async function gmCall(io, lines, result, totalMs = 900) {
  io.log(lines[0]);
  await steps(io, lines.slice(1), totalMs);
  return result;
}

function gmTasks(context) {
  const { schedule, results, gmFiles, platform, syncPlan, demo, attempt } = context;
  const build = results["build.cocos"] || {};
  const pack = results["gm.configPack"] || {};
  const servers = DEMO_SERVERS.count;
  const at = () => new Date(context.serverNow()).toISOString();
  const gm = `${platform.name} GM`;
  return {
    // The company GM packs the relay database its own platform settings name;
    // the step says when that is not the database this update wrote.
    "gm.configPack": (io) => gmCall(io, [
      `company GM: pack source for ${platform.name} = ${platform.targetDatabase} (matches the platform database)`,
      `export ${syncPlan.catalog.length} tables → gzip snapshot ${(DEMO_GM.configBytes / 1048576).toFixed(1)} MB, sha256 9f3c…e21a`,
      `sftp to ${gm} … 100%`,
      `${gm}: size and sha256 match · config version #${DEMO_GM.configVersion} registered`,
    ], { version: DEMO_GM.configVersion, tables: syncPlan.catalog.length, sizeBytes: DEMO_GM.configBytes, source: platform.targetDatabase }, 1400),
    "gm.activityUpload": (io) => gmCall(io, [
      `upload ${gmFiles.activity} (182 KB)`,
      `Activebaseprop row 1 names platform ${platform.name}`,
      `activity version #${DEMO_GM.activityVersion} created`,
    ], { file: gmFiles.activity, version: DEMO_GM.activityVersion }),
    "gm.activityCurrent": (io) => gmCall(io, [
      `next activity version #${DEMO_GM.activityVersion} from ${context.brief.date}`,
      "ok",
    ], { version: DEMO_GM.activityVersion, date: context.brief.date }),
    "gm.activityReload": (io) => gmCall(io, [
      `reload CActivityPropMgr on ${servers} game servers`,
      `${servers} / ${servers} reloaded · 12 activities`,
    ], { activities: 12, servers }, 1200),
    "gm.clientUpload": async (io) => {
      // A real build reports no package size; the simulated upload uses its own.
      const sizeBytes = build.sizeBytes || DEMO_HOT_UPDATE_BYTES;
      io.log(`upload ${gmFiles.client} (${(sizeBytes / 1048576).toFixed(1)} MB) → company GM test folder`);
      for (let percent = 10; percent <= 100; percent += 10) {
        await io.wait(320);
        io.progress(percent / 100);
        // The demo can drop the connection once, half-way through.
        if (demo.gmNetwork && attempt === 1 && percent === 50) {
          io.log("connection to the company GM lost at 50%", "error");
          throw new ReleaseTaskError("gmNetwork");
        }
      }
      io.log(`company GM saved it · hot update ${gmFiles.clientVersion} waiting to be confirmed`, "success");
      return { file: gmFiles.client, sizeBytes, version: gmFiles.clientVersion };
    },
    "gm.clientPull": (io) => gmCall(io, [
      `company GM: /clihotupdate4test/${platform.id}/${gmFiles.client}`,
      `${((build.sizeBytes || DEMO_HOT_UPDATE_BYTES) / 1048576).toFixed(1)} MB, size matches · confirmed`,
    ], { file: gmFiles.client, version: gmFiles.clientVersion }),
    "gm.clientPush": (io) => gmCall(io, [
      `${gm}: fetch hot update ${gmFiles.clientVersion} from the company GM`,
      `written to gmhot/${platform.id}/ · synced`,
    ], { version: gmFiles.clientVersion }, 1200),
    "gm.serverBuild": (io) => gmCall(io, [
      `company GM: svn update the ${platform.name} server branch → r${DEMO_GM.serverRevision}`,
      "npm run dist … ok",
      "node encservl.js … ok",
      `zip ${gmFiles.server} (${(DEMO_GM.serverBytes / 1048576).toFixed(1)} MB) · server version #${DEMO_GM.serverVersion}`,
    ], { file: gmFiles.server, version: DEMO_GM.serverVersion, revision: DEMO_GM.serverRevision }, 2400),
    "gm.serverPush": (io) => gmCall(io, [
      `sftp ${gmFiles.server} to ${gm}`,
      "uploading … 100%",
      `${gm}: size, sha256, platform and version match · server #${DEMO_GM.serverVersion} registered`,
    ], { version: DEMO_GM.serverVersion }, 1600),
    "gm.maintenance": (io) => gmCall(io, [
      `maintenance checklist: ${DEMO_GM.checklist} / ${DEMO_GM.checklist} done`,
      `pre-maintenance ${schedule.maintenanceStart} → ${schedule.maintenanceEnd}, players warned 5 minutes before`,
      `monitors on ${servers} hosts notified`,
    ], { start: schedule.maintenanceStart, end: schedule.maintenanceEnd, checklist: DEMO_GM.checklist }),
    "gm.clientOpen": (io) => gmCall(io, [`set hot update ${gmFiles.clientVersion} open at ${schedule.clientOpenAt}`, "ok"], { at: schedule.clientOpenAt, version: gmFiles.clientVersion }),
    // The monitors close the servers at the pre-maintenance time; this step
    // only watches the zones until every one has stopped.
    "gm.shutdown": async (io) => {
      const stopped = demo.shutdownSlow && attempt === 1 ? servers - 1 : servers;
      await gmCall(io, [
        "pre-maintenance time reached; the monitors close the servers",
        "players warned and disconnected",
        `zone status: ${stopped} / ${servers} stopped`,
      ], null, 2600);
      if (stopped < servers) {
        io.log(`${servers - stopped} server still running after the wait`, "warning");
        throw new ReleaseTaskError("shutdownIncomplete");
      }
      io.log("every zone in maintenance", "success");
      return { players: DEMO_SERVERS.online, at: at() };
    },
    "gm.serverApply": (io) => gmCall(io, [
      `apply server #${DEMO_GM.serverVersion} to ${servers} hosts (copy only, no restart)`,
      `${servers} / ${servers} copied`,
    ], { version: DEMO_GM.serverVersion, hosts: servers }, 1400),
    "gm.configApply": (io) => gmCall(io, [
      `preview: config version #${pack.version || DEMO_GM.configVersion} replaces ${pack.tables || syncPlan.catalog.length} tables of the zones' config database`,
      "import into an isolated database … ok",
      "table list matches the version",
      `switched with one RENAME · previous tables kept in gm_cfg_backup_${context.runId.slice(-4)}`,
    ], { version: pack.version || DEMO_GM.configVersion, tables: pack.tables || syncPlan.catalog.length, backup: `gm_cfg_backup_${context.runId.slice(-4)}` }, 1800),
    "gm.configReload": (io) => gmCall(io, [
      `reload the config managers on ${servers} game servers`,
      `${servers} / ${servers} reloaded`,
    ], { servers }, 1200),
    "gm.restart": (io) => gmCall(io, [
      `start the zones in maintenance (closed to players)`,
      `heartbeat check: ${servers} / ${servers} healthy`,
    ], { servers, version: DEMO_GM.serverVersion }, 2600),
    "gm.open": (io) => gmCall(io, ["end maintenance, open the zones", `${servers} / ${servers} servers accept logins`], { at: at() }, 1100),
  };
}

const TASK_RUNNERS = Object.freeze({
  "db.sync": syncDatabase,
  "db.restore": restoreDatabase,
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
