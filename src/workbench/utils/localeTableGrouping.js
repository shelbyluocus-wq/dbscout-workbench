import { ref } from "vue";

export const FOLD_LOCALE_TABLES_STORAGE_KEY = "dbscout.fold-locale-tables.v1";

// Recognizes standard localized split-table suffixes in game config databases
// (e.g. goodsprop_en, goodsprop_en2, goodsprop_tw, goodsprop_kr, goodsprop_jp).
// Intentionally excludes `_id` (ubiquitous SQL identifier suffix).
// A table is ONLY treated as a variant when its base table also exists in the
// same database, so unrelated names are never folded.
const LOCALE_SUFFIX_RE = /^(.+?)_(en\d*|tw\d*|hk\d*|kr\d*|ko\d*|jp\d*|ja\d*|vi\d*|vn\d*|th\d*|de\d*|fr\d*|es\d*|ru\d*|pt\d*|ar\d*|my\d*|sg\d*|id_id|zh_tw|zh_cn|zh_hk|hant|hans)$/i;

function defaultGetName(table) {
  return String(table?.tableName || table?.table_name || table?.name || "").trim();
}

export function splitLocaleTableName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const match = LOCALE_SUFFIX_RE.exec(trimmed);
  if (!match) return null;
  const baseName = match[1];
  const suffix = `_${match[2].toLowerCase()}`;
  if (!baseName) return null;
  return { baseName, suffix };
}

export function analyzeLocaleTableGroups(tables, { getName = defaultGetName } = {}) {
  const list = Array.isArray(tables) ? tables : [];
  const exactNameByLower = new Map();
  for (const item of list) {
    const name = getName(item);
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!exactNameByLower.has(lower)) exactNameByLower.set(lower, name);
  }

  const variantsByBase = new Map();
  const variantToBase = new Map();
  const suffixCounts = new Map();

  for (const item of list) {
    const name = getName(item);
    if (!name) continue;
    const split = splitLocaleTableName(name);
    if (!split) continue;
    const baseLower = split.baseName.toLowerCase();
    const baseExact = exactNameByLower.get(baseLower);
    if (!baseExact) continue;
    const lower = name.toLowerCase();
    if (lower === baseLower) continue;

    variantToBase.set(lower, { baseName: baseExact, baseLower, suffix: split.suffix });
    const bucket = variantsByBase.get(baseLower) || [];
    bucket.push({ table: item, name, suffix: split.suffix });
    variantsByBase.set(baseLower, bucket);
    suffixCounts.set(split.suffix, (suffixCounts.get(split.suffix) || 0) + 1);
  }

  for (const bucket of variantsByBase.values()) {
    bucket.sort((a, b) => a.suffix.localeCompare(b.suffix, undefined, { numeric: true }));
  }

  return {
    variantCount: variantToBase.size,
    suffixCounts,
    variantsByBase,
    variantToBase,
  };
}

export function queryTargetsLocaleSuffix(query) {
  const text = String(query || "").trim().toLowerCase();
  if (!text) return false;
  return /(?:^|[\s_-])(?:en\d*|tw\d*|hk\d*|kr\d*|ko\d*|jp\d*|ja\d*|vi\d*|vn\d*|th\d*|de\d*|fr\d*|es\d*|ru\d*|pt\d*|ar\d*|id_id|zh_tw|zh_cn|zh_hk|hant|hans)$/i.test(text)
    || /_(?:en|tw|hk|kr|ko|jp|ja|vi|vn|th|de|fr|es|ru|pt|ar|zh)/i.test(text);
}

