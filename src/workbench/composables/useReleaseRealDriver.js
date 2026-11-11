import { invokeWorkbench, listenWorkbenchEvent } from "../utils/tauriBridge.js";
import { connectionHasCapability } from "../utils/connectionKinds.js";
import { isRealConnection } from "../utils/connectionDisplay.js";
import { ReleaseTaskError } from "../utils/releaseFlowDemoDriver.js";

export const REAL_TASK_IDS = Object.freeze(new Set([
  "db.sync",
  "db.restore",
  "db.plans",
  "client.svn",
  "client.svnResolve",
  "client.sync",
  "client.transfer",
  "client.diff",
]));

const ACCEPT_BY_CHOICE = Object.freeze({
  theirs: "theirs-full",
  mine: "mine-full",
  manual: "working",
});

function defaultJobId(prefix = "release") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorDetail(error) {
  if (typeof error === "string") return error.trim();
  if (typeof error?.message === "string") return error.message.trim();
  return String(error ?? "").trim();
}

function isCancelledMessage(message) {
  return /^(cancelled|canceled)\b|已取消|已停止/iu.test(String(message || "").trim());
}

export function isSyncCapableConnection(connection) {
  return Boolean(
    connection?.id
      && isRealConnection(connection)
      && connectionHasCapability(connection.kind, "sync")
      && !connection.readOnly
      && !connection.read_only,
  );
}

function normalizedDbSet(databasesByConnection, connectionId) {
  const list = databasesByConnection?.[connectionId];
  if (!Array.isArray(list)) return new Set();
  return new Set(list.map((name) => String(name || "").trim().toLowerCase()).filter(Boolean));
}

function databaseFamily(databaseName) {
  const lower = String(databaseName || "").trim().toLowerCase();
  if (lower.startsWith("newsg_")) return "newsg";
  if (lower.startsWith("edota_")) return "edota";
  return "";
}

function setMatchesFamily(dbSet, family) {
  if (!family || !dbSet.size) return false;
  if (family === "newsg") {
    if (dbSet.has("newsg_4cfg")) return true;
    return [...dbSet].filter((name) => name.startsWith("newsg_")).length >= 2;
  }
  if (family === "edota") {
    if (dbSet.has("edota_3cfg")) return true;
    return [...dbSet].filter((name) => name.startsWith("edota_")).length >= 2;
  }
  return false;
}

/**
 * Resolves the writable MySQL connection for a release platform:
 * 1. Explicit `platform.connectionId` if valid and sync-capable.
 * 2. Connection containing both `sourceDatabase` and `targetDatabase`.
 * 3. Connection containing `sourceDatabase`, then `targetDatabase`.
 * 4. Connection matching the database family (`newsg_*` vs `edota_*`).
 * 5. Sole writable MySQL connection only when its loaded schema does not belong
 *    to another game family.
 */
export function resolvePlatformConnection(platform, connections = [], databasesByConnection = {}) {
  const writable = (Array.isArray(connections) ? connections : []).filter(isSyncCapableConnection);
  if (!writable.length) return null;

  const explicitId = String(platform?.connectionId || "").trim();
  if (explicitId) {
    const explicit = writable.find((connection) => String(connection.id) === explicitId);
    if (explicit) return explicit;
  }

  const srcDb = String(platform?.sourceDatabase || "").trim().toLowerCase();
  const dstDb = String(platform?.targetDatabase || "").trim().toLowerCase();

  if (srcDb && dstDb) {
    const both = writable.find((connection) => {
      const dbs = normalizedDbSet(databasesByConnection, connection.id);
      return dbs.has(srcDb) && dbs.has(dstDb);
    });
    if (both) return both;
  }

  if (srcDb) {
    const withSource = writable.find((connection) => normalizedDbSet(databasesByConnection, connection.id).has(srcDb));
    if (withSource) return withSource;
  }

  if (dstDb) {
    const withTarget = writable.find((connection) => normalizedDbSet(databasesByConnection, connection.id).has(dstDb));
    if (withTarget) return withTarget;
  }

  const family = databaseFamily(srcDb) || databaseFamily(dstDb);
  if (family) {
    const byFamily = writable.find((connection) => setMatchesFamily(normalizedDbSet(databasesByConnection, connection.id), family));
    if (byFamily) return byFamily;
  }

  if (writable.length === 1) {
    const sole = writable[0];
    const dbs = normalizedDbSet(databasesByConnection, sole.id);
    if (!dbs.size || !family) return sole;
    const oppositeFamily = family === "newsg" ? "edota" : "newsg";
    if (!setMatchesFamily(dbs, oppositeFamily)) return sole;
  }

  return null;
}

