// Unified column-comment directive parser, formatter and enum resolver.
// Kept aligned with src-tauri/src/config_relations/comments.rs.

import { normalizeReferenceParser, parseReferenceValues } from "./referenceParser.js";

export const MAX_COLUMN_COMMENT_LENGTH = 1024;

const IDENT_RE = /^[A-Za-z0-9_]+$/;
const PREFIX_ATOM_RE = /^[-A-Za-z0-9_.:]{1,32}$/;
const JSON_PATH_RE = /^\$(?:\.[A-Za-z0-9_]+|\[(?:\d+|\*)\])*$/;

function isIdent(text) {
  return IDENT_RE.test(String(text || ""));
}

function isPrefixAtom(text) {
  return PREFIX_ATOM_RE.test(String(text || ""));
}

function validJsonPath(path) {
  if (!JSON_PATH_RE.test(path)) return false;
  const steps = path.slice(1).match(/\.[A-Za-z0-9_]+|\[(?:\d+|\*)\]/g) || [];
  if (steps.length > 16) return false;
  for (const match of path.matchAll(/\[(\d+)\]/g)) {
    if (Number(match[1]) > 0xffffffff) return false;
  }
  return true;
}

// Extract outermost `[...]` and `【...】` blocks while respecting nested brackets
// such as `[列表关联: antiquesuitattrprop.SuitID @ $[*][0]]`.
function extractBracketBlocks(comment) {
  const text = String(comment ?? "");
  const blocks = [];
  let depth = 0;
  let outerStart = -1;
  let contentStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "[" || ch === "【") {
      if (depth === 0) {
        outerStart = i;
        contentStart = i + 1;
      }
      depth += 1;
    } else if ((ch === "]" || ch === "】") && depth > 0) {
      depth -= 1;
      if (depth === 0 && outerStart >= 0) {
        blocks.push({
          start: outerStart,
          end: i + 1,
          raw: text.slice(outerStart, i + 1),
          inner: text.slice(contentStart, i),
        });
        outerStart = -1;
        contentStart = -1;
      }
    }
  }
  return blocks;
}

function splitHeader(inner) {
  const colonIdx = inner.search(/[:：]/);
  if (colonIdx < 0) return null;
  return [inner.slice(0, colonIdx).trim(), inner.slice(colonIdx + 1).trim()];
}

function parseEnumEntries(body) {
  const entries = [];
  for (const rawItem of String(body || "").split(/[,，;；、\r\n]/)) {
    const item = rawItem.trim();
    if (!item) continue;
    let key = "";
    let label = "";
    const arrowIdx = item.indexOf("->");
    const unicodeArrowIdx = item.indexOf("→");
    if (arrowIdx > 0) {
      key = item.slice(0, arrowIdx).trim();
      label = item.slice(arrowIdx + 2).trim();
    } else if (unicodeArrowIdx > 0) {
      key = item.slice(0, unicodeArrowIdx).trim();
      label = item.slice(unicodeArrowIdx + 1).trim();
    } else {
      const sepIdx = item.search(/[=:：]/);
      if (sepIdx > 0) {
        key = item.slice(0, sepIdx).trim();
        label = item.slice(sepIdx + 1).trim();
      } else {
        const compact = /^([+-]?\d+)\s*(.+)$/.exec(item);
        if (compact) {
          key = compact[1].trim();
          label = compact[2].trim();
        }
      }
    }
    if (key && label) entries.push({ key, label });
  }
  return entries;
}

function parseTableColumn(spec) {
  const text = String(spec || "").trim();
  if (!text) return null;
  const dot = text.indexOf(".");
  if (dot >= 0) {
    const targetTable = text.slice(0, dot).trim();
    const targetColumn = text.slice(dot + 1).trim();
    if (isIdent(targetTable) && isIdent(targetColumn)) {
      return { targetTable, targetColumn };
    }
    return null;
  }
  return isIdent(text) ? { targetTable: text, targetColumn: "" } : null;
}

