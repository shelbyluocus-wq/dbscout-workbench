import { getOptimisticCellValue } from "../editState.js";
import { buildRowKey } from "./rowIdentity.js";
import { highlightSearchText, matchSearchText } from "./searchMatch.js";
import { normalizeTableFilterMode } from "./tableFilterMode.js";

const highlightCacheByTab = new WeakMap();

export function displayCellValue(editState, tab, row, column, rowKey) {
  const key = rowKey || buildRowKey(tab, row);
  const optimistic = getOptimisticCellValue(editState, tab.tableKey || tab.tableName, key, column);
  if (optimistic != null) return optimistic;
  if (row?.[column] == null) return "NULL";
  return String(row[column]);
}

export function highlightCell(editState, tab, row, column, rowKey) {
  return highlightCellResult(editState, tab, row, column, rowKey).html;
}

export function highlightCellResult(editState, tab, row, column, rowKey) {
  const text = displayCellValue(editState, tab, row, column, rowKey);
  const query = (tab?.searchQuery ?? tab?.filter ?? "").trim();
  if (!query || text === "NULL") return { html: escapeHtml(text), matched: false };
  const mode = normalizeTableFilterMode(tab.filterMode);
  const cacheKey = [
    rowKey || "",
    column || "",
    query,
    mode,
    text,
    editState?.mutationVersion || 0,
  ].join("\u001f");
  let tabCache = highlightCacheByTab.get(tab);
  if (!tabCache) {
    tabCache = new Map();
    highlightCacheByTab.set(tab, tabCache);
  }
  const cached = tabCache.get(cacheKey);
  if (cached) return cached;
  const match = matchSearchText(text, query, { mode });
  const result = match.matched
    ? { html: highlightSearchText(text, query, { mode }), matched: true }
    : { html: escapeHtml(text), matched: false };
  tabCache.set(cacheKey, result);
  return result;
}

export function escapeHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseDetailJson(value) {
  const raw = String(value ?? "");
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "NULL") return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return { raw, parsed };
  } catch {}
  return null;
}

export function formatDetailValue(value) {
  const raw = String(value ?? "");
  const json = parseDetailJson(raw);
  if (json) {
    const text = JSON.stringify(json.parsed, null, 2);
    return { kind: "json", text, html: highlightJson(text) };
  }
  if (looksLikeTypeScript(raw)) return { kind: "typescript", text: raw, html: highlightTypeScript(raw) };
  return { kind: "text", text: raw, html: escapeHtml(raw) };
}

export function highlightDetailValue(value) {
  const raw = String(value ?? "");
  const json = parseDetailJson(raw);
  if (json) return { kind: "json", text: raw, html: highlightJson(raw) };
  if (looksLikeTypeScript(raw)) return { kind: "typescript", text: raw, html: highlightTypeScript(raw) };
  return { kind: "text", text: raw, html: escapeHtml(raw) };
}

export function isDetailJson(value) {
  return parseDetailJson(value) != null;
}

// 详情区展示：JSON 可在「缩进+上色」和「原文+上色」之间切换；函数/普通文本
// 始终原文上色。sourceText 是应写回数据库的值，viewText 只影响看见的样子。
export function resolveDetailEditorView(value, { prettyJson = true } = {}) {
  const raw = String(value ?? "");
  const source = highlightDetailValue(raw);
  if (source.kind !== "json") {
    return { kind: source.kind, sourceText: raw, viewText: raw, html: source.html };
  }
  const viewText = prettyJson ? formatDetailValue(raw).text : raw;
  return { kind: "json", sourceText: raw, viewText, html: highlightDetailValue(viewText).html };
}

function looksLikeTypeScript(value) {
  return /\b(function|const|let|return|async|await|interface|type|class|export|import)\b|=>/.test(value);
}

function highlightJson(text) {
  return text.replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g,
    (match, key, string, number, literal) => {
      if (key) return `<span class="wb-token-key">${escapeHtml(key)}</span>`;
      if (string) return `<span class="wb-token-string">${escapeHtml(string)}</span>`;
      if (number) return `<span class="wb-token-number">${escapeHtml(number)}</span>`;
      if (literal) return `<span class="wb-token-literal">${escapeHtml(literal)}</span>`;
      return escapeHtml(match);
    },
  );
}

function highlightTypeScript(text) {
  const tokenPattern = /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:function|return|const|let|var|async|await|if|else|for|while|switch|case|break|true|false|null|undefined|type|interface|class|new|export|import|from|extends|implements)\b)|(\b[A-Za-z_$][\w$]*(?=\s*(?:\(|=\s*(?:async\s*)?(?:<[^>]+>\s*)?\()))/gm;
  let html = "";
  let cursor = 0;
  for (const match of text.matchAll(tokenPattern)) {
    html += escapeHtml(text.slice(cursor, match.index));
    const [value, comment, string, number, keyword, fnName] = match;
    const className = comment ? "wb-token-comment" : string ? "wb-token-string" : number ? "wb-token-number" : keyword ? "wb-token-keyword" : fnName ? "wb-token-function" : "";
    html += className ? `<span class="${className}">${escapeHtml(value)}</span>` : escapeHtml(value);
    cursor = match.index + value.length;
  }
  return html + escapeHtml(text.slice(cursor));
}