function requireConnectionId(context) {
  const connectionId = String(context?.connectionId || context?.platform?.connectionId || "").trim();
  if (!connectionId) {
    throw new ReleaseTaskError("missingConnection", "missingConnection");
  }
  return connectionId;
}

function rethrowTaskError(error, io, signal) {
  if (signal?.aborted || error?.code === "cancelled") {
    throw new ReleaseTaskError("cancelled", "cancelled");
  }
  if (error instanceof ReleaseTaskError) {
    throw error;
  }
  const detail = errorDetail(error);
  if (isCancelledMessage(detail)) {
    throw new ReleaseTaskError("cancelled", "cancelled");
  }
  if (detail) io.log(detail, "error");
  throw new ReleaseTaskError(detail || "failed", detail || "failed");
}

function hasSvnConflictEntry(entry) {
  return Boolean(entry?.item === "conflicted" || entry?.props === "conflicted" || entry?.treeConflict);
}

export function createReleaseRealDriver({
  invoke = invokeWorkbench,
  listen = listenWorkbenchEvent,
  createJobId = defaultJobId,
} = {}) {
  async function syncDatabase(context, io) {
    const connectionId = requireConnectionId(context);
    const sourceDatabase = String(context?.platform?.sourceDatabase || "").trim();
    const targetDatabase = String(context?.platform?.targetDatabase || "").trim();
    if (!sourceDatabase || !targetDatabase || sourceDatabase.toLowerCase() === targetDatabase.toLowerCase()) {
      throw new ReleaseTaskError("invalidSyncDatabases", "invalidSyncDatabases");
    }
    const excludedTables = Array.isArray(context?.syncPlan?.excluded) ? context.syncPlan.excluded : [];
    const jobId = createJobId("release-db-sync");
    let lastStageKey = "";
    let unlisten = null;
    const onAbort = () => {
      void invoke("cancel_database_sync", { jobId }).catch(() => {});
    };
    io.signal?.addEventListener("abort", onAbort, { once: true });
    io.log(`sync ${sourceDatabase} → ${targetDatabase} (${excludedTables.length} kept)`);

    try {
      if (listen) {
        unlisten = await listen("database-sync-progress", (event) => {
          const payload = event?.payload || event || {};
          if (String(payload.jobId || payload.job_id || "") !== jobId) return;
          const total = Number(payload.totalTables ?? payload.total_tables ?? payload.total ?? 0);
          const done = Number(payload.completedTables ?? payload.completed_tables ?? payload.done ?? 0);
          if (total > 0) io.progress(Math.min(0.96, done / total));
          const stage = String(payload.stage || "");
          const table = String(payload.currentTable || payload.current_table || "");
          const message = String(payload.message || "").trim();
          const stageKey = `${stage}:${table}:${message}`;
          if (message && stageKey !== lastStageKey) {
            lastStageKey = stageKey;
            io.log(message);
          }
        });
      }

      const response = await invoke("sync_database_overwrite", {
        request: {
          jobId,
          connectionId,
          sourceDatabase,
          targetDatabase,
          excludedTables,
        },
      });

      const status = String(response?.status || "").toLowerCase();
      if (status.startsWith("cancel") || io.signal?.aborted) {
        throw new ReleaseTaskError("cancelled", "cancelled");
      }
      if (status === "failed") {
        const message = String(response?.message || "Database overwrite sync failed").trim();
        io.log(message, "error");
        throw new ReleaseTaskError(message, message);
      }

      const copiedTables = Array.isArray(response?.copiedTables) ? response.copiedTables : [];
      const droppedTables = Array.isArray(response?.droppedTables) ? response.droppedTables : [];
      const copiedRows = Number(response?.copiedRows ?? 0);
      const snapshotPath = String(response?.backupSnapshotPath || "").trim();
      for (const warning of Array.isArray(response?.warnings) ? response.warnings : []) {
        io.log(String(warning), "warning");
      }
      if (response?.message) io.log(String(response.message), "success");
      io.progress(1);

      let backup = null;
      if (snapshotPath) {
        let matched = null;
        try {
          const snapshots = await invoke("list_snapshots", { request: { connectionId, database: targetDatabase } });
          if (Array.isArray(snapshots)) {
            matched = snapshots.find((item) => String(item?.path || "") === snapshotPath) || null;
          }
        } catch {
          // Snapshot metadata enrichment is optional; the path itself is authoritative.
        }
        const atIso = matched?.ts ? new Date(matched.ts).toISOString() : (context.now?.() || new Date()).toISOString();
        backup = {
          id: snapshotPath,
          at: atIso,
          database: targetDatabase,
          tables: Number(matched?.tableCount ?? copiedTables.length + excludedTables.length),
          rows: copiedRows,
          path: snapshotPath,
          simulated: false,
        };
      }

      return {
        tables: copiedTables.length,
        excluded: excludedTables.length,
        droppedTables: droppedTables.length,
        rows: copiedRows,
        snapshot: snapshotPath,
        backup,
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    } finally {
      io.signal?.removeEventListener("abort", onAbort);
      try {
        unlisten?.();
      } catch {}
    }
  }

  async function restoreDatabase(context, io) {
    const connectionId = requireConnectionId(context);
    const backup = context?.backup;
    const snapshotPath = String(backup?.path || "").trim();
    if (!snapshotPath) {
      throw new ReleaseTaskError("noBackup", "noBackup");
    }
    const targetDatabase = String(backup?.database || context?.platform?.targetDatabase || "").trim();
    io.log(`restore ${targetDatabase} ← ${snapshotPath}`);
    try {
      await invoke("restore_snapshot", {
        request: {
          snapshotPath,
          connectionId,
        },
      });
      io.log(`restored ${targetDatabase}`, "success");
      io.progress(1);
      return {
        backup,
        tables: Number(backup?.tables ?? 0),
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    }
  }

  async function writePlans(context, io) {
    const connectionId = requireConnectionId(context);
    const database = String(context?.platform?.targetDatabase || "").trim();
    if (!database) {
      throw new ReleaseTaskError("invalidSyncDatabases", "invalidSyncDatabases");
    }
    const writes = Array.isArray(context?.plan?.writes) ? context.plan.writes : [];
    const counts = context?.plan?.counts || { open: 0, close: 0 };
    if (!writes.length) {
      io.log(`${database}: nothing to change`, "success");
      io.progress(1);
      return { ...counts, statements: 0, affectedRows: 0 };
    }
    io.log(`execute ${writes.length} plan update statement(s) on ${database}`);
    try {
      const response = await invoke("release_execute_plan_writes", {
        request: {
          connectionId,
          database,
          writes,
        },
      });
      const executedSql = Array.isArray(response?.executedSql) ? response.executedSql : [];
      if (executedSql.length) {
        io.logs(executedSql.map((sql) => ({ text: sql, tone: "" })));
      }
      const affectedRows = Number(response?.affectedRows ?? 0);
      const statements = Number(response?.statements ?? executedSql.length);
      io.log(`committed · ${affectedRows} row(s) updated`, "success");
      io.progress(1);
      return {
        ...counts,
        statements,
        affectedRows,
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    }
  }

  async function updateSvn(context, io) {
    const root = String(context?.platform?.targetClient || "").trim();
    if (!root) {
      throw new ReleaseTaskError("missingClientPath", "missingClientPath");
    }
    io.log(`svn update "${root}"`);
    try {
      const response = await invoke("svn_wc_update", { request: { root } });
      const lines = Array.isArray(response?.lines) ? response.lines : [];
      const conflicts = Array.isArray(response?.conflicts) ? response.conflicts : [];
      if (lines.length) {
        io.logs(lines.map((line) => ({
          text: String(line),
          tone: /^C\s|conflict/i.test(String(line)) ? "warning" : "",
        })));
      }
      const revision = Number(response?.revision ?? 0);
      const updated = Number(response?.updated ?? 0);
      if (conflicts.length) {
        io.log(`${conflicts.length} conflict(s) require resolution`, "warning");
      } else {
        io.log(`working copy at revision ${revision || "HEAD"}`, "success");
      }
      io.progress(1);
      return {
        revision,
        updated,
        conflicts,
        resolved: 0,
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    }
  }

  async function resolveSvnConflicts(context, io) {
    const root = String(context?.platform?.targetClient || "").trim();
    if (!root) {
      throw new ReleaseTaskError("missingClientPath", "missingClientPath");
    }
    const conflicts = Array.isArray(context?.conflicts) ? context.conflicts : [];
    const grouped = new Map();
    for (const entry of conflicts) {
      const path = String(entry?.path || "").trim();
      const accept = ACCEPT_BY_CHOICE[entry?.choice];
      if (!path || !accept) continue;
      const list = grouped.get(accept) || [];
      list.push(path);
      grouped.set(accept, list);
    }

    try {
      for (const [accept, paths] of grouped.entries()) {
        io.log(`svn resolve --accept ${accept} (${paths.length})`);
        await invoke("svn_wc_resolve", { request: { root, paths, accept } });
      }
      const statusEntries = await invoke("svn_wc_status", { request: { root } });
      const remaining = (Array.isArray(statusEntries) ? statusEntries : []).filter(hasSvnConflictEntry);
      if (remaining.length) {
        for (const item of remaining) {
          io.log(`unresolved conflict: ${item.path}`, "error");
        }
        throw new ReleaseTaskError("svnConflictsRemain", "svnConflictsRemain", {
          result: { conflicts: remaining.map((item) => item.path) },
        });
      }
      io.log(`resolved ${conflicts.length} conflict(s)`, "success");
      io.progress(1);
      return {
        ...(context?.previous || {}),
        conflicts: context?.previous?.conflicts || [],
        resolved: conflicts.length,
        choices: conflicts.map((entry) => entry.choice),
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    }
  }

  async function syncFiles(context, io) {
    const sourceClient = String(context?.platform?.sourceClient || "").trim();
    const targetClient = String(context?.platform?.targetClient || "").trim();
    if (!sourceClient || !targetClient) {
      throw new ReleaseTaskError("missingClientPath", "missingClientPath");
    }
    const rules = Array.isArray(context?.rules) ? context.rules : [];
    const mirrorDeletes = context?.mirrorDeletes !== false;
    const jobId = createJobId("release-client-sync");
    let unlisten = null;
    const onAbort = () => {
      void invoke("release_client_sync_cancel", { request: { jobId } }).catch(() => {});
    };
    io.signal?.addEventListener("abort", onAbort, { once: true });
    io.log(`sync ${sourceClient} → ${targetClient}`);

    try {
      if (listen) {
        unlisten = await listen("release-client-sync-progress", (event) => {
          const payload = event?.payload || event || {};
          if (String(payload.jobId || payload.job_id || "") !== jobId) return;
          const total = Number(payload.total ?? 0);
          const done = Number(payload.done ?? 0);
          if (total > 0) io.progress(Math.min(0.98, done / total));
          if (payload.currentPath) {
            io.log(`[${done}/${total}] ${payload.currentPath}`);
          }
        });
      }

      const response = await invoke("release_client_sync_run", {
        request: {
          jobId,
          sourceClient,
          targetClient,
          rules,
          mirrorDeletes,
        },
      });

      const warnings = Array.isArray(response?.warnings) ? response.warnings : [];
      for (const warning of warnings) {
        io.log(`missing: ${warning.path}`, "warning");
      }
      const added = Number(response?.added ?? 0);
      const modified = Number(response?.modified ?? 0);
      const deleted = Number(response?.deleted ?? 0);
      const excluded = Number(response?.excluded ?? 0);
      io.log(`+${added} ~${modified} -${deleted} (${excluded} excluded)`, warnings.length ? "warning" : "success");
      io.progress(1);
      return {
        added,
        modified,
        deleted,
        excluded,
        warnings,
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    } finally {
      io.signal?.removeEventListener("abort", onAbort);
      try {
        unlisten?.();
      } catch {}
    }
  }

  async function runTransfer(context, io) {
    const template = context?.template;
    const scriptPath = String(template?.scriptPath || "").trim();
    const projectRoot = String(context?.platform?.targetClient || template?.projectRoot || "").trim();
    if (!scriptPath) {
      throw new ReleaseTaskError("missingTemplate", "missingTemplate");
    }
    if (!projectRoot) {
      throw new ReleaseTaskError("missingClientPath", "missingClientPath");
    }
    const jobId = createJobId("release-transfer");
    let unlisten = null;
    const onAbort = () => {
      void invoke("table_transfer_cancel", { jobId }).catch(() => {});
    };
    io.signal?.addEventListener("abort", onAbort, { once: true });
    io.log(`> "${scriptPath}"`);
    io.progress(null);

    try {
      if (listen) {
        unlisten = await listen("table-transfer-progress", (event) => {
          const payload = event?.payload || event || {};
          if (String(payload.jobId || payload.job_id || "") !== jobId) return;
          const raw = String(payload.line ?? payload.message ?? "");
          if (!raw.trim()) return;
          const entries = raw
            .split("\n")
            .map((part) => part.trimEnd())
            .filter((part) => part.trim())
            .map((text) => ({ text, tone: "" }));
          if (entries.length) io.logs(entries);
        });
      }

      const response = await invoke("table_transfer_run", {
        request: {
          jobId,
          scriptPath,
          projectRoot,
          conflictStrategy: template?.conflictStrategy || "theirs-full",
          skipSvnUpdate: true,
        },
      });

      const copiedFiles = Number(response?.copiedFiles ?? 0);
      const outputDir = String(response?.outputDir || "");
      const updatedDirs = Array.isArray(response?.updatedDirs) ? response.updatedDirs : [];
      io.log(`copied ${copiedFiles} file(s) → ${projectRoot}`, "success");
      io.progress(1);
      return {
        template: String(template?.name || ""),
        outputDir,
        updatedDirs,
        copiedFiles,
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    } finally {
      io.signal?.removeEventListener("abort", onAbort);
      try {
        unlisten?.();
      } catch {}
    }
  }

  async function confirmDiff(context, io) {
    const root = String(context?.platform?.targetClient || "").trim();
    if (!root) {
      throw new ReleaseTaskError("missingClientPath", "missingClientPath");
    }
    try {
      const entries = await invoke("svn_wc_status", { request: { root } });
      const list = Array.isArray(entries) ? entries : [];
      const conflicts = list.filter(hasSvnConflictEntry);
      if (conflicts.length) {
        for (const item of conflicts) {
          io.log(`conflict: ${item.path}`, "error");
        }
        throw new ReleaseTaskError("svnConflictsRemain", "svnConflictsRemain", {
          result: { conflicts: conflicts.map((item) => item.path) },
        });
      }
      const added = list.filter((item) => item.item === "added" || item.item === "unversioned").length;
      const deleted = list.filter((item) => item.item === "deleted" || item.item === "missing").length;
      const modified = list.length - added - deleted;
      io.log(`${list.length} working-copy entry(ies) verified`, "success");
      io.progress(1);
      return {
        files: list.length,
        modified,
        added,
        deleted,
      };
    } catch (error) {
      rethrowTaskError(error, io, io.signal);
    }
  }

  const runners = Object.freeze({
    "db.sync": syncDatabase,
    "db.restore": restoreDatabase,
    "db.plans": writePlans,
    "client.svn": updateSvn,
    "client.svnResolve": resolveSvnConflicts,
    "client.sync": syncFiles,
    "client.transfer": runTransfer,
    "client.diff": confirmDiff,
  });

  return {
    handles(taskId, context) {
      return Boolean(!context?.demoRun && REAL_TASK_IDS.has(taskId));
    },
    async run(taskId, context, io) {
      const runner = runners[taskId];
      if (!runner) {
        throw new ReleaseTaskError("unknownTask", `Unknown real release task: ${taskId}`);
      }
      return runner(context, io);
    },
  };
}
