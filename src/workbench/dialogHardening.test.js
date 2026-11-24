import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const taskDialogs = [
  "./components/AccountStartupLoginDialog.vue",
  "./components/BackupCenterDialog.vue",
  "./components/BatchExportDialog.vue",
  "./components/BatchImportDialog.vue",
  "./components/ConfirmDialog.vue",
  "./components/ConnectionDialog.vue",
  "./components/DatabaseDisplayDialog.vue",
  "./components/DatabaseSyncDialog.vue",
  "./components/FontSettingsDialog.vue",
  "./components/ImportWizardDialog.vue",
  "./components/ShortcutSettingsDialog.vue",
  "./components/SqlHistoryDialog.vue",
  "./components/TableCopyDialog.vue",
  "./components/UpdateDialog.vue",
];

test("task dialogs do not dismiss from backdrop clicks", () => {
  for (const file of taskDialogs) {
    assert.doesNotMatch(read(file), /@(click|mousedown)\.self=/, file);
  }

  const editor = read("./components/TableDesignEditor.vue");
  const workbench = read("./MySqlWorkbench.vue");
  assert.doesNotMatch(editor, /wb-design-comment-dialog-overlay[^>]*@click\.self/);
  assert.match(editor, /useEscClose\([\s\S]*?dialogRef: previewDialogRef/);
  assert.match(editor, /useEscClose\([\s\S]*?dialogRef: commentDialogRef/);
  assert.doesNotMatch(workbench, /wb-dialog-overlay[^>]*@click\.self/);
});

test("task dialogs register a focus-managed dialog layer", () => {
  for (const file of taskDialogs) {
    const source = read(file);
    assert.match(source, /useEscClose\(/, file);
    assert.match(source, /dialogRef/, file);
    assert.match(source, /tabindex="-1"/, file);
  }
});

test("confirmation UI has a single global renderer", () => {
  const backup = read("./components/BackupCenterDialog.vue");
  const workbench = read("./MySqlWorkbench.vue");

  assert.doesNotMatch(backup, /import\s+ConfirmDialog|<ConfirmDialog/);
  assert.equal((workbench.match(/<ConfirmDialog\b/g) || []).length, 1);
});

test("modal pickers use the same focus layer without backdrop dismissal", () => {
  const quickOpen = read("./components/QuickOpenPalette.vue");
  const kindFilter = read("./components/QuickOpenKindFilter.vue");
  const favorites = read("./components/HomeDatabaseFavorites.vue");

  assert.match(quickOpen, /useEscClose\([\s\S]*?dialogRef: cardRef/);
  assert.match(quickOpen, /useEscClose\([\s\S]*?dbDropdownOpen[\s\S]*?dialogRef: dbDropdownRef/);
  assert.match(kindFilter, /useEscClose\([\s\S]*?dialogRef: menuRef/);
  assert.doesNotMatch(quickOpen, /onOverlayMouseDown/);
  assert.match(favorites, /useEscClose\([\s\S]*?dialogRef: pickerDialogRef/);
  assert.doesNotMatch(favorites, /@mousedown\.self="closePicker/);
});

test("workbench shortcuts stand down while a managed dialog is active", () => {
  const workbench = read("./MySqlWorkbench.vue");
  assert.match(workbench, /import\s+\{\s*dialogLayerManager\s*\}/);
  assert.match(workbench, /function handleGlobalShortcutKeydown\(event\)[\s\S]*?dialogLayerManager\.hasActiveModalLayer\(\)/);
  assert.match(workbench, /function handleWorkbenchKeydown\(event\)[\s\S]*?dialogLayerManager\.hasActiveModalLayer\(\)/);
});

test("find and replace keeps its intentional non-modal behavior", () => {
  const dialog = read("./components/FindReplaceDialog.vue");
  assert.match(dialog, /useEscClose\([\s\S]*?dialogRef,\s*modal:\s*false/);
  assert.doesNotMatch(dialog, /aria-modal="true"/);
});

test("backup center treats every background operation as close-protected", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const backup = read("./composables/useBackupCenter.js");
  assert.match(dialog, /Object\.values\(busy\.value \|\| \{\}\)\.some\(Boolean\)/);
  assert.match(dialog, /Boolean\(progress\.value\?\.active\)/);
  assert.match(dialog, /Object\.values\(accountBusy\.value \|\| \{\}\)\.some\(Boolean\)/);
  assert.match(backup, /pruning:\s*false/);
});

test("a parent task dialog cannot close while its global confirmation is active", () => {
  const tableCopy = read("./components/TableCopyDialog.vue");
  assert.match(tableCopy, /const confirming = ref\(false\)/);
  assert.match(tableCopy, /isBusy\.value \|\| confirming\.value/);
  assert.match(tableCopy, /confirming\.value = true[\s\S]*?finally[\s\S]*?confirming\.value = false/);
});
