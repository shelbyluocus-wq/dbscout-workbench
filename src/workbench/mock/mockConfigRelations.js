// Browser-mock counterpart of the Rust config_relations module. A fixed
// catalog of relations over the demo game schema stands in for column-comment
// parsing and client-code scanning; client bindings and review decisions live
// per mock server, and row lookups read the live mock rows, so edits show up
// the same way they do against MySQL.

import { emitMockEvent } from "./mockEventBus.js";
import { columnName } from "../utils/normalize.js";
import { listItemValues, normalizeRelationFilter } from "../utils/relationFilter.js";
import { isEmptyReferenceValue, referenceValuesFromCell, rowCellValue } from "../utils/configRelations.js";

const UPDATED_EVENT = "config-relations-updated";
const COMMAND_PREFIX = "config_relations_";
const MAX_VALUES_PER_RELATION = 50;
const MIN_RECOMMENDED_RATIO = 0.5;
const LABEL_COLUMNS = ["name", "title", "desc", "des", "describe", "remark"];
const FORMAT_SAMPLE_LENGTH = 120;

// Client folders the mock "finds" on disk.
const MOCK_CLIENTS = [
  {
    path: "D:\\client\\jswz",
    dialect: "jswz",
    codeRoot: "assets/scripts",
    files: 1286,
    updatedAt: "2026-01-08 18:20",
    tables: [
      "hero", "item", "equip", "skill", "quest", "stage", "monster",
      "shop", "mail", "guild", "achievement", "activity", "buff", "drop_table",
    ],
    // Lookups whose keys come from somewhere the scan cannot follow.
    untraced: {
      item: [
        { file: "bag/BagModel.ts", line: 214, snippet: "ItemProp.get(entry.key)" },
        { file: "mail/MailAttachment.ts", line: 63, snippet: "ItemProp.get(attachment[0])" },
      ],
    },
  },
  {
    path: "D:\\Versions\\nzg",
    dialect: "nzg",
    codeRoot: "assets/script",
    files: 2140,
    updatedAt: "2025-12-30 09:45",
    tables: ["hero", "skill", "item"],
    untraced: {},
  },
];

// `comment`: the source column's comment names the target. `code`: a client
// lookup as [file, line, snippet]; `codeRevision` changes the usage
// fingerprint the way an edited lookup would. `format`: the cell holds a JSON
// list of `{ ID, Num }` entries.
const MOCK_RELATIONS = [
  { from: "hero.skill_id", to: "skill.id", comment: true, code: ["hero/HeroSkillPanel.ts", 58, "SkillProp.get(hero.skill_id)"] },
  { from: "hero.passive_id", to: "skill.id", code: ["hero/HeroPassive.ts", 31, "SkillProp.get(hero.passive_id)"] },
  { from: "quest.pre_quest", to: "quest.id", comment: true, code: ["quest/QuestChain.ts", 77, "QuestProp.get(quest.pre_quest)"] },
  { from: "quest.reward_item_id", to: "item.id", comment: true, code: ["quest/QuestReward.ts", 40, "ItemProp.get(quest.reward_item_id)"] },
  { from: "stage.boss_id", to: "monster.id", comment: true, code: ["battle/StageLoader.ts", 112, "MonsterProp.get(stage.boss_id)"] },
  { from: "stage.drop_table_id", to: "drop_table.id", comment: true, code: ["battle/StageLoot.ts", 26, "DropTableProp.get(stage.drop_table_id)"] },
  { from: "monster.skill_id_1", to: "skill.id", code: ["battle/MonsterAI.ts", 64, "SkillProp.get(monster.skill_id_1)"] },
  {
    from: "monster.skill_id_2",
    to: "skill.id",
    code: ["battle/MonsterAI.ts", 71, "SkillProp.get(monster.skill_id_2 || monster.skill_id_1)"],
    codeRevision: 2,
  },
  { from: "monster.drop_table_id", to: "drop_table.id", comment: true, code: ["battle/MonsterLoot.ts", 19, "DropTableProp.get(monster.drop_table_id)"] },
  // The comment says item, the client reads equip: a conflict to review.
  { from: "shop.item_id", to: "item.id", comment: true },
  { from: "shop.item_id", to: "equip.id", code: ["shop/ShopGoodsCell.ts", 88, "EquipProp.get(goods.item_id)"] },
  { from: "mail.reward_item_id", to: "item.id", comment: true },
  { from: "drop_table.item_id", to: "item.id", comment: true, code: ["battle/DropPreview.ts", 45, "ItemProp.get(drop.item_id)"] },
  {
    from: "activity.reward_pool",
    to: "item.id",
    kind: "list",
    format: true,
    code: ["activity/RewardPool.ts", 52, "pool.map((entry) => ItemProp.get(entry.ID))"],
  },
];