export function parseTokenExtractorSpec(extractor) {
  const text = String(extractor || "").trim();
  const match = /^([,，|])\s*#(\d+)(?:\s*[:：]\s*(.+))?$/.exec(text);
  if (!match) return null;
  const delimiter = match[1] === "|" ? "|" : ",";
  const oneBased = Number(match[2]);
  if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > 65) return null;
  const index = oneBased - 1;
  const rawPrefix = match[3] == null ? "" : match[3].trim();
  if (rawPrefix) {
    const prefix = rawPrefix.endsWith("*") ? rawPrefix.slice(0, -1).trim() : rawPrefix;
    if (!isPrefixAtom(prefix)) return null;
    return {
      delimiter,
      oneBased,
      index,
      prefix,
      parser: normalizeReferenceParser({ type: "prefixed", prefix, delimiter, index }),
    };
  }
  return {
    delimiter,
    oneBased,
    index,
    prefix: "",
    parser: normalizeReferenceParser({ type: "token", delimiter, index }),
  };
}

export function parseListExtractor(extractor) {
  const text = String(extractor || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "json") return normalizeReferenceParser({ type: "keys", delimiter: "json" });
  if (text === "," || text === "，" || lower === "comma") return normalizeReferenceParser({ type: "keys", delimiter: "," });
  if (text === "|" || lower === "pipe") return normalizeReferenceParser({ type: "keys", delimiter: "|" });
  if (text.startsWith("$")) {
    return validJsonPath(text)
      ? normalizeReferenceParser({ type: "jsonPaths", paths: [text], exclude: [] })
      : null;
  }
  const tokenSpec = parseTokenExtractorSpec(text);
  if (tokenSpec) return tokenSpec.parser;
  if (text.endsWith("*")) {
    const prefix = text.slice(0, -1).trim();
    return isPrefixAtom(prefix)
      ? normalizeReferenceParser({ type: "prefixed", prefix })
      : null;
  }
  return isIdent(text) ? normalizeReferenceParser({ type: "json", member: text }) : null;
}

function parseRelationSpecsWithKind(body, kind) {
  const specs = [];
  for (const rawItem of String(body || "").split(/[;；]/)) {
    const item = rawItem.trim();
    if (!item) continue;
    const atIdx = item.indexOf("@");
    const targetPart = atIdx >= 0 ? item.slice(0, atIdx).trim() : item;
    const extractorPart = atIdx >= 0 ? item.slice(atIdx + 1).trim() : "";
    const target = parseTableColumn(targetPart);
    if (!target) continue;
    let parser = null;
    if (extractorPart) {
      parser = parseListExtractor(extractorPart);
      if (!parser) continue;
    }
    specs.push({
      targetTable: target.targetTable,
      targetColumn: target.targetColumn,
      kind,
      extractor: extractorPart,
      parser,
    });
  }
  return specs;
}

function parseRefSpecs(body) {
  if (String(body || "").includes("@")) {
    return parseRelationSpecsWithKind(body, "value");
  }
  const specs = [];
  for (const item of String(body || "").split(/[,，;；]/)) {
    const target = parseTableColumn(item);
    if (!target) continue;
    specs.push({
      targetTable: target.targetTable,
      targetColumn: target.targetColumn,
      kind: "value",
      extractor: "",
      parser: null,
    });
  }
  return specs;
}

function parseListSpecs(body) {
  return parseRelationSpecsWithKind(body, "list");
}

function parseSlotLabels(body) {
  const labels = [];
  for (const rawItem of String(body || "").split(/[,，;；、\r\n]/)) {
    let item = rawItem.trim();
    if (!item) continue;
    const prefixed = /^#?\d+\s*(?:->|→|=|[:：])\s*(.+)$/.exec(item);
    if (prefixed && prefixed[1].trim()) {
      item = prefixed[1].trim();
    }
    if (item) labels.push(item);
  }
  return labels;
}

