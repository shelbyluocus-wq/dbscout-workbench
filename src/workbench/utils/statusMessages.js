// Operation messages are still authored in Simplified Chinese at their call
// sites and flow through `statusText`. This module is the single adapter that
// turns them into visible notices: it decides which messages deserve a notice
// (and with which tone), and maps the common templates to catalog keys so the
// notice reads in the interface language. Messages without a rule keep their
// original text; the English interface adds a localized generic heading.

import { translateIn } from "../i18n/index.js";

const GENERIC_TITLE_KEYS = Object.freeze({
  error: "status.genericError",
  warning: "status.genericWarning",
  success: "status.genericSuccess",
  info: "status.genericInfo",
});

// Phrases that call sites splice into "只读连接不能…" / "当前连接不支持…".
const ACTION_TERMS = Object.freeze({
  "删除数据": { en: "delete data", "zh-TW": "刪除資料" },
  "对比变化": { en: "compare changes", "zh-TW": "比對變更" },
  "导入数据": { en: "import data", "zh-TW": "匯入資料" },
  "导入": { en: "import", "zh-TW": "匯入" },
  "打开表设计": { en: "open table design", "zh-TW": "開啟表設計" },
  "表设计": { en: "table design", "zh-TW": "表設計" },
  "SQL 控制台": { en: "the SQL console", "zh-TW": "SQL 主控台" },
  "修改备注": { en: "edit comments", "zh-TW": "修改備註" },
  "删除表": { en: "delete tables", "zh-TW": "刪除表" },
  "发送表": { en: "send tables", "zh-TW": "傳送表" },
  "执行覆盖同步": { en: "run an overwrite sync", "zh-TW": "執行覆蓋同步" },
  "覆盖同步": { en: "overwrite sync", "zh-TW": "覆蓋同步" },
  "粘贴表": { en: "paste tables", "zh-TW": "貼上表" },
  "重命名表": { en: "rename tables", "zh-TW": "重新命名表" },
  "整表查找替换，请使用表格上方的搜索框": {
    en: "whole-table find and replace; use the search box above the grid",
    "zh-TW": "整表尋找與取代，請使用表格上方的搜尋框",
  },
});

// Reasons that call sites splice into "无法粘贴：…" / "无法填充：…".
const REASON_TERMS = Object.freeze({
  "目标范围超出可编辑列": { en: "the target extends past the editable columns", "zh-TW": "目標範圍超出可編輯欄位" },
  "没有可写入的匹配字段": { en: "there are no matching writable columns", "zh-TW": "沒有可寫入的相符欄位" },
  "目标范围超出已加载的可编辑区域": { en: "the target extends past the loaded editable area", "zh-TW": "目標範圍超出已載入的可編輯區域" },
  "目标选区没有可写入的单元格": { en: "the selection has no writable cells", "zh-TW": "目標選取範圍沒有可寫入的儲存格" },
  "目标只包含数据库生成字段": { en: "the target only contains database-generated columns", "zh-TW": "目標只包含資料庫產生的欄位" },
  "目标选区无效": { en: "the selection isn't valid", "zh-TW": "目標選取範圍無效" },
  "当前表没有可写入的匹配字段": { en: "this table has no matching writable columns", "zh-TW": "目前表沒有可寫入的相符欄位" },
});

