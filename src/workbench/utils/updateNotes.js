// Release notes arrive as plain text, one change per line, usually numbered
// ("1. ...") and sometimes bulleted. The update notice and dialog draw their
// own markers, so the author's are stripped here.

// "0.1.71 fixes ..." starts with a version, not a list number.
const NUMBER_MARKER = /^\d{1,3}[.、)）](?!\d)\s*/;
const BULLET_MARKER = /^[-*•·]\s*/;

export function parseUpdateNotes(body) {
  const lines = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let numbered = 0;
  const items = [];
  for (const line of lines) {
    const withoutNumber = line.replace(NUMBER_MARKER, "");
    if (withoutNumber !== line) numbered += 1;
    const text = withoutNumber === line ? line.replace(BULLET_MARKER, "") : withoutNumber;
    if (text) items.push(text);
  }
  return {
    items,
    // Numbers are shown only when the author numbered every line.
    ordered: items.length > 1 && numbered === lines.length,
  };
}

export function updateNoteListClass(notes) {
  return {
    "is-single": notes.items.length === 1,
    "is-unordered": notes.items.length > 1 && !notes.ordered,
  };
}
