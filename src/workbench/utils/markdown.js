/**
 * Lightweight Markdown-to-HTML renderer for agent answers.
 * Supports: paragraphs, line breaks, bold/italic, inline code,
 * fenced code blocks, unordered/ordered lists, blockquotes, links, and tables.
 * Escapes HTML to avoid XSS from model output.
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/**
 * @param {string} markdown
 * @returns {{ html: string, headings: Array<{ level: number, text: string, id: string }> }}
 */
export function renderMarkdown(markdown) {
  if (!markdown) return { html: "", headings: [] };

  const raw = String(markdown).replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  const out = [];
  const headings = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end].startsWith("```")) {
        end++;
      }
      const code = lines.slice(start, end).join("\n");
      const escaped = escapeHtml(code);
      const safeLang = escapeHtml(lang);
      out.push(
        `<pre class="wb-md-pre">${
          lang ? `<div class="wb-md-code-lang">${safeLang}</div>` : ""
        }<code class="wb-md-code${lang ? ` language-${safeLang}` : ""}">${escaped}</code></pre>`
      );
      i = end + 1;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const id = slugify(text);
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}" class="wb-md-h${level}">${inlineRender(text)}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].slice(1).trim());
        i++;
      }
      out.push(`<blockquote class="wb-md-blockquote">${inlineRender(quoteLines.join(" "))}</blockquote>`);
      continue;
    }

    // Pipe table
    if (isTableStart(lines, i)) {
      const headerCells = parseTableRow(lines[i]);
      const alignments = parseTableDelimiter(lines[i + 1], headerCells.length);
      const bodyRows = [];
      i += 2;
      while (i < lines.length) {
        const cells = parseTableRow(lines[i]);
        if (!cells || cells.length === 0) break;
        bodyRows.push(normalizeTableCells(cells, headerCells.length));
        i++;
      }
      out.push(renderTable(headerCells, alignments, bodyRows));
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-*+]\s+/, ""));
        i++;
      }
      out.push(renderList(items, false));
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out.push(renderList(items, true));
      continue;
    }

    // Horizontal rule
    if (/^(---|___|\*\*\*)\s*$/.test(line)) {
      out.push('<hr class="wb-md-hr" />');
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      out.push("");
      i++;
      continue;
    }

    // Paragraph (possibly with hard line breaks)
    const paragraphLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !isTableStart(lines, i) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !/^(---|___|\*\*\*)\s*$/.test(lines[i])
    ) {
      paragraphLines.push(lines[i]);
      i++;
    }
    const paragraph = paragraphLines
      .map((l) => inlineRender(l))
      .join("<br />");
    out.push(`<p class="wb-md-p">${paragraph}</p>`);
  }

  return { html: out.filter(Boolean).join("\n"), headings };
}

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  const headerCells = parseTableRow(lines[index]);
  if (!headerCells || headerCells.length < 2) return false;
  return Boolean(parseTableDelimiter(lines[index + 1], headerCells.length));
}

function parseTableRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.includes("|")) return null;

  let content = trimmed;
  if (content.startsWith("|")) content = content.slice(1);
  if (content.endsWith("|")) content = content.slice(0, -1);

  const cells = [];
  let cell = "";
  let escaping = false;
  for (const char of content) {
    if (escaping) {
      cell += char;
      escaping = false;
    } else if (char === "\\") {
      escaping = true;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  if (escaping) cell += "\\";
  cells.push(cell.trim());

  return cells;
}

function parseTableDelimiter(line, cellCount) {
  const cells = parseTableRow(line);
  if (!cells || cells.length < cellCount) return null;

  const alignments = cells.slice(0, cellCount).map((cell) => {
    const normalized = cell.replace(/\s+/g, "");
    if (!/^:?-{3,}:?$/.test(normalized)) return null;
    const left = normalized.startsWith(":");
    const right = normalized.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });

  return alignments.every(Boolean) ? alignments : null;
}

function normalizeTableCells(cells, count) {
  const next = cells.slice(0, count);
  while (next.length < count) next.push("");
  return next;
}

function tableAlignmentClass(alignment) {
  if (alignment === "right") return " wb-md-cell-align-right";
  if (alignment === "center") return " wb-md-cell-align-center";
  return "";
}

function renderTable(headerCells, alignments, bodyRows) {
  const header = headerCells
    .map((cell, index) => `<th class="${`wb-md-th${tableAlignmentClass(alignments[index])}`.trim()}">${inlineRender(cell)}</th>`)
    .join("");
  const rows = bodyRows
    .map((row) => {
      const cells = row
        .map((cell, index) => `<td class="${`wb-md-td${tableAlignmentClass(alignments[index])}`.trim()}">${inlineRender(cell)}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return [
    '<div class="wb-md-table-wrap">',
    '<table class="wb-md-table">',
    `<thead><tr>${header}</tr></thead>`,
    rows ? `<tbody>${rows}</tbody>` : "",
    "</table>",
    "</div>",
  ].filter(Boolean).join("");
}

function renderList(items, ordered) {
  const tag = ordered ? "ol" : "ul";
  const lis = items
    .map((item) => {
      // Allow nested inline formatting inside list items.
      const nested = item.replace(/\n/g, " <br />");
      return `<li>${inlineRender(nested)}</li>`;
    })
    .join("");
  return `<${tag} class="wb-md-list${ordered ? " wb-md-ordered" : ""}">${lis}</${tag}>`;
}

function inlineRender(text) {
  let out = escapeHtml(text);

  // Code
  out = out.replace(/`([^`]+)`/g, '<code class="wb-md-inline-code">$1</code>');

  // Bold + italic
  out = out.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  out = out.replace(/___(.+?)___/g, "<strong><em>$1</em></strong>");
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__(.+?)__/g, "<strong>$1</strong>");
  out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
  out = out.replace(/_(.+?)_/g, "<em>$1</em>");

  // Strikethrough
  out = out.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Links [text](url)
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, href) =>
      `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="wb-md-link">${label}</a>`
  );

  return out;
}
