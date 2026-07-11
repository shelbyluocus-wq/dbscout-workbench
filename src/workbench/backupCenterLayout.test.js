import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function read(path) {
  return readFileSync(join(__dirname, path), "utf8");
}

test("snapshot range follows the top connection filter without a duplicate selector", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-backup-toolbar wb-backup-snapshot-toolbar"/);
  assert.match(dialog, /class="wb-backup-snapshot-layout"/);
  assert.doesNotMatch(dialog, /class="wb-backup-enable-conn"/);
  assert.doesNotMatch(dialog, /选择要管理快照范围的连接/);
  assert.doesNotMatch(styles, /\.wb-backup-enable-conn\b/);
});

test("snapshot scope keeps its natural height ahead of the snapshot list", () => {
  const styles = read("./workbench.css");

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
  assert.match(styles, /\.wb-backup-close\s*\{[^}]*font-size:\s*20px/s);
  assert.match(
    styles,
    /\.wb-dialog-close:hover:not\(:disabled\),\s*\.wb-dialog-close:focus-visible\s*\{[^}]*background:\s*var\(--wb-accent-soft\)[^}]*color:\s*var\(--wb-text\)/s,
  );
  assert.doesNotMatch(styles, /\.wb-backup-close:hover[^}]*--wb-danger/s);
});

test("settings tab has a user account section with register/login", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-account-section"/);
  assert.match(dialog, /中心服务地址/);
  assert.match(dialog, /用户名/);
  assert.match(dialog, /注册/);
  assert.match(dialog, /登录/);
  assert.match(styles, /\.wb-account-section\b/);
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

test("audit toolbar keeps mode filters and actions on one stable row", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const styles = read("./workbench.css");

  assert.match(dialog, /class="wb-backup-toolbar wb-backup-audit-toolbar"/);
  assert.match(styles, /\.wb-backup-audit-toolbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(styles, /\.wb-backup-audit-toolbar\s*\{[^}]*align-items:\s*end/s);
  assert.match(styles, /\.wb-backup-audit-mode\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.wb-backup-audit-mode\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*88px\)/s);
  assert.match(styles, /\.wb-backup-audit-mode\s+button\s*\{[^}]*width:\s*100%/s);
  assert.match(styles, /\.wb-backup-audit-toolbar\s+\.wb-backup-toolbar-actions\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*\.wb-backup-audit-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});

test("sync now refreshes the visible audit list after pushing the outbox", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  const syncNow = dialog.match(/async function onSyncNow\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(syncNow, /await\s+account\.value\?\.syncNow\(\)/);
  assert.match(syncNow, /await\s+props\.backup\.loadAuditLogs\(\)/);
});

test("snapshot range panels use readable database labels and dense rows", () => {
  const styles = read("./workbench.css");

  assert.match(styles, /\.wb-backup-enable-row\s*\{[^}]*min-height:\s*34px/s);
  assert.match(styles, /\.wb-backup-enable-name\s*\{[^}]*color:\s*var\(--wb-text\)/s);
  assert.match(styles, /\.wb-backup-enable-name\s*\{[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.wb-backup-enable-name\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(styles, /\.wb-backup-selected-row\s*\{[^}]*min-height:\s*46px/s);
  assert.match(styles, /\.wb-backup-selected-db\s*\{[^}]*color:\s*var\(--wb-text\)/s);
  assert.match(styles, /\.wb-backup-selected-db\s*\{[^}]*font-weight:\s*600/s);
});

test("header shows the current user identity", () => {
  const dialog = read("./components/BackupCenterDialog.vue");
  assert.match(dialog, /class="wb-backup-user"/);
  assert.match(dialog, /wb-backup-user-avatar/);
});
