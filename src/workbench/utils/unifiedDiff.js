// Unified diffs (as `svn diff` prints them) turned into display rows, after
// Cairn's diff view: hunks with old and new line numbers, a side-by-side
// layout that pairs removed lines with the added lines that replaced them,
// and an in-line highlight of the part of a changed line that differs.

export const DIFF_LINE = Object.freeze({ CONTEXT: "context", ADDED: "added", REMOVED: "removed" });
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const BINARY_MARKERS = [/^Cannot display: file marked as a binary type/i, /^svn:mime-type = application\/octet-stream/i, /^Binary files /];
const TAB_WIDTH = 4;

/**
 * The ranges that differ after trimming the common prefix and suffix, or
 * null when the lines are equal or too different (less than a third shared)
 * for a highlight to help.
 */
export function differingRanges(a, b) {
  if ((!a && !b) || a === b) return null;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  if (prefix > 0 && /[\uD800-\uDBFF]/.test(a[prefix - 1])) prefix -= 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(a[a.length - suffix])) suffix -= 1;
  const longest = Math.max(a.length, b.length);
  if (!longest || (prefix + suffix) / longest < 0.34) return null;
  return { old: { start: prefix, end: a.length - suffix }, new: { start: prefix, end: b.length - suffix } };
}

function highlightPairs(lines) {
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== DIFF_LINE.REMOVED) {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (index < lines.length && lines[index].kind === DIFF_LINE.REMOVED) index += 1;
    const addedStart = index;
    while (index < lines.length && lines[index].kind === DIFF_LINE.ADDED) index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < pairs; offset += 1) {
      const removed = lines[removedStart + offset];
      const added = lines[addedStart + offset];
      const ranges = differingRanges(removed.text, added.text);
      if (!ranges) continue;
      removed.highlight = ranges.old;
      added.highlight = ranges.new;
    }
  }
  return lines;
}

/** Hunk lines ("@@ … @@", " context", "-old", "+new") with their line numbers. */
export function parseHunks(lines) {
  const hunks = [];
  let current = null;
  let oldNumber = 0;
  let newNumber = 0;
  for (const raw of lines) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[3]);
      current = { header: raw, oldStart: oldNumber, newStart: newNumber, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" belongs to the line before it.
      const last = current.lines.at(-1);
      if (last) last.missingNewline = true;
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") current.lines.push({ kind: DIFF_LINE.ADDED, text, oldNumber: null, newNumber: newNumber++ });
    else if (marker === "-") current.lines.push({ kind: DIFF_LINE.REMOVED, text, oldNumber: oldNumber++, newNumber: null });
    else current.lines.push({ kind: DIFF_LINE.CONTEXT, text: marker === " " ? text : raw, oldNumber: oldNumber++, newNumber: newNumber++ });
  }
  for (const hunk of hunks) highlightPairs(hunk.lines);
  return hunks;
}

/**
 * A whole `svn diff` output: one entry per "Index:" section with its path,
 * hunks, property changes and whether svn called it binary.
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let current = null;
  let section = "content";
  let body = [];
  const flush = () => {
    if (!current) return;
    current.hunks = parseHunks(body);
    files.push(current);
  };
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("Index: ")) {
      flush();
      current = { path: line.slice(7).trim(), hunks: [], properties: [], binary: false };
      body = [];
      section = "content";
      continue;
    }
    if (!current) continue;
    if (BINARY_MARKERS.some((pattern) => pattern.test(line))) current.binary = true;
    if (line.startsWith("Property changes on: ")) {
      section = "properties";
      continue;
    }
    if (section === "properties") {
      const property = /^(Added|Deleted|Modified|Name): (.+)$/.exec(line);
      if (property) current.properties.push({ change: property[1] === "Name" ? "Modified" : property[1], name: property[2], lines: [] });
      else if (/^\s*[+-]\s?/.test(line) && current.properties.length) {
        const trimmed = line.trimStart();
        current.properties.at(-1).lines.push({ kind: trimmed[0] === "+" ? DIFF_LINE.ADDED : DIFF_LINE.REMOVED, text: trimmed.slice(1).trimStart() });
      }
      continue;
    }
    if (line.startsWith("@@") || /^[ +\-\\]/.test(line)) {
      if (!line.startsWith("+++") && !line.startsWith("---")) body.push(line);
    }
  }
  flush();
  return files;
}

/** Tabs expanded to the next stop, with the highlight moved along. */
export function expandTabs(text, highlight = null) {
  if (!text.includes("\t")) return { text, highlight };
  let result = "";
  let start = 0;
  let end = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (highlight) {
      if (index === highlight.start) start = result.length;
      if (index === highlight.end) end = result.length;
    }
    if (index === text.length) break;
    result += text[index] === "\t" ? " ".repeat(TAB_WIDTH - (result.length % TAB_WIDTH)) : text[index];
  }
  return { text: result, highlight: highlight ? { start, end } : null };
}

