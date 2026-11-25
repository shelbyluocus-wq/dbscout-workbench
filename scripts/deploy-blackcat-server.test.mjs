import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_DEPLOY_HOST,
  DEFAULT_REMOTE_DIR,
  DEFAULT_SERVER_PORT,
  assertSafeRemoteDir,
  generateStandaloneWorkspaceCargoToml,
  main,
  parseArgs,
  renderDeployTemplates,
  validateLinuxElfBinary,
  validateMigrationSqliteFile,
} from "./deploy-blackcat-server.mjs";

test("parseArgs applies defaults and parses deploy/migrate/status flags", () => {
  const defaults = parseArgs([], {});
  assert.equal(defaults.mode, "deploy");
  assert.equal(defaults.host, DEFAULT_DEPLOY_HOST);
  assert.equal(defaults.remoteDir, DEFAULT_REMOTE_DIR);
  assert.equal(defaults.serverPort, DEFAULT_SERVER_PORT);

  const migrated = parseArgs(
    ["--host", "192.168.1.243", "--migrate-db", "./old.sqlite", "--force-overwrite-db", "--dry-run"],
    {},
  );
  assert.equal(migrated.mode, "migrate-db");
  assert.equal(migrated.migrateDbPath, "./old.sqlite");
  assert.equal(migrated.forceOverwriteDb, true);
  assert.equal(migrated.dryRun, true);

  assert.equal(parseArgs(["--status"], {}).mode, "status");
  assert.equal(parseArgs(["--backup"], {}).mode, "backup");
});

test("assertSafeRemoteDir rejects GM directory and system roots", () => {
  assert.equal(assertSafeRemoteDir("/home/blackcat-server/"), "/home/blackcat-server");
  assert.throws(() => assertSafeRemoteDir("/home/gmserv"), /GM/);
  assert.throws(() => assertSafeRemoteDir("/home/gmserv/sub"), /GM/);
  assert.throws(() => assertSafeRemoteDir("/"), /安全/);
  assert.throws(() => assertSafeRemoteDir("relative/path"), /绝对路径/);
});

test("validateLinuxElfBinary accepts ELF header and rejects non-ELF binaries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-elf-test-"));
  try {
    const elfPath = path.join(dir, "dbscout-server");
    fs.writeFileSync(elfPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    assert.equal(validateLinuxElfBinary(elfPath), elfPath);

    const exePath = path.join(dir, "dbscout-server.exe");
    fs.writeFileSync(exePath, Buffer.from("MZ\x90\x00not-elf"));
    assert.throws(() => validateLinuxElfBinary(exePath), /Linux ELF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateMigrationSqliteFile verifies header and blocks non-empty WAL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-sqlite-test-"));
  try {
    const dbPath = path.join(dir, "dbscout-server.sqlite");
    fs.writeFileSync(dbPath, Buffer.concat([Buffer.from("SQLite format 3\0", "ascii"), Buffer.alloc(64)]));
    assert.equal(validateMigrationSqliteFile(dbPath), dbPath);

    fs.writeFileSync(`${dbPath}-wal`, Buffer.from("pending-wal-frame"));
    assert.throws(() => validateMigrationSqliteFile(dbPath), /WAL/);
    assert.equal(validateMigrationSqliteFile(dbPath, { allowWal: true }), dbPath);

    const invalidPath = path.join(dir, "bad.sqlite");
    fs.writeFileSync(invalidPath, "not a sqlite file at all");
    assert.throws(() => validateMigrationSqliteFile(invalidPath), /SQLite/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("generateStandaloneWorkspaceCargoToml isolates the server crate from src-tauri", () => {
  const toml = generateStandaloneWorkspaceCargoToml();
  assert.match(toml, /members\s*=\s*\["server"\]/);
  assert.doesNotMatch(toml, /src-tauri/);
});

test("renderDeployTemplates rewrites root dir and port with LF line endings", () => {
  const rendered = renderDeployTemplates({
    remoteDir: "/opt/blackcat",
    serverPort: 9876,
  });
  assert.match(rendered["blackcat-server.service"], /WorkingDirectory=\/opt\/blackcat/);
  assert.match(rendered["blackcat-server.service"], /DBSCOUT_SERVER_BIND=0\.0\.0\.0:9876/);
  assert.doesNotMatch(rendered["run-blackcat-server.sh"], /\r\n/);
  assert.doesNotMatch(rendered["backup-blackcat-db.sh"], /\r\n/);
});

test("main --dry-run succeeds without touching remote host", () => {
  assert.equal(main(["--dry-run"]), 0);
});
