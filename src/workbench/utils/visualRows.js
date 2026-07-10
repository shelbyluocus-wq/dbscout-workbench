function nonNegativeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function upperBound(groups, dataIndex) {
  let low = 0;
  let high = groups.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (groups[middle].anchor <= dataIndex) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createVisualRowModel({
  dataRowCount = 0,
  dataRowAt = () => undefined,
  insertRows = [],
  makeInsertRow = (insertRow) => insertRow,
} = {}) {
  const dataCount = nonNegativeCount(dataRowCount);
  const anchored = new Map();
  const trailing = [];

  for (const insertRow of Array.isArray(insertRows) ? insertRows : []) {
    const anchor = Number(insertRow?.anchorIndex);
    if (insertRow?.anchorIndex == null || !Number.isInteger(anchor) || anchor < 0 || anchor >= dataCount) {
      trailing.push(insertRow);
      continue;
    }
    if (!anchored.has(anchor)) anchored.set(anchor, []);
    anchored.get(anchor).push(insertRow);
  }

  let prefix = 0;
  const groups = [...anchored.entries()]
    .sort(([left], [right]) => left - right)
    .map(([anchor, rows]) => {
      const group = { anchor, rows, prefixBefore: prefix, visualStart: anchor + prefix };
      prefix += rows.length;
      return group;
    });
  const groupByAnchor = new Map(groups.map((group) => [group.anchor, group]));
  const anchoredCount = prefix;
  const trailingStart = dataCount + anchoredCount;
  const length = trailingStart + trailing.length;
  const insertIndexById = new Map();

  for (const group of groups) {
    group.rows.forEach((row, offset) => insertIndexById.set(row?.id, group.visualStart + offset));
  }
  trailing.forEach((row, offset) => insertIndexById.set(row?.id, trailingStart + offset));

  function anchoredCountAtOrBefore(dataIndex) {
    const end = upperBound(groups, dataIndex);
    if (end === 0) return 0;
    const last = groups[end - 1];
    return last.prefixBefore + last.rows.length;
  }

  function visualIndexOfData(dataIndex) {
    const normalized = Number(dataIndex);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized >= dataCount) return -1;
    return normalized + anchoredCountAtOrBefore(normalized);
  }

  function insertEntry(insertRow) {
    return {
      type: "insert",
      rowId: insertRow?.id,
      insertRow,
      row: makeInsertRow(insertRow),
    };
  }

  function entryAt(visualIndex) {
    const normalized = Number(visualIndex);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized >= length) return undefined;
    if (normalized >= trailingStart) return insertEntry(trailing[normalized - trailingStart]);

    let low = 0;
    let high = dataCount - 1;
    let dataIndex = -1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const middleVisual = visualIndexOfData(middle);
      if (middleVisual >= normalized) {
        dataIndex = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }
    if (dataIndex < 0) return undefined;
    const dataVisualIndex = visualIndexOfData(dataIndex);
    if (dataVisualIndex === normalized) {
      return { type: "data", dataIndex, row: dataRowAt(dataIndex) };
    }
    const group = groupByAnchor.get(dataIndex);
    const insertRow = group?.rows?.[normalized - group.visualStart];
    return insertRow ? insertEntry(insertRow) : undefined;
  }

  function at(index) {
    const normalized = Number(index);
    if (!Number.isInteger(normalized)) return undefined;
    return entryAt(normalized < 0 ? length + normalized : normalized);
  }

  function* iterateRange(start = 0, end = length) {
    const from = Math.min(length, nonNegativeCount(start));
    const to = Math.min(length, Math.max(from, nonNegativeCount(end)));
    for (let index = from; index < to; index += 1) yield entryAt(index);
  }

  const model = {
    length,
    at,
    entryAt,
    visualIndexOfData,
    visualIndexOfInsert(rowId) {
      return insertIndexById.get(rowId) ?? -1;
    },
    iterateRange,
    map(callback, thisArg) {
      const output = [];
      for (let index = 0; index < length; index += 1) {
        output.push(callback.call(thisArg, entryAt(index), index, model));
      }
      return output;
    },
    findIndex(predicate, thisArg) {
      for (let index = 0; index < length; index += 1) {
        if (predicate.call(thisArg, entryAt(index), index, model)) return index;
      }
      return -1;
    },
    [Symbol.iterator]() {
      return iterateRange();
    },
  };

  return model;
}