function cell(line, old) {
  if (!line) return null;
  const { text, highlight } = expandTabs(line.text, line.highlight || null);
  return { kind: line.kind, number: old ? line.oldNumber : line.newNumber, text, highlight, missingNewline: Boolean(line.missingNewline) };
}

/** A hunk in two columns, removed lines beside the added lines that replaced them. */
export function sideBySideRows(hunk) {
  const rows = [];
  const lines = hunk.lines;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === DIFF_LINE.CONTEXT) {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed = [];
    const added = [];
    while (index < lines.length && lines[index].kind === DIFF_LINE.REMOVED) removed.push(lines[index++]);
    while (index < lines.length && lines[index].kind === DIFF_LINE.ADDED) added.push(lines[index++]);
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
      rows.push({ left: removed[offset] || null, right: added[offset] || null });
    }
  }
  return rows;
}

/**
 * Display rows for a file in the "split" or "unified" layout. Each row has a
 * `type` ("hunk", "property", "split" or "line"); the first row of every
 * block of changes is marked `startsChange` for next / previous navigation.
 */
export function diffRows(file, layout = "split") {
  const rows = [];
  for (const hunk of file?.hunks || []) {
    rows.push({ type: "hunk", text: hunk.header });
    let previousWasChange = false;
    if (layout === "split") {
      for (const row of sideBySideRows(hunk)) {
        const change = row.left?.kind !== DIFF_LINE.CONTEXT || row.right?.kind !== DIFF_LINE.CONTEXT;
        rows.push({ type: "split", left: cell(row.left, true), right: cell(row.right, false), change, startsChange: change && !previousWasChange });
        previousWasChange = change;
      }
    } else {
      for (const line of hunk.lines) {
        const change = line.kind !== DIFF_LINE.CONTEXT;
        rows.push({
          type: "line",
          cell: cell(line, line.kind !== DIFF_LINE.ADDED),
          oldNumber: line.oldNumber,
          newNumber: line.newNumber,
          change,
          startsChange: change && !previousWasChange,
        });
        previousWasChange = change;
      }
    }
  }
  for (const property of file?.properties || []) {
    rows.push({ type: "property", change: property.change, name: property.name });
    for (const line of property.lines) {
      const value = { kind: line.kind, number: null, text: line.text, highlight: null, missingNewline: false };
      rows.push(layout === "split"
        ? { type: "split", left: line.kind === DIFF_LINE.ADDED ? null : value, right: line.kind === DIFF_LINE.REMOVED ? null : value, change: true, startsChange: false }
        : { type: "line", cell: value, oldNumber: null, newNumber: null, change: true, startsChange: false });
    }
  }
  return rows;
}

/** Added and removed line counts of a parsed file. */
export function diffStats(file) {
  let added = 0;
  let removed = 0;
  for (const hunk of file?.hunks || []) {
    for (const line of hunk.lines) {
      if (line.kind === DIFF_LINE.ADDED) added += 1;
      else if (line.kind === DIFF_LINE.REMOVED) removed += 1;
    }
  }
  return { added, removed };
}
