const DEFAULT_ID_KEY_RE = /^(?:id|.*id|item|goods|hero|skill|buff|drop|reward|quest|task|npc|map|stage|level|act|activity|cond|group|pool|box|chest|equip|pet|mount|icon|model|effect|cfg|ref)$/i;

export function buildCellTargetLookup(cellRelations) {
  const byValue = new Map();
  const ordered = [];
  for (const group of Array.isArray(cellRelations) ? cellRelations : []) {
    const relation = group?.relation;
    const targetTable = String(group?.targetTable || relation?.targetTable || "").trim();
    const targetTableComment = String(group?.targetTableComment || "").trim();
    const targetColumn = String(relation?.targetColumn || "").trim();
    for (const target of Array.isArray(group?.targets) ? group.targets : []) {
      const value = String(target?.value ?? "").trim();
      if (!value) continue;
      const entry = {
        value,
        label: target?.label ? String(target.label).trim() : "",
        state: String(target?.state || "unknown"),
        targetTable,
        targetTableComment,
        targetColumn,
        relation,
      };
      ordered.push(entry);
      const key = value.toLowerCase();
      const existing = byValue.get(key);
      if (!existing || (existing.state !== "found" && entry.state === "found")) {
        byValue.set(key, entry);
      }
    }
  }
  return { byValue, ordered };
}

function formatScalarValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function resolveFieldTarget(key, value, targetLookup) {
  if (!targetLookup || !targetLookup.size) return null;
  if (value === null || value === undefined || typeof value === "object") return null;
  const text = String(value).trim();
  if (!text) return null;
  const matched = targetLookup.get(text.toLowerCase());
  if (!matched) return null;
  // Prefer matching ID-like keys, or allow any key if the relation specifically
  // uses a custom item key or the cell itself is a plain scalar/primitive array.
  const itemKey = String(matched.relation?.itemKey || "").trim();
  if (itemKey && key.toLowerCase() === itemKey.toLowerCase()) return matched;
  if (DEFAULT_ID_KEY_RE.test(key)) return matched;
  return null;
}

export function buildCellStructuredPreview(rawText, cellRelations = []) {
  const { byValue, ordered } = buildCellTargetLookup(cellRelations);
  const text = String(rawText ?? "").trim();

  if (text && (text.startsWith("[") || text.startsWith("{"))) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const allObjects = parsed.every(
          (item) => item !== null && typeof item === "object" && !Array.isArray(item),
        );
        if (allObjects) {
          const cards = parsed.map((item, index) => {
            const entries = Object.entries(item).map(([key, value]) => ({
              key,
              value: formatScalarValue(value),
              target: resolveFieldTarget(key, value, byValue),
            }));
            return { index: index + 1, entries };
          });
          return {
            kind: "json-array-objects",
            canCardView: true,
            cards,
            inlineTargets: ordered,
          };
        }
        const items = parsed.map((value, index) => {
          const textValue = formatScalarValue(value);
          const target = typeof value === "object" && value !== null
            ? null
            : byValue.get(textValue.trim().toLowerCase()) || null;
          return { index: index + 1, value: textValue, target };
        });
        return {
          kind: "json-array-primitives",
          canCardView: true,
          items,
          cards: [],
          inlineTargets: ordered,
        };
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed).map(([key, value]) => ({
          key,
          value: formatScalarValue(value),
          target: resolveFieldTarget(key, value, byValue),
        }));
        if (entries.length > 0) {
          return {
            kind: "json-object",
            canCardView: true,
            cards: [{ index: 1, entries }],
            inlineTargets: ordered,
          };
        }
      }
    } catch {
      // Not valid JSON — fall through to plain relation chips if available.
    }
  }

  return {
    kind: ordered.length ? "refs" : "none",
    canCardView: false,
    cards: [],
    items: [],
    inlineTargets: ordered,
  };
}