// History labels that undo/redo messages quote ("已撤销：批量粘贴").
const HISTORY_LABEL_TERMS = Object.freeze({
  "新增行": { en: "new row", "zh-TW": "新增列" },
  "新增行编辑": { en: "new row edit", "zh-TW": "新增列編輯" },
  "编辑新增行": { en: "new row edit", "zh-TW": "編輯新增列" },
  "移除新增行": { en: "removing new rows", "zh-TW": "移除新增列" },
  "批量填充": { en: "fill", "zh-TW": "批次填滿" },
  "填充到新增行": { en: "fill into new rows", "zh-TW": "填滿到新增列" },
  "清空选区": { en: "clearing the selection", "zh-TW": "清除選取範圍" },
  "清空新增行单元格": { en: "clearing new-row cells", "zh-TW": "清除新增列儲存格" },
  "批量清空保存": { en: "clearing cells", "zh-TW": "批次清除儲存" },
  "批量保存": { en: "batch save", "zh-TW": "批次儲存" },
  "查找替换": { en: "find and replace", "zh-TW": "尋找與取代" },
  "查找替换新增行": { en: "find and replace in new rows", "zh-TW": "尋找與取代新增列" },
  "选区替换": { en: "replace in selection", "zh-TW": "選取範圍取代" },
  "编辑单元格": { en: "cell edit", "zh-TW": "編輯儲存格" },
  "批量编辑单元格": { en: "cell edits", "zh-TW": "批次編輯儲存格" },
  "粘贴到新增行": { en: "paste into new rows", "zh-TW": "貼上到新增列" },
  "粘贴整行到新增行": { en: "pasting rows into new rows", "zh-TW": "貼上整列到新增列" },
  "粘贴整行到当前行上方": { en: "pasting rows above the current row", "zh-TW": "貼上整列到目前列上方" },
  "批量粘贴": { en: "paste", "zh-TW": "批次貼上" },
  "批量粘贴保存": { en: "paste", "zh-TW": "批次貼上儲存" },
});

const term = (dictionary) => (value, locale) => dictionary[value]?.[locale] ?? value;
const actionTerm = term(ACTION_TERMS);
const reasonTerm = term(REASON_TERMS);
const historyLabelTerm = (value, locale) => {
  const addedRows = /^新增 (\d+) 行$/.exec(value);
  if (addedRows) return translateIn(locale, "status.historyAddedRows", { count: addedRows[1] });
  return term(HISTORY_LABEL_TERMS)(value, locale);
};

const ANY = "([\\s\\S]+)";
const NUM = "(\\d+)";

// Builds a rule from a template such as "提交事务失败：{detail}". Placeholders
// become capture groups in order; `transforms` localizes spliced fragments.
function rule(tone, key, template, { transforms = {}, pick } = {}) {
  const names = [];
  const source = template
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
      names.push(name);
      return /count|rows|tables|files|columns|expected|actual|inserted|updated|deleted|unchanged|errors|drafts|skipped/i.test(name) ? NUM : ANY;
    });
  return Object.freeze({ tone, key, pattern: new RegExp(`^${source}$`), names, transforms, pick });
}

const quiet = (template) => rule(null, null, template);
const quietPrefix = (prefix) =>
  Object.freeze({ tone: null, key: null, pattern: new RegExp(`^${prefix.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}`), names: [] });

// Singular/plural keys for messages that carry one count.
const counted = (singular, plural) => (params) => (params.count === "1" ? singular : plural);

