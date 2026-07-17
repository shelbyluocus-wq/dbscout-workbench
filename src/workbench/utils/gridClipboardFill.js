function targetShape(rowCount, columnCount) {
  return {
    rowCount: Number(rowCount),
    columnCount: Number(columnCount),
  };
}

function sourceShape(matrix) {
  if (!Array.isArray(matrix)) {
    return { rowCount: 0, columnCount: 0, columnCounts: [], rectangular: false };
  }

  const columnCounts = matrix.map((row) => Array.isArray(row) ? row.length : -1);
  const columnCount = columnCounts[0] ?? 0;
  return {
    rowCount: matrix.length,
    columnCount,
    columnCounts,
    rectangular: matrix.length > 0
      && columnCount > 0
      && columnCounts.every((count) => count === columnCount),
  };
}

/**
 * Repeats a rectangular clipboard matrix to fill a rectangular selection.
 * Both target dimensions must be exact multiples of the source dimensions so
 * paste never silently crops a copied pattern.
 */
export function tileClipboardMatrix(matrix, rowCount, columnCount) {
  const source = sourceShape(matrix);
  const target = targetShape(rowCount, columnCount);

  if (!source.rectangular) {
    return { ok: false, reason: "irregular-source", source, target };
  }

  if (!Number.isInteger(target.rowCount)
    || !Number.isInteger(target.columnCount)
    || target.rowCount <= 0
    || target.columnCount <= 0) {
    return { ok: false, reason: "invalid-target", source, target };
  }

  if (target.rowCount % source.rowCount !== 0
    || target.columnCount % source.columnCount !== 0) {
    return { ok: false, reason: "incompatible-size", source, target };
  }

  const tiled = Array.from({ length: target.rowCount }, (_, rowIndex) => (
    Array.from({ length: target.columnCount }, (_, columnIndex) => (
      matrix[rowIndex % source.rowCount][columnIndex % source.columnCount]
    ))
  ));

  return { ok: true, matrix: tiled, source, target };
}

/**
 * Fills a selected range while allowing a one-row or one-column selection to
 * act as a repetition axis. For example, a 4x1 selection with a 1x2 source
 * expands to a 4x2 paste area, repeating the copied row four times.
 */
export function tileClipboardMatrixToSelection(matrix, rowCount, columnCount) {
  const selection = targetShape(rowCount, columnCount);
  const source = sourceShape(matrix);
  const targetRowCount = source.rectangular && selection.rowCount === 1
    ? Math.max(selection.rowCount, source.rowCount)
    : selection.rowCount;
  const targetColumnCount = source.rectangular && selection.columnCount === 1
    ? Math.max(selection.columnCount, source.columnCount)
    : selection.columnCount;
  return {
    ...tileClipboardMatrix(matrix, targetRowCount, targetColumnCount),
    selection,
  };
}
