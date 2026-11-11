import { RELEASE_PLAN_CATEGORIES, RELEASE_PLAN_ITEMS, planItemKeyLabel } from "./releaseFlowDemo.js";
import { formatPlanDate } from "./releasePlanNotes.js";

/**
 * Infers unit sub-category in `heroprop` by ID range (Juesheng convention):
 * 1000..4999 hero, 5400..5499 pet, 5500..5999 spirit, 6500..6999 mount.
 */
export function classifyHeropropCategory(rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  if (id >= 5400 && id < 5500) return "pet";
  if (id >= 5500 && id < 6000) return "spirit";
  if (id >= 6500 && id < 7000) return "mount";
  if (id >= 1000 && id < 5000) return "hero";
  return null;
}

export function formatCandidateRef(keys) {
  if (!Array.isArray(keys) || !keys.length) return "";
  return keys.map((value) => String(value)).join(" · ");
}

function normalizeCandidate({ category, name, ref, flag = null }) {
  const cleanName = String(name ?? "").trim();
  const cleanRef = String(ref ?? "").trim();
  if (!cleanName && !cleanRef) return null;
  return {
    key: `${category}:${cleanRef || cleanName}`,
    category,
    name: cleanName,
    ref: cleanRef,
    flag: flag === 0 || flag === 1 ? flag : null,
  };
}

/**
 * Merges live database candidate rows, existing memo entries, and optional
 * built-in catalog items for a given category, deduplicated by `(category, ref|name)`.
 * Closed (`flag === 0`) database items sort ahead of already-open ones so
 * upcoming content surfaces at the top of the dropdown.
 */
export function mergePlanCandidates({
  category = "hero",
  dbRows = [],
  memoItems = [],
  builtinItems = RELEASE_PLAN_ITEMS,
} = {}) {
  const catMeta = RELEASE_PLAN_CATEGORIES.find((entry) => entry.id === category) || null;
  const seen = new Set();
  const list = [];

  const push = (raw) => {
    const item = normalizeCandidate(raw);
    if (!item || seen.has(item.key)) return;
    seen.add(item.key);
    list.push(item);
  };

  if (catMeta && Array.isArray(dbRows) && dbRows.length) {
    const isHeroprop = catMeta.table === "heroprop";
    const typedRows = dbRows
      .filter((row) => Array.isArray(row?.keys) && row.keys.length === catMeta.keyColumns.length)
      .map((row) => ({
        row,
        inferred: isHeroprop ? classifyHeropropCategory(row.keys[0]) : category,
      }));
    const matching = isHeroprop
      ? typedRows.filter((entry) => entry.inferred === category)
      : typedRows;
    const chosen = matching.length ? matching : typedRows;
    const sorted = [...chosen].sort((left, right) => {
      const leftClosed = left.row.flag === 0 ? 0 : 1;
      const rightClosed = right.row.flag === 0 ? 0 : 1;
      if (leftClosed !== rightClosed) return leftClosed - rightClosed;
      for (let i = 0; i < left.row.keys.length; i += 1) {
        const diff = Number(left.row.keys[i]) - Number(right.row.keys[i]);
        if (diff !== 0) return diff;
      }
      return 0;
    });
    for (const { row } of sorted) {
      push({
        category,
        name: row.name,
        ref: formatCandidateRef(row.keys),
        flag: row.flag,
      });
    }
  }

  for (const entry of Array.isArray(memoItems) ? memoItems : []) {
    if (category !== "all" && entry?.category !== category) continue;
    push({
      category: entry.category || category,
      name: entry.name,
      ref: entry.ref,
      flag: entry.devFlag,
    });
  }

  for (const item of Array.isArray(builtinItems) ? builtinItems : []) {
    if (category !== "all" && item?.category !== category) continue;
    push({
      category: item.category,
      name: item.name,
      ref: planItemKeyLabel(item),
      flag: item.devFlag,
    });
  }

  return list;
}

export function buildPlanNameOptions(candidates, translate) {
  const closedTag = translate("releaseFlow.plan.candidate.unopened");
  return (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item.name)
    .map((item) => {
      const parts = [];
      if (item.ref) parts.push(item.ref);
      if (item.flag === 0) parts.push(closedTag);
      return {
        key: item.key,
        value: item.name,
        label: item.name,
        detail: parts.join(" · "),
        candidate: item,
      };
    });
}

export function buildPlanRefOptions(candidates, translate) {
  const closedTag = translate("releaseFlow.plan.candidate.unopened");
  return (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item.ref)
    .map((item) => {
      const parts = [];
      if (item.name) parts.push(item.name);
      if (item.flag === 0) parts.push(closedTag);
      return {
        key: item.key,
        value: item.ref,
        label: item.ref,
        detail: parts.join(" · "),
        candidate: item,
      };
    });
}

export function buildPlanNotePresets(dateIso, referenceIso, translate) {
  const formatted = formatPlanDate(dateIso, referenceIso || dateIso);
  return [
    { id: "openDate", value: translate("releaseFlow.note.open", { date: formatted }), label: translate("releaseFlow.note.open", { date: formatted }) },
    { id: "always", value: translate("releaseFlow.note.always"), label: translate("releaseFlow.note.always") },
    { id: "never", value: translate("releaseFlow.note.never"), label: translate("releaseFlow.note.never") },
    { id: "closeDate", value: translate("releaseFlow.note.close", { date: formatted }), label: translate("releaseFlow.note.close", { date: formatted }) },
    { id: "pending", value: translate("releaseFlow.note.pendingArt"), label: translate("releaseFlow.note.pendingArt") },
  ];
}