export function applyLocaleTableFolding(
  tables,
  {
    allTables = null,
    fold = false,
    expandedBases = null,
    query = "",
    getName = defaultGetName,
  } = {},
) {
  const list = Array.isArray(tables) ? tables : [];
  const analysis = analyzeLocaleTableGroups(Array.isArray(allTables) ? allTables : list, { getName });
  if (!fold || analysis.variantCount === 0 || queryTargetsLocaleSuffix(query)) {
    return {
      rows: list,
      localeMetaByName: new Map(),
      hiddenVariantCount: 0,
      totalVariantCount: analysis.variantCount,
      suffixCounts: analysis.suffixCounts,
    };
  }

  const presentLowers = new Set(list.map((item) => getName(item).toLowerCase()).filter(Boolean));
  const expanded = expandedBases instanceof Set
    ? expandedBases
    : new Set(Array.isArray(expandedBases) ? expandedBases : []);

  // Only fold variants whose base table is ALSO present in the current list.
  const foldedVariantsByBase = new Map();
  const foldedVariantLowers = new Set();
  for (const item of list) {
    const name = getName(item);
    const lower = name.toLowerCase();
    const link = analysis.variantToBase.get(lower);
    if (!link || !presentLowers.has(link.baseLower)) continue;
    foldedVariantLowers.add(lower);
    const bucket = foldedVariantsByBase.get(link.baseLower) || [];
    bucket.push({ table: item, name, suffix: link.suffix, baseName: link.baseName });
    foldedVariantsByBase.set(link.baseLower, bucket);
  }

  const rows = [];
  const localeMetaByName = new Map();
  let hiddenVariantCount = 0;

  for (const item of list) {
    const name = getName(item);
    const lower = name.toLowerCase();
    if (foldedVariantLowers.has(lower)) continue;

    rows.push(item);
    const variants = foldedVariantsByBase.get(lower);
    if (variants?.length) {
      const isExpanded = expanded.has(lower);
      localeMetaByName.set(name, {
        kind: "base",
        baseLower: lower,
        variantCount: variants.length,
        suffixes: variants.map((v) => v.suffix),
        expanded: isExpanded,
      });
      if (isExpanded) {
        const sortedVariants = [...variants].sort((a, b) =>
          a.suffix.localeCompare(b.suffix, undefined, { numeric: true }),
        );
        for (const variant of sortedVariants) {
          rows.push(variant.table);
          localeMetaByName.set(variant.name, {
            kind: "variant",
            baseName: variant.baseName,
            baseLower: lower,
            suffix: variant.suffix,
          });
        }
      } else {
        hiddenVariantCount += variants.length;
      }
    }
  }

  return {
    rows,
    localeMetaByName,
    hiddenVariantCount,
    totalVariantCount: analysis.variantCount,
    suffixCounts: analysis.suffixCounts,
  };
}

export function matchWildcardTableNames(tableNames, patternInput) {
  const tokens = String(patternInput || "")
    .split(/[\s,，;；]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!tokens.length) return [];

  const matchers = tokens.map((token) => {
    const hasGlob = token.includes("*") || token.includes("?");
    const escaped = token.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    if (hasGlob) {
      const regexBody = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
      return new RegExp(`^${regexBody}$`, "i");
    }
    return new RegExp(escaped, "i");
  });

  const matched = [];
  for (const raw of tableNames || []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (matchers.some((re) => re.test(name))) matched.push(name);
  }
  return matched;
}

export function readStoredFoldPreference(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem?.(FOLD_LOCALE_TABLES_STORAGE_KEY);
    if (stored === "0") return false;
    if (stored === "1") return true;
    return true;
  } catch {
    return true;
  }
}

const sharedFoldLocaleTables = ref(readStoredFoldPreference());

export function useLocaleTableFoldPreference() {
  function setFoldLocaleTables(next) {
    const value = Boolean(next);
    sharedFoldLocaleTables.value = value;
    try {
      globalThis.localStorage?.setItem?.(FOLD_LOCALE_TABLES_STORAGE_KEY, value ? "1" : "0");
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }

  function toggleFoldLocaleTables() {
    setFoldLocaleTables(!sharedFoldLocaleTables.value);
  }

  return {
    foldLocaleTables: sharedFoldLocaleTables,
    setFoldLocaleTables,
    toggleFoldLocaleTables,
  };
}