// Order matters: specific templates precede the generic ones they overlap.
export const STATUS_MESSAGE_RULES = Object.freeze([
  // Specific warnings that would otherwise look like progress chatter.
  rule("warning", "status.pasteTablesBusy", "正在粘贴表，请勿重复操作"),

  // Progress and navigation chatter: the result is already visible.
  quietPrefix("正在"),
  quietPrefix("加载 "),
  quietPrefix("已打开"),
  quietPrefix("已刷新"),
  quietPrefix("已连接"),
  quietPrefix("已定位列："),
  quietPrefix("搜索命中第"),
  quietPrefix("全表搜索命中"),
  quietPrefix("值命中"),
  quietPrefix("表会话已"),
  // The opened connection's databases appear in the tree.
  quietPrefix("已打开连接"),
  quiet("搜索值…"),
  quiet("已取消值搜索"),
  quiet("复制成功"),
  // Table load failures already render in the grid's error panel.
  quietPrefix("读取表失败："),
  quietPrefix("读取分页失败："),

  // Errors.
  rule("error", "status.commitFailed", "提交事务失败：{detail}"),
  rule("error", "status.rollbackFailed", "回滚事务失败：{detail}"),
  rule("error", "status.startupFailed", "初始化失败：{detail}"),
  rule("error", "status.saveSqlFailed", "保存 SQL 失败：{detail}"),
  rule("error", "status.openSqlFailed", "打开 SQL 文件失败：{detail}"),
  rule("error", "status.tableSearchFailed", "全表搜索失败：{detail}"),
  rule("error", "status.searchMoreFailed", "继续搜索失败：{detail}"),
  rule("error", "status.valueSearchFailed", "值搜索失败：{detail}"),
  rule("error", "status.saveFailed", "保存失败：{detail}"),
  rule("error", "status.cutClipboardFailed", "写入剪贴板失败，未剪切"),
  rule("error", "status.readClipboardFailed", "读取剪贴板失败"),
  rule("error", "status.pasteFailedRetry", "粘贴失败，请重试"),
  rule("error", "status.copyFailedRetry", "复制失败：{detail}，请重新复制"),
  rule("error", "status.copyFailed", "复制失败：{detail}"),
  rule("error", "status.pasteFailed", "粘贴失败：{detail}"),
  rule("error", "status.undoFailed", "撤销失败：{detail}"),
  rule("error", "status.redoFailed", "重做失败：{detail}"),
  rule("error", "status.switchDatabaseFailed", "切换数据库失败：{detail}"),
  rule("error", "status.switchConnectionFailed", "切换连接失败：{detail}"),
  rule("error", "status.connectFailed", "连接失败：{detail}"),
  rule("error", "status.removeConnectionFailed", "移除连接失败：{detail}"),
  rule("error", "status.closeConnectionFailed", "关闭连接失败：{detail}"),
  rule("error", "status.openConnectionFailed", "打开连接失败：{detail}"),
  rule("error", "status.deleteFailed", "删除失败：{detail}"),
  rule("error", "status.dropTablesFailed", "删除表失败：{detail}"),
  rule("error", "status.refreshFailed", "刷新失败：{detail}"),
  rule("error", "status.refreshHomeFailed", "刷新首页失败：{detail}"),
  rule("error", "status.refreshColumnsFailed", "刷新字段失败：{detail}"),
  rule("error", "status.loadMoreFailed", "继续读取失败：{detail}"),
  rule("error", "status.loadPreviousFailed", "向前读取失败：{detail}"),
  rule("error", "status.jumpLastFailed", "定位末行失败：{detail}"),
  rule("error", "status.jumpFirstFailed", "定位首行失败：{detail}"),
  rule("error", "status.copyTableNameFailed", "复制表名失败：{detail}"),
  rule("error", "status.compareFailed", "对比变化失败：{detail}"),
  rule("error", "status.importValidationFailed", "导入校验失败：{count} 个错误，未执行导入"),
  rule("error", "status.importFailed", "导入失败：{detail}"),
  rule("error", "status.exportErrorLogFailed", "导出错误日志失败：{detail}"),
  rule("error", "status.openBatchImportFailed", "打开批量导入失败：{detail}"),
  rule("error", "status.openBatchExportFailed", "打开批量导出失败：{detail}"),
  rule("error", "status.batchImportFailed", "批量导入失败：{detail}"),
  rule("error", "status.batchExportFailed", "批量导出失败：{detail}"),
  rule("error", "status.readExcelFailed", "读取 Excel 失败：{detail}"),
  rule("error", "status.readFileFailed", "读取文件失败：{detail}"),
  rule("error", "status.insertFailed", "插入失败：{detail}"),
  rule("error", "status.newRowsSaveFailed", "新增行保存失败：{detail}"),
  rule("error", "status.newRowsNotSaved", "新增行未能保存：{detail}"),
  rule("error", "status.windowActionFailed", "窗口操作失败：{detail}"),
  rule("error", "status.pinWindowFailed", "窗口置顶失败：{detail}"),
  rule("error", "status.pasteTablesFailed", "粘贴表失败：{detail}"),
  rule("error", "status.renameTableFailed", "重命名表失败：{detail}"),
  rule("error", "status.pasteTargetSwitchFailed", "目标数据库切换失败，未执行粘贴"),
  rule("error", "status.rowChangedElsewhere", "数据已被别人修改，请刷新后再试"),
  rule("error", "status.saveIncomplete", "保存结果不完整：预期 {expected} 行，实际 {actual} 行"),
  rule("error", "status.duplicateKey", "主键重复，不能保存"),
  {
    ...rule("error", "status.batchPartialFailed", "{operation}失败：成功 {count} 个，失败 {errors} 个{detail}"),
    pattern: /^([\s\S]+?)失败：成功 (\d+) 个，失败 (\d+) 个(?:。([\s\S]*))?$/,
    transforms: { operation: historyLabelTerm },
    pick: (params) => (params.detail ? "status.batchPartialFailedDetail" : "status.batchPartialFailed"),
  },

  // Warnings: the requested action did not happen.
  rule("warning", "status.readOnlyTableEdit", "{table} 是只读连接，不能编辑"),
  rule("warning", "status.readOnlyBlocked", "只读连接不能{action}", { transforms: { action: actionTerm } }),
  rule("warning", "status.unsupportedAction", "当前连接不支持{action}", { transforms: { action: actionTerm } }),
  rule("warning", "status.clipboardEmpty", "剪贴板为空，未修改数据"),
  rule("warning", "status.clipboardChanged", "剪贴板内容已变化，请重新复制整行"),
  rule("warning", "status.fillTooLarge", "单次填充范围过大，请缩小区域后重试"),
  rule("warning", "status.nothingToFill", "没有可填充的单元格"),
  rule("warning", "status.cannotFill", "无法填充：{reason}", { transforms: { reason: reasonTerm } }),
  rule("warning", "status.cannotInsertCopiedRows", "无法插入复制行：{reason}", { transforms: { reason: reasonTerm } }),
  rule("warning", "status.copySpanTooLarge", "无法复制：离散选区跨度为 {rows}×{columns}，请缩小范围"),
  rule("warning", "status.cannotPaste", "无法粘贴：{reason}", { transforms: { reason: reasonTerm } }),
  rule("warning", "status.copyWholeRowsForNewRows", "请先通过行号复制整行，再粘贴到新增行"),
  rule("warning", "status.copyWholeRowsForRowSelection", "请先通过行号复制整行，再粘贴到行头选区"),
  rule("warning", "status.newRowsSavingWait", "新增行正在保存，请稍候"),
  rule("warning", "status.newRowsSavingClose", "新增行正在保存，完成后再关闭标签"),
  rule("warning", "status.newRowsNotAllSaved", "新增行未能全部保存，标签已保留"),
  rule("warning", "status.invalidInput", "输入不符合字段约束"),
  rule("warning", "status.saveAffectedNothing", "保存未影响任何数据，请刷新后再试"),
  rule("warning", "status.rowNotFoundChanged", "未找到对应行（数据可能已变化）"),
  rule("warning", "status.tableNotFound", "未找到表：{name}"),
  rule("warning", "status.columnNotFound", "未找到列：{name}"),
  rule("warning", "status.rowNotFound", "未找到行：{name}"),
  rule("warning", "status.noColumnMapping", "没有有效的列映射"),
  rule("warning", "status.createConnectionFirst", "请先新建数据库连接"),
  rule("warning", "status.allConnectionsClosed", "连接都已关闭，单击连接即可打开"),
  rule("warning", "status.selectDatabaseFirst", "请先选择数据库"),
  rule("warning", "status.selectDatabaseFirst", "请选择数据库"),
  rule("warning", "status.noDatabases", "当前连接下没有可用数据库"),
  rule("warning", "status.databaseGone", "数据库 {database} 已不存在，列表已刷新"),
  rule("warning", "status.nothingToExport", "{table} 没有可导出的数据"),
  rule("warning", "status.pasteTargetNotReady", "目标数据库尚未就绪，未执行粘贴"),
  rule("warning", "status.searchUnavailable", "当前搜索服务不可用"),
  rule("warning", "status.renamedRefreshFailed", "已完成重命名，但刷新表列表失败：{detail}"),
  rule("warning", "status.designSavedRefreshFailed", "表设计已保存，刷新失败，请重新打开或刷新表：{detail}"),
  rule("warning", "status.deletedRowsAndDraftsRefreshFailed", "已删除 {count} 行，并移除 {drafts} 条未保存新增行；但列表刷新失败，请点击「重试」或重新打开表"),
  rule("warning", "status.deletedRowsRefreshFailed", "已删除 {count} 行，但列表刷新失败，请点击「重试」或重新打开表", {
    pick: counted("status.deletedRowRefreshFailed", "status.deletedRowsRefreshFailed"),
  }),
  rule("warning", "status.batchExportPartial", "批量导出完成，{count} 张表失败"),
  rule("warning", "status.batchImportPartial", "批量导入完成，{count} 个错误"),
  rule("warning", "status.droppedTablesPartial", "已删除 {count} 张表，{detail}"),
  rule("warning", "status.droppedTablesRefreshFailed", "已删除 {count} 张表；{detail}"),

  // Neutral information.
  rule("info", "status.nothingToUndo", "无可撤销操作"),
  rule("info", "status.nothingToRedo", "无可重做操作"),
  rule("info", "status.noMatches", "当前表未找到匹配内容"),
  rule("info", "status.batchExportCancelled", "批量导出已取消：已读取 {tables} 张表、{rows} 行，未生成文件"),
  rule("info", "status.refreshCancelledUnsaved", "已取消刷新，新增行尚未保存"),
  rule("info", "status.reachedLoadedEnd", "已到达已加载范围的末尾"),
  rule("info", "status.batchImportCancelled", "批量导入已取消：新增 {inserted}，更新 {updated}，删除 {deleted}，未变化 {unchanged}，{errors} 个错误"),

  // Completed operations whose outcome is not otherwise obvious.
  rule("success", "status.exportedRowsTo", "已导出 {count} 行 → {path}", { pick: counted("status.exportedRowTo", "status.exportedRowsTo") }),
  rule("success", "status.exportedRows", "已导出 {count} 行", { pick: counted("status.exportedRow", "status.exportedRows") }),
  rule("success", "status.exportSucceeded", "导出成功"),
  rule("success", "status.batchExportSucceeded", "批量导出成功"),
  rule("success", "status.batchImportSucceeded", "批量导入成功"),
  rule("success", "status.batchExportDoneFilesTo", "批量导出完成：{tables} 张表，{files} 个 Excel，{rows} 行 → {path}"),
  rule("success", "status.batchExportDoneFiles", "批量导出完成：{tables} 张表，{files} 个 Excel，{rows} 行"),
  rule("success", "status.batchExportDoneTo", "批量导出完成：{tables} 张表，{rows} 行 → {path}"),
  rule("success", "status.batchExportDone", "批量导出完成：{tables} 张表，{rows} 行"),
  rule("success", "status.batchExportDoneFilesOnly", "批量导出完成：{files} 个 Excel，{rows} 行"),
  {
    ...rule("success", "status.batchImportDone", "批量导入完成：新增 {inserted}，更新 {updated}，删除 {deleted}，未变化 {unchanged}，{errors} 个错误"),
    toneFor: (params) => (params.errors === "0" ? "success" : "warning"),
    pick: (params) => (params.errors === "0" ? "status.batchImportDone" : "status.batchImportDoneErrors"),
  },
  {
    ...rule("success", "status.importDone", "导入完成：新增 {inserted}，覆盖 {updated}，删除 {deleted}，未变化 {unchanged}"),
    pattern: /^导入完成：新增 (\d+)，覆盖 (\d+)，删除 (\d+)，未变化 (\d+)(?:，跳过 (\d+))?(?:；原表已备份至 ([\s\S]+))?$/,
    names: ["inserted", "updated", "deleted", "unchanged", "skipped", "path"],
    compose: (params, locale) => [
      translateIn(locale, "status.importDone", params),
      params.skipped ? translateIn(locale, "status.importSkipped", params) : "",
      params.path ? translateIn(locale, "status.importBackedUp", params) : "",
    ].filter(Boolean).join(locale === "en" ? ". " : "；"),
  },
  rule("success", "status.errorLogExportedTo", "错误日志已导出：{path}"),
  rule("success", "status.errorLogExported", "错误日志已导出"),
  rule("success", "status.deletedRowsAndDrafts", "已删除 {count} 行，并移除 {drafts} 条未保存新增行"),
  rule("success", "status.deletedRows", "已删除 {count} 行", { pick: counted("status.deletedRow", "status.deletedRows") }),
  rule("success", "status.droppedTables", "已删除 {count} 张表", { pick: counted("status.droppedTable", "status.droppedTables") }),
  rule("success", "status.insertedRow", "已插入 1 行"),
  rule("success", "status.savedNewRows", "已保存新增 {count} 行", { pick: counted("status.savedNewRow", "status.savedNewRows") }),
  rule("success", "status.savedCells", "已保存 {count} 个单元格", { pick: counted("status.savedCell", "status.savedCells") }),
  rule("success", "status.filledCells", "已填充 {count} 个单元格", { pick: counted("status.filledCell", "status.filledCells") }),
  rule("success", "status.clearedCells", "已清空 {count} 个单元格", { pick: counted("status.clearedCell", "status.clearedCells") }),
  rule("success", "status.pastedCells", "已粘贴 {count} 个单元格", { pick: counted("status.pastedCell", "status.pastedCells") }),
  rule("success", "status.pastedDraftCells", "已粘贴 {count} 个新增单元格", { pick: counted("status.pastedDraftCell", "status.pastedDraftCells") }),
  rule("success", "status.pastedIntoNewRowsPending", "已粘贴到 {count} 条新增行，保存后写入数据库"),
  rule("success", "status.pastedIntoNewRows", "已粘贴到 {count} 条新增行"),
  rule("success", "status.insertedCopiedRows", "已在当前行上方插入 {count} 条复制行，保存后写入数据库"),
  rule("success", "status.replacedDraftCellsInSelection", "已在选区内替换 {count} 个新增行单元格"),
  rule("success", "status.replacedCellsInSelection", "已在选区内替换 {count} 个单元格"),
  rule("success", "status.removedDraftRows", "已移除 {count} 条新增未保存行"),
  rule("success", "status.removedDraftRow", "已移除新增未保存行"),
  rule("success", "status.cutCellsInRange", "已剪切 {count} 个单元格（范围 {rows}×{columns}）"),
  rule("success", "status.cutRange", "已剪切 {rows}×{columns} 区域"),
  rule("success", "status.cut", "已剪切"),
  rule("success", "status.undoCells", "已撤销 {count} 个单元格"),
  rule("success", "status.redoCells", "已重做 {count} 个单元格"),
  rule("success", "status.undoDraftCells", "已撤销 {count} 个新增行单元格"),
  rule("success", "status.redoDraftCells", "已重做 {count} 个新增行单元格"),
  rule("success", "status.undoChanges", "已撤销 {count} 项修改"),
  rule("success", "status.redoChanges", "已重做 {count} 项修改"),
  rule("success", "status.undoReplace", "已撤销整表替换（{count} 个单元格）"),
  rule("success", "status.redoReplace", "已重做整表替换（{count} 个单元格）"),
  rule("success", "status.undoLabel", "已撤销：{label}", { transforms: { label: historyLabelTerm } }),
  rule("success", "status.redoLabel", "已重做：{label}", { transforms: { label: historyLabelTerm } }),
  rule("success", "status.undone", "已撤销"),
  rule("success", "status.redone", "已重做"),
  rule("success", "status.pasteSucceeded", "粘贴成功"),
  rule("success", "status.copiedTables", "已复制 {count} 张表", { pick: counted("status.copiedTable", "status.copiedTables") }),
  rule("success", "status.pastedTablesNamed", "已粘贴 {count} 张表：{names}"),
  rule("success", "status.pastedTables", "已粘贴 {count} 张表", { pick: counted("status.pastedTable", "status.pastedTables") }),
  rule("success", "status.renamedDatabaseAlias", "已重命名数据库 {database} → {alias}"),
  rule("success", "status.clearedDatabaseAlias", "已清除数据库 {database} 的本地别名"),
  rule("success", "status.renamedConnectionAlias", "已重命名连接 {connection} → {alias}"),
  rule("success", "status.clearedConnectionAlias", "已清除连接 {connection} 的本地别名"),
  rule("success", "status.renamedTable", "已重命名 {from} → {to}"),
  rule("success", "status.favoritedDatabase", "已收藏数据库：{database}"),
  rule("success", "status.unfavoritedDatabase", "已移除收藏：{database}"),
  rule("success", "status.removedConnection", "已移除连接 {connection}"),
  rule("success", "status.closedConnection", "已关闭连接 {connection}"),
  rule("success", "status.designSavedNamed", "表设计已保存：{table}"),
  rule("success", "status.designSaved", "表设计已保存"),
  rule("success", "status.pinnedWindow", "已钉住：窗口将保持在最上层"),
  rule("success", "status.unpinnedWindow", "已解除钉住：窗口恢复正常层级"),

  // Remaining confirmations of copy actions and single-cell saves are quiet:
  // the grid already shows the copy outline or a saved-cell reminder.
  quietPrefix("已复制"),
  quietPrefix("已保存"),
]);

