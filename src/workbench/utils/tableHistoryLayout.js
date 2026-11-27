/**
 * Pure layout helpers for TableChangeHistoryView: primary-key column freezing,
 * column-snapped horizontal reveal, change-map segments, placeholder labels
 * and day grouping of the revision timeline.
 */

export function orderPrimaryKeyColumnsFirst(columns = []) {
  const list = Array.isArray(columns) ? columns : [];
  const keys = list.filter((col) => col?.primaryKey);
  if (!keys.length || keys.every((col, idx) => list[idx] === col)) return list;
  return [...keys, ...list.filter((col) => !col?.primaryKey)];
}

/**
 * Freeze the leading primary-key columns while the frozen block (row numbers
 * included) stays within `maxRatio` of the pane width, so narrow panes keep
 * room for the columns being compared.
 */
export function resolveFrozenColumns({
  columns = [],
  widthOf = () => 0,
  rowNumWidth = 0,
  paneWidth = 0,
  maxRatio = 0.55,
} = {}) {
  const offsets = new Map();
  let width = rowNumWidth;
  let lastName = "";
  const budget = paneWidth > 0 ? paneWidth * maxRatio : Infinity;
  for (const col of columns) {
    if (!col?.primaryKey) break;
    const colWidth = Math.max(0, Number(widthOf(col.name)) || 0);
    if (width + colWidth > budget) break;
    offsets.set(col.name, width);
    width += colWidth;
    lastName = col.name;
  }
  return { offsets, width, lastName };
}

export function isSameFrozenLayout(a, b) {
  if (!a || !b || a.width !== b.width || a.lastName !== b.lastName || a.offsets.size !== b.offsets.size) return false;
  for (const [name, left] of a.offsets) {
    if (b.offsets.get(name) !== left) return false;
  }
  return true;
}

/**
 * Horizontal scroll that reveals `targetCol` beside the frozen block, snapped
 * to a column boundary so no clipped sliver sits against the frozen edge.
 * Returns null when no horizontal movement is needed.
 */
export function resolveColumnRevealScroll({
  columns = [],
  widthOf = () => 0,
  rowNumWidth = 0,
  frozen = { offsets: new Map(), width: rowNumWidth },
  targetCol = "",
  scrollLeft = 0,
  clientWidth = 0,
} = {}) {
  if (!targetCol || !(clientWidth > 0) || frozen.offsets.has(targetCol)) return null;
  const frozenWidth = Math.max(rowNumWidth, Number(frozen.width) || 0);
  const starts = [];
  let left = rowNumWidth;
  let target = null;
  for (const col of columns) {
    const colWidth = Math.max(0, Number(widthOf(col.name)) || 0);
    if (!frozen.offsets.has(col.name)) starts.push(left);
    if (col.name === targetCol) {
      target = { left, width: colWidth };
      break;
    }
    left += colWidth;
  }
  if (!target) return null;
  const viewLeft = scrollLeft + frozenWidth;
  const viewRight = scrollLeft + clientWidth;
  if (target.left >= viewLeft - 0.5 && target.left + target.width <= viewRight + 0.5) return null;
  const usable = Math.max(0, clientWidth - frozenWidth);
  const boundary = starts.find((start) => start + usable >= target.left + target.width) ?? target.left;
  return Math.max(0, boundary - frozenWidth);
}

/**
 * Collapse changed rows into pixel segments of the overview track. Adjacent
 * rows of the same status that touch on the track merge into one segment.
 */
export function buildChangeMapSegments({
  rows = [],
  indices = [],
  trackHeight = 0,
  minHeight = 3,
} = {}) {
  const total = rows.length;
  if (!total || !(trackHeight > 0) || !indices.length) return [];
  const scale = trackHeight / total;
  const segments = [];
  const lastByStatus = new Map();
  for (const index of indices) {
    const row = rows[index];
    if (!row || row.status === "unchanged") continue;
    const top = index * scale;
    const bottom = Math.max(top + minHeight, (index + 1) * scale);
    const prev = lastByStatus.get(row.status);
    if (prev && prev.lastIndex === index - 1 && top <= prev.top + prev.height + 1) {
      prev.height = Math.max(minHeight, (index + 1) * scale - prev.top);
      prev.lastIndex = index;
      prev.count += 1;
      prev.lastRow = row;
      continue;
    }
    const segment = {
      status: row.status,
      top,
      height: bottom - top,
      firstIndex: index,
      lastIndex: index,
      count: 1,
      firstRow: row,
      lastRow: row,
    };
    segments.push(segment);
    lastByStatus.set(row.status, segment);
  }
  for (const segment of segments) {
    segment.top = Math.min(Math.max(0, trackHeight - segment.height), segment.top);
  }
  return segments;
}

/**
 * Display indices whose missing-row placeholder shows its label: the first row
 * of every inserted/deleted run, then every `every` rows inside long runs.
 */
export function buildPlaceholderLabelIndices(rows = [], every = 12) {
  const labelled = new Set();
  let runStatus = "";
  let runStart = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const status = rows[i]?.status;
    if (status !== "inserted" && status !== "deleted") {
      runStatus = "";
      continue;
    }
    if (status !== runStatus) {
      runStatus = status;
      runStart = i;
    }
    if ((i - runStart) % every === 0) labelled.add(i);
  }
  return labelled;
}

function dayKeyOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Group revisions (already newest-first) into consecutive calendar days.
 * Labels: "today" / "yesterday" kinds, otherwise MM-DD (YYYY-MM-DD when the
 * year differs from `nowMs`).
 */
export function groupRevisionsByDay(revisions = [], { nowMs = Date.now(), parseMs = (rev) => rev?.tsMs } = {}) {
  const todayKey = dayKeyOf(nowMs);
  const yesterday = new Date(nowMs);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dayKeyOf(yesterday.getTime());
  const nowYear = new Date(nowMs).getFullYear();
  const groups = [];
  for (const rev of revisions) {
    if (rev?.summaryKind === "monthly" && rev?.summaryPeriod) {
      const key = `month:${rev.summaryPeriod}`;
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        group = { key, kind: "month", label: rev.summaryPeriod, items: [] };
        groups.push(group);
      }
      group.items.push(rev);
      continue;
    }
    const ms = Number(parseMs(rev)) || 0;
    const key = rev?.summaryKind === "daily" && rev?.summaryPeriod
      ? rev.summaryPeriod
      : (ms ? dayKeyOf(ms) : "unknown");
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      let kind = "date";
      let label = "";
      if (key === todayKey) kind = "today";
      else if (key === yesterdayKey) kind = "yesterday";
      else if (key === "unknown") kind = "unknown";
      else {
        const yearNum = Number(key.slice(0, 4)) || (ms ? new Date(ms).getFullYear() : nowYear);
        label = yearNum === nowYear ? key.slice(5) : key;
      }
      group = { key, kind, label, items: [] };
      groups.push(group);
    }
    group.items.push(rev);
  }
  return groups;
}
