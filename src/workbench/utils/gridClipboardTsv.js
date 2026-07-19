function normalizedClipboardText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function encodeCell(value) {
  const text = String(value ?? "");
  return /[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeGridTsv(matrix = []) {
  if (!Array.isArray(matrix) || matrix.length === 0) return "";
  return matrix
    .map((row) => (Array.isArray(row) ? row : []).map(encodeCell).join("\t"))
    .join("\n");
}

export function parseGridTsv(text) {
  const source = normalizedClipboardText(text);
  if (!source || /^\n+$/.test(source)) return [];

  const matrix = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (character === '"' && cell === "") {
      quoted = true;
    } else if (character === "\t") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (row.length > 0 || cell !== "" || !source.endsWith("\n")) {
    row.push(cell);
    matrix.push(row);
  }
  return matrix;
}