// Fallback heuristics for messages without a rule (dynamic backend text).
const ERROR_WORDS = /失败|错误|冲突|超时|拒绝|异常/;
const WARNING_WORDS = /不能|无法|不支持|请先|未找到|没有可|超出|过大|已不存在|未能|不符合/;

function normalize(text) {
  return String(text ?? "").trim();
}

function matchRule(text) {
  for (const candidate of STATUS_MESSAGE_RULES) {
    const match = candidate.pattern.exec(text);
    if (!match) continue;
    const params = {};
    candidate.names.forEach((name, index) => {
      params[name] = match[index + 1] ?? "";
    });
    return { rule: candidate, params };
  }
  return null;
}

// Returns { tone, key, params } for a status message, or null when the message
// should stay quiet. `explicitError` is the structured flag from setStatus().
export function describeStatusMessage(text, { explicitError = false } = {}) {
  const message = normalize(text);
  if (!message) return null;
  const matched = matchRule(message);
  if (matched) {
    const { rule: candidate, params } = matched;
    const tone = candidate.toneFor ? candidate.toneFor(params) : candidate.tone;
    // Quiet rules win even over the error flag: their outcome is shown elsewhere.
    if (!tone) return null;
    return { tone: explicitError ? "error" : tone, key: candidate.key, params };
  }
  if (explicitError || ERROR_WORDS.test(message)) return { tone: "error", key: null, params: {} };
  if (WARNING_WORDS.test(message)) return { tone: "warning", key: null, params: {} };
  return null;
}