// The demo server starts bound and with a little history: one lookup showed
// up after binding, one confirmed lookup has changed since, and one list
// relation was confirmed by hand.
const SEEDED_SERVERS = {
  "demo:3306": {
    client: { path: "D:\\client\\jswz", dialect: "jswz", confirmedAt: "2026-01-05 10:12" },
    newSinceBinding: ["hero.passive_id>skill.id"],
    decisions: [
      { id: "monster.skill_id_2>skill.id", verdict: "confirmed", codeRevision: 1, decidedAt: "2026-01-06 15:40" },
      { id: "activity.reward_pool[]>item.id", verdict: "confirmed", codeRevision: 1, decidedAt: "2026-01-06 15:42" },
    ],
  },
};

function splitColumnRef(ref) {
  const [table, column] = String(ref).split(".");
  return { table: table.toLowerCase(), column };
}

function relationKeyOf(def) {
  const source = splitColumnRef(def.from);
  const target = splitColumnRef(def.to);
  return {
    sourceTable: source.table,
    sourceColumn: source.column,
    targetTable: target.table,
    targetColumn: target.column,
    kind: def.kind === "list" ? "list" : "value",
  };
}

export function mockRelationId(key) {
  const suffix = key.kind === "list" ? "[]" : "";
  return `${key.sourceTable}.${key.sourceColumn.toLowerCase()}${suffix}>${key.targetTable}.${key.targetColumn.toLowerCase()}`;
}

const RELATION_DEFS = MOCK_RELATIONS.map((def) => {
  const key = relationKeyOf(def);
  return { ...def, key, id: mockRelationId(key) };
});

function codeFingerprint(id, revision = 1) {
  return `${id}#${revision}`;
}