function parseTag(inner) {
  const trimmed = String(inner || "").trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (trimmed === "无关联" || lower === "none") {
    return { kind: "noRelation" };
  }
  const split = splitHeader(trimmed);
  if (!split) return null;
  const [header, body] = split;
  const headerLower = header.toLowerCase();
  if ((header === "无关联" || headerLower === "none") && !body) {
    return { kind: "noRelation" };
  }
  if (header === "枚举" || headerLower === "enum") {
    const entries = parseEnumEntries(body);
    return entries.length ? { kind: "enum", entries } : null;
  }
  if (header === "数组位" || header === "位置" || headerLower === "slots" || headerLower === "tuple") {
    const slots = parseSlotLabels(body);
    return slots.length ? { kind: "slots", slots } : null;
  }
  if (header === "关联" || headerLower === "ref") {
    const relations = parseRefSpecs(body);
    return relations.length ? { kind: "relation", relations } : null;
  }
  if (header === "列表关联" || headerLower === "list") {
    const relations = parseListSpecs(body);
    return relations.length ? { kind: "relation", relations } : null;
  }
  return null;
}

export function parseCommentDirective(comment) {
  const blocks = extractBracketBlocks(comment);
  const parsed = [];
  const tags = [];
  for (const block of blocks) {
    const tag = parseTag(block.inner);
    if (!tag) continue;
    parsed.push(tag);
    tags.push({ start: block.start, end: block.end, raw: block.raw });
  }
  if (!parsed.length) {
    return { hasDirective: false, kind: "none", entries: [], slots: [], relations: [], tags: [] };
  }
  if (parsed.some((item) => item.kind === "noRelation")) {
    return { hasDirective: true, kind: "noRelation", entries: [], slots: [], relations: [], tags };
  }
  const entries = [];
  for (const item of parsed) {
    if (item.kind === "enum") entries.push(...item.entries);
  }
  if (entries.length) {
    return { hasDirective: true, kind: "enum", entries, slots: [], relations: [], tags };
  }
  const slots = [];
  for (const item of parsed) {
    if (item.kind === "slots") slots.push(...item.slots);
  }
  if (slots.length) {
    return { hasDirective: true, kind: "slots", entries: [], slots, relations: [], tags };
  }
  const relations = [];
  const seen = new Set();
  for (const item of parsed) {
    if (item.kind !== "relation") continue;
    for (const rel of item.relations) {
      const sig = `${rel.kind}:${rel.targetTable.toLowerCase()}.${rel.targetColumn.toLowerCase()}:${rel.extractor}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      relations.push(rel);
    }
  }
  return { hasDirective: true, kind: "relation", entries: [], slots: [], relations, tags };
}

export function stripCommentDirectives(comment) {
  const text = String(comment ?? "");
  const { tags } = parseCommentDirective(text);
  if (!tags.length) return text.trim();
  let result = "";
  let cursor = 0;
  for (const tag of tags) {
    result += text.slice(cursor, tag.start);
    cursor = tag.end;
  }
  result += text.slice(cursor);
  return result
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatCommentDirective(spec) {
  if (!spec || spec.kind === "none") return "";
  if (spec.kind === "noRelation") return "[无关联]";
  if (spec.kind === "enum") {
    const valid = (Array.isArray(spec.entries) ? spec.entries : [])
      .map((entry) => ({
        key: String(entry?.key ?? "").trim(),
        label: String(entry?.label ?? "").trim(),
      }))
      .filter((entry) => entry.key && entry.label);
    if (!valid.length) return "";
    return `[枚举: ${valid.map((entry) => `${entry.key}=${entry.label}`).join(", ")}]`;
  }
  if (spec.kind === "slots") {
    const valid = (Array.isArray(spec.slots) ? spec.slots : [])
      .map((label) => String(label ?? "").trim())
      .filter(Boolean);
    if (!valid.length) return "";
    return `[数组位: ${valid.join(", ")}]`;
  }
  if (spec.kind === "value" || spec.kind === "list") {
    const table = String(spec.targetTable ?? "").trim();
    const column = String(spec.targetColumn ?? "").trim();
    if (!isIdent(table)) return "";
    if (column && !isIdent(column)) return "";
    const target = column ? `${table}.${column}` : table;
    if (spec.kind === "value") return `[关联: ${target}]`;
    const extractor = String(spec.extractor ?? "").trim();
    if (extractor) {
      if (!parseListExtractor(extractor)) return "";
      return `[列表关联: ${target} @ ${extractor}]`;
    }
    return `[列表关联: ${target}]`;
  }
  return "";
}

export function composeCommentWithDirective(prose, spec) {
  const cleanProse = stripCommentDirectives(prose);
  const tag = formatCommentDirective(spec);
  if (!tag) return cleanProse;
  if (!cleanProse) return tag;
  return cleanProse.includes("\n") ? `${cleanProse}\n${tag}` : `${cleanProse} ${tag}`;
}

export function resolveCellEnumPreview(rawValue, comment) {
  const directive = parseCommentDirective(comment);
  if (directive.kind !== "enum" || !directive.entries.length) return [];
  const raw = String(rawValue ?? "").trim();
  if (!raw || raw === "null" || raw === "NULL") return [];
  const lookup = new Map();
  for (const entry of directive.entries) {
    const folded = entry.key.toLowerCase();
    if (!lookup.has(folded)) lookup.set(folded, entry);
  }
  const mapScalar = (token, { suppressSentinels = true } = {}) => {
    const value = String(token ?? "").trim();
    if (!value) return null;
    const hit = lookup.get(value.toLowerCase());
    if (hit) return { value, label: hit.label, state: "enum" };
    if (suppressSentinels && (value === "0" || value === "-1")) return null;
    return { value, label: "", state: "unmapped" };
  };
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" || typeof item === "number")) {
        return parsed.map((item) => mapScalar(item, { suppressSentinels: false })).filter(Boolean);
      }
    } catch {
      // Fall through to scalar lookup.
    }
  }
  const single = mapScalar(raw);
  return single ? [single] : [];
}

function formatSlotScalar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).trim();
}

export function resolveCellSlotPreview(rawValue, comment) {
  const directive = parseCommentDirective(comment);
  if (directive.kind !== "slots" || !directive.slots.length) return [];
  const raw = String(rawValue ?? "").trim();
  if (!raw || raw === "null" || raw === "NULL" || raw === "[]") return [];

  let items = null;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (parsed.every((item) => item === null || typeof item !== "object")) {
          items = parsed.map(formatSlotScalar);
        }
      }
    } catch {
      items = null;
    }
  } else if (raw.includes("|")) {
    items = raw.split("|").map((part) => part.trim());
  } else if (raw.includes(",")) {
    items = raw.split(",").map((part) => part.trim());
  }
  if (!items || !items.length) return [];
  return items.map((value, index) => {
    const label = directive.slots[index] || "";
    return {
      index: index + 1,
      label,
      value,
      state: label ? "slot" : "unmapped",
    };
  });
}

// Extract candidate ordered slot labels from legacy prose comments such as
// "依次对应N/R/SR/SSR/UR/SUR" or "依次为生命、攻击、防御".
export function suggestSlotLabelsFromComment(comment) {
  const prose = stripCommentDirectives(comment);
  if (!prose) return [];

  const cueMatch = /(?:依次对应|依次为|依次代表|分别为|顺序为|按顺序|各位对应|各位为)[：:\s]*([^；;。.)）\n]+)/.exec(prose);
  if (cueMatch) {
    const body = cueMatch[1].trim();
    const parts = body
      .split(/[\/、,，|]+/)
      .map((part) => part.trim())
      .filter((part) => part && part.length <= 24);
    if (parts.length >= 2) return parts;
  }

  for (const match of prose.matchAll(/([\u4e00-\u9fa5A-Za-z0-9_]{1,16}(?:\/[\u4e00-\u9fa5A-Za-z0-9_]{1,16}){1,15})/g)) {
    const parts = match[1].split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) return parts;
  }

  const enums = suggestEnumEntriesFromComment(prose);
  if (enums.length >= 2) return enums.map((entry) => entry.label);
  return [];
}

// Extract candidate enum key/label pairs from legacy free-text comments such as
// "(1N、2R、3SR、4SSR、5UR、6SUR)", "1蓝、2紫、3橙", "0正常1封禁", or "1=主动, 2=被动".
export function suggestEnumEntriesFromComment(comment) {
  const prose = stripCommentDirectives(comment);
  if (!prose) return [];

  // Prefer explicit separator runs (e.g. "1=蓝, 2=紫, 3=橙" or "1:主动 2:被动").
  const separated = [];
  for (const match of prose.matchAll(/(?:^|[\s(（:：,，;；、])([+-]?\d+)\s*(?:=|->|→|[:：-])\s*([^\s,，;；、)）(（。]+)/g)) {
    const key = match[1].trim();
    const label = match[2].trim();
    if (key && label && !/^\d+$/.test(label)) {
      separated.push({ key, label });
    }
  }
  if (dedupeEntries(separated).length >= 2) {
    return dedupeEntries(separated);
  }

  // Fallback: compact runs like "1N、2R、3SR、4SSR、5UR、6SUR" or "0正常1封禁".
  const compactRuns = [];
  const runRe = /(?:[+-]?\d+\s*[\u4e00-\u9fa5A-Za-z_]{1,12}(?:\s*[,，、;；/]\s*|\s+)?){2,}/g;
  for (const runMatch of prose.matchAll(runRe)) {
    const chunk = runMatch[0];
    const items = [];
    for (const pair of chunk.matchAll(/([+-]?\d+)\s*([\u4e00-\u9fa5A-Za-z_]{1,12})/g)) {
      const key = pair[1].trim();
      const label = pair[2].trim();
      // Skip units like "100px" or "10级" if not part of a multi-key series.
      if (key && label) items.push({ key, label });
    }
    const clean = dedupeEntries(items);
    if (clean.length >= 2) compactRuns.push(clean);
  }
  if (!compactRuns.length) return [];
  compactRuns.sort((a, b) => b.length - a.length);
  return compactRuns[0];
}

function dedupeEntries(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const folded = item.key.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(item);
  }
  return out;
}

export function suggestPrefixFromSample(sampleValue) {
  const text = String(sampleValue ?? "").trim();
  if (!text || text.startsWith("function")) return "";
  const tokens = text.split(/[,|;\s[\]"]+/).map((part) => part.trim()).filter(Boolean);
  for (const token of tokens) {
    const match = /^([A-Za-z][A-Za-z0-9]*[_:-])(\d+)$/.exec(token);
    if (match && isPrefixAtom(match[1])) return match[1];
  }
  return "";
}

export function resolveListSamplePreview(sampleValue, extractor) {
  const text = String(sampleValue ?? "").trim();
  if (!text) return null;
  let parser = parseListExtractor(extractor);
  if (!parser && !String(extractor || "").trim()) {
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          if (parsed.every((item) => typeof item === "string" || typeof item === "number")) {
            parser = normalizeReferenceParser({ type: "keys", delimiter: "json" });
          } else if (parsed.length && parsed.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
            const firstKeys = Object.keys(parsed[0]);
            const idKey = firstKeys.find((key) => key.toLowerCase() === "id")
              || firstKeys.find((key) => key.toLowerCase().endsWith("id"));
            if (idKey) parser = normalizeReferenceParser({ type: "json", member: idKey });
          }
        }
      } catch {
        parser = null;
      }
    } else if (text.includes("|")) {
      parser = normalizeReferenceParser({ type: "keys", delimiter: "|" });
    } else if (text.includes(",")) {
      parser = normalizeReferenceParser({ type: "keys", delimiter: "," });
    }
  }
  if (!parser) return null;
  const extracted = parseReferenceValues(text, parser);
  return Array.isArray(extracted) ? extracted : [];
}

export function formatAgentMeaningClipboard({
  database = "",
  tableName = "",
  columnName = "",
  currentComment = "",
  nextComment = "",
  sampleValue = "",
} = {}) {
  const target = [database, tableName, columnName].filter(Boolean).join(".");
  const lines = [
    `[Blackcat 字段含义规范]`,
    `字段: ${target || columnName || tableName}`,
  ];
  if (sampleValue !== "" && sampleValue != null) {
    lines.push(`当前单元格示例值: ${String(sampleValue)}`);
  }
  if (currentComment) {
    lines.push(`原备注: ${currentComment}`);
  }
  lines.push(`建议规范备注: ${nextComment || "(空)"}`);
  return lines.join("\n");
}