function localizedParams(candidate, params, locale) {
  const result = {};
  for (const [name, value] of Object.entries(params)) {
    const transform = candidate.transforms?.[name];
    result[name] = transform ? transform(value, locale) : value;
  }
  return result;
}

// Renders a status message for display. Simplified Chinese is the authoring
// language, so it passes through untouched. Other locales use the matching
// catalog entry; without one, Traditional Chinese keeps the original text and
// English shows a generic localized title with the original text as detail.
export function localizeStatusMessage(text, locale = "en", { tone = null } = {}) {
  const message = normalize(text);
  if (!message) return { title: "", detail: "" };
  if (locale === "zh-CN") return { title: message, detail: "" };
  const matched = matchRule(message);
  if (matched?.rule.key) {
    const { rule: candidate } = matched;
    const params = localizedParams(candidate, matched.params, locale);
    if (candidate.compose) return { title: candidate.compose(params, locale), detail: "" };
    const key = candidate.pick ? candidate.pick(matched.params) : candidate.key;
    return { title: translateIn(locale, key, params), detail: "" };
  }
  if (locale !== "en") return { title: message, detail: "" };
  const resolvedTone = tone || describeStatusMessage(message)?.tone || "info";
  return { title: translateIn(locale, GENERIC_TITLE_KEYS[resolvedTone] || GENERIC_TITLE_KEYS.info), detail: message };
}

// Every catalog key referenced by the rules, for catalog-parity tests.
export function statusMessageCatalogKeys() {
  const keys = new Set(Object.values(GENERIC_TITLE_KEYS));
  for (const candidate of STATUS_MESSAGE_RULES) {
    if (candidate.key) keys.add(candidate.key);
  }
  [
    "status.historyAddedRows",
    "status.deletedRowRefreshFailed",
    "status.batchPartialFailedDetail",
    "status.batchImportDoneErrors",
    "status.importSkipped",
    "status.importBackedUp",
    "status.exportedRowTo",
    "status.exportedRow",
    "status.deletedRow",
    "status.droppedTable",
    "status.savedNewRow",
    "status.savedCell",
    "status.filledCell",
    "status.clearedCell",
    "status.pastedCell",
    "status.pastedDraftCell",
    "status.copiedTable",
    "status.pastedTable",
  ].forEach((key) => keys.add(key));
  return [...keys].sort();
}
