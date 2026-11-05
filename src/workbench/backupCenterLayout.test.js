import { readLocalizedContractSource } from "./test-support/localizedContractSource.js";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function read(path) {
  return readLocalizedContractSource(join(__dirname, path), "utf8");
}

// The dialog shell delegates the snapshot and settings tabs to panel components.
function readBackupCenter() {
  return [
    "./components/BackupCenterDialog.vue",
    "./components/BackupSnapshotsPanel.vue",
    "./components/BackupSettingsPanel.vue",
  ].map(read).join("\n");
}

test("snapshot range follows the top connection filter without a duplicate selector", () => {
  const dialog = readBackupCenter();
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-backup-toolbar wb-backup-snapshot-toolbar"/);
  assert.match(dialog, /class="wb-backup-snapshot-layout"/);
  assert.doesNotMatch(dialog, /class="wb-backup-enable-conn"/);
  assert.doesNotMatch(dialog, /选择要管理快照范围的连接/);
  assert.doesNotMatch(styles, /\.wb-backup-enable-conn\b/);
});

test("snapshot scope keeps its natural height ahead of the snapshot list", () => {
  const panel = read("./components/BackupSnapshotsPanel.vue");
  const styles = read("./workbench.css");

  // The scope editor is a collapsible section so the snapshot list stays primary.
  assert.match(panel, /class="wb-backup-auto-toggle"[\s\S]*?:aria-expanded="scopeOpen"/);
  assert.match(panel, /v-if="scopeOpen" id="wb-backup-snapshot-scope" class="wb-backup-snapshot-layout"/);

  assert.match(styles, /\.wb-backup-snapshot-layout\s*\{[^}]*flex:\s*none/s);
  assert.doesNotMatch(styles, /\.wb-backup-snapshot-layout\s*\{[^}]*min-height:\s*0/s);
  assert.match(styles, /@media\s*\(max-width:\s*980px\)\s*\{[\s\S]*\.wb-backup-snapshot-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test("backup center close button has a stable header-specific target", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-dialog-close wb-backup-close"/);
  assert.match(styles, /\.wb-backup-header\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*width:\s*32px/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*height:\s*32px/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*justify-self:\s*end/s);
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*font-size:\s*var\(--wb-fs-display\)/s);
  assert.match(
    styles,
    /\.wb-dialog-close:hover:not\(:disabled\),\s*\.wb-dialog-close:focus-visible\s*\{[^}]*background:\s*var\(--wb-accent-soft\)[^}]*color:\s*var\(--wb-text\)/s,
  );
  assert.doesNotMatch(styles, /\.wb-backup-close:hover[^}]*--wb-danger/s);
});

test("settings tab has a user account section with register/login", () => {
  const dialog = read("./components/BackupSettingsPanel.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-backup-settings-section wb-account-section"/);
  assert.match(dialog, /中心服务地址/);
  assert.match(dialog, /用户名/);
  assert.match(dialog, /注册/);
  assert.match(dialog, /登录/);
  assert.match(styles, /\.wb-backup-settings-section\s*\{/);
  assert.match(styles, /\.wb-account-logged-in\b/);
});

test("audit tab has a local/shared mode switcher", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-backup-audit-mode"/);
  assert.match(dialog, /仅本机/);
  assert.match(dialog, /全员可见/);
  assert.match(styles, /\.wb-backup-audit-mode\b/);
  assert.match(styles, /\.wb-backup-audit-actor\b/);
});

test("local and shared audit reuse the table timeline with read-only shared details", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const history = read("./components/AuditTableHistory.vue");
  const shared = read("./composables/useSharedAuditHistory.js");

  assert.match(dialog, /:history="isSharedMode \? backup\.sharedHistory : backup\.history"/);
  assert.doesNotMatch(dialog, /v-for="row in sharedAuditRows"/);
  assert.match(history, /class="wb-audit-table"/);
  assert.match(history, /class="wb-audit-operation"/);
  assert.match(history, /:aria-expanded="s\.expanded === operation\.id"/);
  assert.match(history, /auditChangeItems\(entry\)/);
  assert.match(history, /auditChangeSql\(entry\)/);
  assert.match(history, /actorLabel\(operation\)/);
  assert.match(history, /v-if="!readOnly" type="button" class="wb-audit-restore"/);
  assert.match(history, /v-if="!readOnly && s\.preview"/);
  assert.match(shared, /readOnly: true/);
});

test("audit toolbar keeps mode filters and actions on one stable row", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-backup-toolbar wb-backup-audit-toolbar"/);
  assert.match(styles, /\.wb-backup-audit-toolbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(styles, /\.wb-backup-audit-toolbar\s*\{[^}]*align-items:\s*center/s);
  assert.match(styles, /\.wb-backup-audit-mode\s*\{[^}]*display:\s*grid/s);
  // Both mode labels size to their content so translations never truncate.
  assert.match(styles, /\.wb-backup-audit-mode\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(max-content,\s*1fr\)\)/s);
  assert.match(styles, /\.wb-backup-audit-mode\s+button\s*\{[^}]*width:\s*100%/s);
  assert.match(styles, /\.wb-backup-audit-toolbar\s+\.wb-backup-toolbar-actions\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*\.wb-backup-audit-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  // Clearing all history is destructive and lives in Settings, not beside Refresh.
  assert.doesNotMatch(dialog, /onClearAuditLogs/);
  assert.match(read("./components/BackupSettingsPanel.vue"), /@click="onClearAuditLogs"/);
});

test("sync now refreshes the visible audit list after pushing the outbox", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const syncNow = dialog.match(/async function onSyncNow\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(syncNow, /await\s+account\.value\?\.syncNow\(\)/);
  assert.match(syncNow, /await\s+props\.backup\.loadAuditLogs\(\)/);
});

test("snapshot range panels use readable database labels and dense rows", () => {
  const styles = read("./workbench.css");
  const databaseLabel = styles.match(/\.wb-backup-enable-name,\s*\.wb-backup-selected-db\s*\{[^}]*\}/s)?.[0] || "";

  assert.match(styles, /\.wb-backup-enable-row\s*\{[^}]*min-height:\s*34px/s);
  assert.match(styles, /\.wb-backup-selected-row\s*\{[^}]*min-height:\s*44px/s);
  assert.match(databaseLabel, /color:\s*var\(--wb-text\)/);
  assert.match(databaseLabel, /font-weight:\s*600/);
  assert.match(databaseLabel, /text-overflow:\s*ellipsis/);
});

test("audit table list scrolls inside the backup dialog instead of growing it", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-backup-dialog\s*\{[^}]*max-height:\s*min\(86vh,\s*780px\)/s);
  assert.match(styles, /\.wb-backup-dialog\s*\{[^}]*min-height:\s*0/s);
  assert.match(styles, /\.wb-backup-dialog\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.wb-audit-history\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.wb-audit-history\s*\{[^}]*min-height:\s*0/s);
  assert.match(styles, /\.wb-audit-tables\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.wb-audit-search\s*\{[^}]*flex:\s*none/s);
  assert.match(styles, /\.wb-audit-table-scroll\s*\{[^}]*flex:\s*1\s+1\s+auto/s);
});

test("header shows the current user identity", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  assert.match(dialog, /class="wb-backup-user"/);
  assert.match(dialog, /wb-backup-user-avatar/);
});