function samePath(left, right) {
  const normalize = (value) => String(value || "").trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

function clientFor(path) {
  return MOCK_CLIENTS.find((client) => samePath(client.path, path)) || null;
}

function findColumn(table, name) {
  const wanted = String(name || "").trim().toLowerCase();
  return (table?.columns || []).find((column) => columnName(column).toLowerCase() === wanted) || null;
}

function isTextColumn(column) {
  return /char|text/i.test(String(column?.column_type || column?.columnType || ""));
}

function labelColumn(table) {
  const textColumns = (table?.columns || []).filter((column) => isTextColumn(column) && !column.is_primary_key);
  const byName = (wanted) => textColumns.find((column) => columnName(column).toLowerCase() === wanted);
  return LABEL_COLUMNS.map(byName).find(Boolean) ||
    textColumns.find((column) => columnName(column).toLowerCase().includes("name")) ||
    textColumns.find((column) => /名称|名字/.test(String(column.column_comment || ""))) ||
    null;
}

function nowText() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// In-memory equivalent of the backend's relation row filter.
export function relationRowMatches(row, columns, relation) {
  const filter = normalizeRelationFilter(relation);
  if (!filter) return true;
  const column = findColumn({ columns }, filter.column);
  if (!column) return false;
  const cell = row?.[columnName(column)];
  if (cell === null || cell === undefined) return false;
  if (filter.kind === "listContains") {
    const items = listItemValues(cell, filter.itemKey);
    return Boolean(items?.some((item) => filter.values.includes(item)));
  }
  return filter.values.includes(String(cell).trim());
}

function unsupported() {
  return new Error("配置关联只支持 MySQL 配置库");
}

export function createMockConfigRelations({
  connectionFor,
  schemaFor,
  rowsFor,
  delayMs = 450,
  emit = emitMockEvent,
  now = nowText,
} = {}) {
  const servers = new Map();
  const contexts = new Map();

  function seededServer(key) {
    const seed = SEEDED_SERVERS[key];
    const state = { client: null, clientDeclined: false, baseline: null, decisions: new Map() };
    if (!seed) return state;
    state.client = { ...seed.client };
    state.baseline = new Set(RELATION_DEFS.map((def) => def.id).filter((id) => !seed.newSinceBinding.includes(id)));
    for (const decision of seed.decisions) {
      const def = RELATION_DEFS.find((item) => item.id === decision.id);
      state.decisions.set(decision.id, {
        verdict: decision.verdict,
        auto: false,
        fingerprints: new Set([codeFingerprint(decision.id, decision.codeRevision)]),
        overriddenCode: new Set(),
        key: { ...def.key },
        decidedAt: decision.decidedAt,
      });
    }
    return state;
  }

  function serverState(key) {
    let state = servers.get(key);
    if (!state) {
      state = seededServer(key);
      servers.set(key, state);
    }
    return state;
  }

  function contextsFor(serverKey) {
    return [...contexts.values()].filter((context) => context.serverKey === serverKey);
  }

  function resolve(request = {}) {
    const database = String(request.database || "").trim();
    if (!database) throw new Error("请先选择数据库");
    const connectionId = String(request.connectionId || "");
    const connection = connectionFor(connectionId);
    if (!connection) throw new Error("连接不存在");
    if (String(connection.kind || "mysql").toLowerCase() !== "mysql" || connection.sampleData) throw unsupported();
    const key = `${connectionId}\u001f${database.toLowerCase()}`;
    let context = contexts.get(key);
    if (!context) {
      context = {
        key,
        connectionId,
        database,
        serverKey: `${String(connection.host || "").trim().toLowerCase()}:${connection.port}`,
        revision: 0,
        code: "noClient",
        scannedAt: "",
        refreshing: false,
        timer: null,
      };
      contexts.set(key, context);
      restartAnalysis(context);
    }
    return context;
  }

  // ── index ──────────────────────────────────────────────────────

  function tablesOf(context) {
    const tables = new Map();
    for (const table of schemaFor(context.connectionId, context.database) || []) {
      tables.set(String(table.table_name).toLowerCase(), table);
    }
    return tables;
  }

  function formatSample(context, table, column) {
    const rows = rowsFor(context.connectionId, context.database, table.table_name) || [];
    const name = columnName(column);
    const cell = rows.map((row) => row[name]).find((value) => listItemValues(value)?.length);
    return cell === undefined ? "" : String(cell).slice(0, FORMAT_SAMPLE_LENGTH);
  }

  function candidatesOf(context, tables, client) {
    const candidates = new Map();
    for (const def of RELATION_DEFS) {
      const { key } = def;
      const source = tables.get(key.sourceTable);
      const target = tables.get(key.targetTable);
      const sourceColumn = findColumn(source, key.sourceColumn);
      if (!sourceColumn || !findColumn(target, key.targetColumn)) continue;
      const evidence = [];
      if (def.comment && String(sourceColumn.column_comment || "").trim()) {
        evidence.push({ type: "comment", text: String(sourceColumn.column_comment).trim() });
      }
      const readsBoth = client?.tables.includes(key.sourceTable) && client.tables.includes(key.targetTable);
      if (def.code && readsBoth) {
        const [file, line, snippet] = def.code;
        evidence.push({
          type: "code",
          file: `${client.codeRoot}/${file}`,
          line,
          snippet,
          fingerprint: codeFingerprint(def.id, def.codeRevision),
        });
      }
      if (def.format) {
        const sample = formatSample(context, source, sourceColumn);
        if (sample) evidence.push({ type: "format", sample });
      }
      if (evidence.length) candidates.set(def.id, { id: def.id, key, evidence });
    }
    return candidates;
  }

  function evidenceOf(candidate, type) {
    return candidate.evidence.filter((evidence) => evidence.type === type);
  }

  function fingerprintsOf(candidate) {
    return new Set(evidenceOf(candidate, "code").map((evidence) => evidence.fingerprint));
  }

  // Code reading a comment relation's column from another table while
  // nothing in the code supports the comment's own target.
  function disagreementOf(candidate, candidates) {
    if (!evidenceOf(candidate, "comment").length || evidenceOf(candidate, "code").length) return null;
    let found = null;
    for (const other of candidates.values()) {
      if (other.id === candidate.id || !evidenceOf(other, "code").length) continue;
      const sameSource = other.key.sourceTable === candidate.key.sourceTable &&
        other.key.sourceColumn.toLowerCase() === candidate.key.sourceColumn.toLowerCase();
      if (!sameSource) continue;
      found ||= { target: `${other.key.targetTable}.${other.key.targetColumn}`, fingerprints: new Set() };
      for (const fingerprint of fingerprintsOf(other)) found.fingerprints.add(fingerprint);
    }
    return found;
  }

  function isSubset(left, right) {
    return [...left].every((item) => right.has(item));
  }

  function sameSet(left, right) {
    return left.size === right.size && isSubset(left, right);
  }

  // Comment and code agree: the tool records the confirmation itself.
  function recordAgreement(state, candidate, fingerprints, auto) {
    state.decisions.set(candidate.id, {
      verdict: "confirmed",
      auto,
      fingerprints: new Set(fingerprints),
      overriddenCode: new Set(),
      key: { ...candidate.key },
      decidedAt: now(),
    });
  }

  // Mirrors assembly.rs: the decision, the evidence and the code state decide
  // status and reason.
  function viewOf(candidate, disagreement, state, codeReady) {
    const hasComment = evidenceOf(candidate, "comment").length > 0;
    const hasCode = evidenceOf(candidate, "code").length > 0;
    const agrees = hasComment && hasCode;
    const fingerprints = fingerprintsOf(candidate);
    let decision = state.decisions.get(candidate.id) || null;
    // New code usages reopen a rejected relation.
    if (decision?.verdict === "rejected" && codeReady && !isSubset(fingerprints, decision.fingerprints)) decision = null;
    let status;
    let reason;
    if (decision?.verdict === "rejected") {
      [status, reason] = ["rejected", "rejected"];
    } else if (decision) {
      const lost = !isSubset(decision.fingerprints, fingerprints);
      const unseenDisagreement = Boolean(disagreement) &&
        !isSubset(disagreement.fingerprints, decision.overriddenCode || new Set());
      if (agrees) {
        if (!sameSet(decision.fingerprints, fingerprints)) recordAgreement(state, candidate, fingerprints, decision.auto);
        [status, reason] = ["confirmed", "matchesCode"];
      } else if (codeReady && lost) {
        [status, reason] = ["stale", hasCode ? "codeChanged" : "codeRemoved"];
      } else if (codeReady && unseenDisagreement) {
        [status, reason] = ["conflict", "commentConflict"];
      } else {
        [status, reason] = decision.auto ? ["confirmed", "matchesCode"] : ["confirmed", "manual"];
      }
    } else if (disagreement) {
      [status, reason] = ["conflict", "commentConflict"];
    } else if (agrees) {
      recordAgreement(state, candidate, fingerprints, true);
      [status, reason] = ["confirmed", "matchesCode"];
    } else if (hasCode) {
      [status, reason] = ["confirmed", "codeOnly"];
    } else if (hasComment) {
      [status, reason] = ["confirmed", codeReady ? "commentOnly" : "commentWithoutClient"];
    } else {
      [status, reason] = ["confirmed", "formatOnly"];
    }
    return {
      id: candidate.id,
      ...candidate.key,
      status,
      reason,
      isNew: status === "unconfirmed" && Boolean(state.baseline) && !state.baseline.has(candidate.id),
      evidence: candidate.evidence.map((evidence) => ({ ...evidence })),
      ...(status === "conflict" && disagreement ? { codeTarget: disagreement.target } : {}),
      ...(decision ? { decidedAt: decision.decidedAt } : {}),
    };
  }

  // A confirmed relation nothing supports any more stays visible.
  function orphanOf(id, decision, tables, codeReady) {
    if (decision.verdict !== "confirmed") return null;
    const { key } = decision;
    const source = tables.get(key.sourceTable);
    const target = tables.get(key.targetTable);
    if (!source || !target) return null;
    const columnsGone = !findColumn(source, key.sourceColumn) || !findColumn(target, key.targetColumn);
    let status = "confirmed";
    let reason = decision.auto ? "matchesCode" : "manual";
    if (columnsGone) [status, reason] = ["stale", "evidenceGone"];
    else if (codeReady && decision.fingerprints.size) [status, reason] = ["stale", "codeRemoved"];
    return { id, ...key, status, reason, isNew: false, evidence: [], decidedAt: decision.decidedAt };
  }

  function buildIndex(context) {
    const tables = tablesOf(context);
    const state = serverState(context.serverKey);
    const client = context.code === "ready" ? clientFor(state.client?.path) : null;
    const codeReady = Boolean(client);
    const candidates = candidatesOf(context, tables, client);
    // Kept beside the views, like the backend's unserialized field.
    const disagreements = new Map();
    const views = [...candidates.values()].map((candidate) => {
      const disagreement = disagreementOf(candidate, candidates);
      if (disagreement) disagreements.set(candidate.id, disagreement.fingerprints);
      return viewOf(candidate, disagreement, state, codeReady);
    });
    for (const [id, decision] of state.decisions) {
      if (candidates.has(id)) continue;
      const orphan = orphanOf(id, decision, tables, codeReady);
      if (orphan) views.push(orphan);
    }
    views.sort((left, right) => left.id.localeCompare(right.id));
    return { views, tables, client, disagreements };
  }

  function totalsOf(views) {
    const totals = { total: 0, confirmed: 0, unconfirmed: 0, newUnconfirmed: 0, stale: 0, conflict: 0, rejected: 0 };
    for (const view of views) {
      totals.total += 1;
      totals[view.status] += 1;
      if (view.status === "unconfirmed" && view.isNew) totals.newUnconfirmed += 1;
    }
    return totals;
  }

  function tableLabels(tables, views) {
    const labels = {};
    for (const view of views) {
      for (const lower of [view.sourceTable, view.targetTable]) {
        const table = tables.get(lower);
        if (table && !labels[lower]) labels[lower] = { name: table.table_name, comment: table.table_comment || "" };
      }
    }
    return labels;
  }

  // ── state changes ──────────────────────────────────────────────

  function notify(context, built = buildIndex(context)) {
    const totals = totalsOf(built.views);
    emit(UPDATED_EVENT, {
      connectionId: context.connectionId,
      database: context.database,
      revision: context.revision,
      reviewCount: totals.stale + totals.conflict,
    });
  }

  function rebuild(context) {
    context.revision += 1;
    notify(context);
  }

  function runLater(context, task) {
    clearTimeout(context.timer);
    context.timer = null;
    context.refreshing = true;
    const finish = () => {
      context.timer = null;
      context.refreshing = false;
      task();
    };
    if (delayMs > 0) context.timer = setTimeout(finish, delayMs);
    else finish();
  }

  function finishAnalysis(context) {
    const state = serverState(context.serverKey);
    if (!state.client) {
      context.code = "noClient";
    } else if (!clientFor(state.client.path)) {
      context.code = "clientMissing";
    } else {
      context.code = "ready";
      context.scannedAt = now();
      if (!state.baseline) state.baseline = new Set(buildIndex(context).views.map((view) => view.id));
    }
    rebuild(context);
  }

  // A (re)bound client is read again by every open database of the server.
  function restartAnalysis(context) {
    const bound = Boolean(serverState(context.serverKey).client);
    clearTimeout(context.timer);
    context.timer = null;
    context.refreshing = false;
    context.code = bound ? "pending" : "noClient";
    rebuild(context);
    if (bound) runLater(context, () => finishAnalysis(context));
  }

  function refresh(context) {
    if (context.timer) return;
    runLater(context, () => {
      if (context.code === "ready" || context.code === "noClient") notify(context);
      else finishAnalysis(context);
    });
  }

  function review(context, relationIds, verdict) {
    if (verdict !== null && verdict !== undefined && verdict !== "confirmed" && verdict !== "rejected") {
      throw new Error(`未知的复核结论: ${verdict}`);
    }
    const built = buildIndex(context);
    const views = new Map(built.views.map((view) => [view.id, view]));
    const state = serverState(context.serverKey);
    const decidedAt = now();
    for (const id of Array.isArray(relationIds) ? relationIds : []) {
      const view = views.get(String(id));
      if (!view) continue;
      if (!verdict) {
        state.decisions.delete(view.id);
        continue;
      }
      const { sourceTable, sourceColumn, targetTable, targetColumn, kind } = view;
      const disagreeing = verdict === "confirmed" ? built.disagreements.get(view.id) : null;
      state.decisions.set(view.id, {
        verdict,
        auto: false,
        fingerprints: new Set(view.evidence.filter((evidence) => evidence.type === "code").map((evidence) => evidence.fingerprint)),
        overriddenCode: new Set(disagreeing || []),
        key: { sourceTable, sourceColumn, targetTable, targetColumn, kind },
        decidedAt,
      });
    }
    for (const other of contextsFor(context.serverKey)) rebuild(other);
  }

  // ── client folders ─────────────────────────────────────────────

  function candidateFor(client, tables) {
    return {
      path: client.path,
      dialect: client.dialect,
      matchedTables: [...tables.keys()].filter((table) => client.tables.includes(table)).length,
      totalTables: tables.size,
      updatedAt: client.updatedAt,
      recommended: false,
    };
  }

  function discover(context) {
    const tables = tablesOf(context);
    const ranked = MOCK_CLIENTS
      .map((client) => candidateFor(client, tables))
      .filter((candidate) => candidate.matchedTables > 0)
      .sort((left, right) =>
        right.matchedTables - left.matchedTables ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.path.localeCompare(right.path));
    const best = ranked[0];
    if (best) best.recommended = best.matchedTables / Math.max(1, best.totalTables) >= MIN_RECOMMENDED_RATIO;
    return ranked;
  }

  function inspect(context, path) {
    const client = clientFor(path);
    if (!client) throw new Error("找不到这个目录");
    return candidateFor(client, tablesOf(context));
  }

  function bind(context, path) {
    const candidate = inspect(context, path);
    if (!candidate.matchedTables) throw new Error("这个客户端里没有当前数据库的任何配置表，可能是另一款游戏");
    const state = serverState(context.serverKey);
    const changed = !state.client || !samePath(state.client.path, candidate.path);
    state.client = { path: candidate.path, dialect: candidate.dialect, confirmedAt: now() };
    state.clientDeclined = false;
    if (changed) state.baseline = null;
    for (const other of contextsFor(context.serverKey)) restartAnalysis(other);
  }

  function unbind(context) {
    const state = serverState(context.serverKey);
    state.client = null;
    state.baseline = null;
    state.clientDeclined = true;
    for (const other of contextsFor(context.serverKey)) restartAnalysis(other);
  }

  // ── responses ──────────────────────────────────────────────────

  function overview(context) {
    const state = serverState(context.serverKey);
    const built = buildIndex(context);
    const totals = totalsOf(built.views);
    const ready = context.code === "ready";
    return {
      client: state.client
        ? { ...state.client, exists: Boolean(clientFor(state.client.path)) }
        : null,
      codeStatus: context.code,
      codeFiles: ready ? built.client?.files || 0 : 0,
      ...(ready && context.scannedAt ? { codeScannedAt: context.scannedAt } : {}),
      analyzing: context.code === "pending",
      refreshing: context.refreshing,
      totals,
      reviewCount: totals.stale + totals.conflict,
      clientDeclined: Boolean(state.clientDeclined),
      revision: context.revision,
    };
  }

  function coverage(context, built, table) {
    const gaps = [];
    if (context.code === "noClient") gaps.push({ code: "noClient" });
    else if (context.code === "clientMissing") gaps.push({ code: "clientMissing" });
    else if (context.code === "pending") gaps.push({ code: "analyzing" });
    if (built.client) {
      if (!built.client.tables.includes(table)) gaps.push({ code: "notUsedByClient" });
      const untraced = built.client.untraced[table] || [];
      if (untraced.length) {
        gaps.push({
          code: "untracedLookups",
          count: untraced.length,
          samples: untraced.map((sample) => ({ ...sample, file: `${built.client.codeRoot}/${sample.file}` })),
        });
      }
    }
    return { complete: gaps.length === 0, gaps };
  }

  function tableRelations(context, tableName) {
    const table = String(tableName || "").toLowerCase();
    const built = buildIndex(context);
    const outgoing = built.views.filter((view) => view.sourceTable === table);
    const incoming = built.views.filter((view) => view.targetTable === table);
    return {
      outgoing,
      incoming,
      coverage: coverage(context, built, table),
      tables: tableLabels(built.tables, [...outgoing, ...incoming]),
      revision: context.revision,
    };
  }

  function relationGraph(context) {
    const built = buildIndex(context);
    const edges = built.views.map(({ id, sourceTable, sourceColumn, targetTable, targetColumn, kind, status }) =>
      ({ id, sourceTable, sourceColumn, targetTable, targetColumn, kind, status }));
    return { edges, tables: tableLabels(built.tables, built.views), revision: context.revision };
  }

  function activeViews(views) {
    return views.filter((view) => view.status !== "rejected");
  }

  // Lowercase key -> label (or "") for every row of the target table.
  function targetKeys(context, table, column) {
    const keyName = columnName(findColumn(table, column));
    const label = labelColumn(table);
    const labelName = label ? columnName(label) : "";
    const keys = new Map();
    for (const row of rowsFor(context.connectionId, context.database, table.table_name) || []) {
      const value = row[keyName];
      if (value === null || value === undefined) continue;
      const key = String(value).trim().toLowerCase();
      if (!keys.has(key)) keys.set(key, labelName ? String(row[labelName] ?? "").trim() : "");
    }
    return keys;
  }

  function rowTargets(context, tableName, row) {
    const table = String(tableName || "").toLowerCase();
    const built = buildIndex(context);
    const outgoing = activeViews(built.views.filter((view) => view.sourceTable === table)).map((view) => {
      const values = referenceValuesFromCell(view.kind, rowCellValue(row, view.sourceColumn));
      const target = built.tables.get(view.targetTable);
      const keys = target && findColumn(target, view.targetColumn) ? targetKeys(context, target, view.targetColumn) : null;
      const targets = values.slice(0, MAX_VALUES_PER_RELATION).map((value) => {
        if (!keys) return { value, state: "unknown" };
        const label = keys.get(value.toLowerCase());
        if (label === undefined) return { value, state: "missing" };
        return label ? { value, state: "found", label } : { value, state: "found" };
      });
      return { relationId: view.id, targets, truncated: values.length > MAX_VALUES_PER_RELATION };
    });
    return { outgoing, revision: context.revision, superseded: false };
  }

  function rowReferences(context, tableName, row) {
    const table = String(tableName || "").toLowerCase();
    const built = buildIndex(context);
    const incoming = [];
    for (const view of activeViews(built.views.filter((item) => item.targetTable === table))) {
      const value = String(rowCellValue(row, view.targetColumn) ?? "").trim();
      if (isEmptyReferenceValue(value)) continue;
      const source = built.tables.get(view.sourceTable);
      const column = findColumn(source, view.sourceColumn);
      if (!column) {
        incoming.push({ relationId: view.id, value, count: null });
        continue;
      }
      const filter = { column: columnName(column), kind: view.kind === "list" ? "listContains" : "equals", values: [value] };
      const rows = rowsFor(context.connectionId, context.database, source.table_name) || [];
      const count = rows.filter((candidate) => relationRowMatches(candidate, source.columns, filter)).length;
      incoming.push({ relationId: view.id, value, count });
    }
    return { incoming, revision: context.revision, superseded: false };
  }

  function reviewList(context) {
    const built = buildIndex(context);
    const items = built.views.filter((view) => ["stale", "conflict"].includes(view.status));
    return { items, tables: tableLabels(built.tables, items), overview: overview(context) };
  }

  // ── dispatch ───────────────────────────────────────────────────

  function handles(command) {
    return String(command || "").startsWith(COMMAND_PREFIX);
  }

  async function invoke(command, payload = {}) {
    if (command === "config_relations_pick_client_dir") {
      // The browser preview has no native folder dialog; treat it as cancelled.
      return null;
    }
    const request = payload?.request || payload || {};
    const context = resolve(request);
    switch (command) {
      case "config_relations_overview":
        return overview(context);
      case "config_relations_table":
        return tableRelations(context, request.table);
      case "config_relations_graph":
        return relationGraph(context);
      case "config_relations_row_targets":
        return rowTargets(context, request.table, request.row || {});
      case "config_relations_row_references":
        return rowReferences(context, request.table, request.row || {});
      case "config_relations_review_list":
        return reviewList(context);
      case "config_relations_review":
        review(context, request.relationIds, request.verdict);
        return overview(context);
      case "config_relations_refresh":
        refresh(context);
        return null;
      case "config_relations_discover_clients":
        return discover(context);
      case "config_relations_inspect_client":
        return inspect(context, request.path);
      case "config_relations_bind_client":
        bind(context, request.path);
        return overview(context);
      case "config_relations_unbind_client":
        unbind(context);
        return overview(context);
      default:
        throw new Error(`Mock config relations command not implemented: ${command}`);
    }
  }

  function reset() {
    for (const context of contexts.values()) clearTimeout(context.timer);
    contexts.clear();
    servers.clear();
  }

  return { handles, invoke, reset };
}
