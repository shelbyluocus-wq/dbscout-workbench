import {
  buildTableDesignPayload,
  normalizeTableDesign,
  validateTableDesignDraft,
} from "./tableDesign.js";

function text(value) {
  return String(value ?? "");
}

function findDraftColumn(columns, name) {
  const target = text(name).trim();
  if (!target) return null;
  const list = Array.isArray(columns) ? columns : [];
  const exact = list.find((column) => column.name === target || column.originalName === target);
  if (exact) return exact;
  const folded = target.toLowerCase();
  const matches = list.filter((column) =>
    text(column.name).toLowerCase() === folded || text(column.originalName).toLowerCase() === folded);
  return matches.length === 1 ? matches[0] : null;
}

function applySignatures(preview = {}) {
  const signatures = {
    previewSignature: preview.previewSignature || preview.signature || "",
    schemaSignature: preview.schemaSignature || preview.sourceSignature || "",
  };
  if (preview.schemaSignature) signatures.schemaSignature = preview.schemaSignature;
  if (preview.sourceSignature) signatures.sourceSignature = preview.sourceSignature;
  return signatures;
}

function identityOf(source = {}) {
  return {
    connectionId: text(source.connectionId || source.connection_id),
    database: text(source.database),
    tableName: text(source.tableName || source.table_name || source.name),
  };
}

// Saves one table or column comment through the same preview-and-apply path
// as table design, so the change stays audited and limited to that comment.
export async function applySchemaComment(invokeWorkbench, source, target, nextComment) {
  const comment = text(nextComment);
  const identity = identityOf(source);
  const design = await invokeWorkbench("get_table_design", identity);
  const draft = normalizeTableDesign(design);
  if (target?.kind === "table") {
    if (draft.tableComment === comment) return { status: "unchanged" };
    draft.tableComment = comment;
  } else {
    const column = findDraftColumn(draft.columns, target?.columnName);
    if (!column) return { status: "missing-column", columnName: text(target?.columnName) };
    if (column.comment === comment) return { status: "unchanged" };
    column.comment = comment;
  }

  const validation = validateTableDesignDraft(draft);
  if (!validation.valid) {
    return { status: "invalid", message: validation.messages[0] || "" };
  }

  const payload = buildTableDesignPayload(identity, draft);
  const preview = await invokeWorkbench("preview_table_design_change", payload);
  const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts.filter(Boolean) : [];
  if (conflicts.length) return { status: "conflict", message: conflicts[0] };
  const statements = Array.isArray(preview?.statements) ? preview.statements : [];
  if (!statements.length) return { status: "unchanged", preview };

  const signatures = applySignatures(preview);
  if (!signatures.previewSignature || !signatures.schemaSignature) {
    return { status: "invalid", message: "请先预览 SQL 并获取签名后再保存表设计" };
  }
  const result = await invokeWorkbench("apply_table_design_change", { ...payload, ...signatures });
  return {
    status: "applied",
    result,
    schema: result?.schema || result,
    preview,
  };
}
