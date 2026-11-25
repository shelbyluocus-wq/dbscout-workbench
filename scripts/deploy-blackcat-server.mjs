#!/usr/bin/env node
/**
 * Deploy, migrate, inspect, or back up the standalone Blackcat central server
 * (`dbscout-server`) on the Linux host (default: 192.168.1.243:8765).
 *
 * Strictly isolated under `/home/blackcat-server` — refuses to target
 * `/home/gmserv` or touch any GM files/processes.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..");

export const DEFAULT_DEPLOY_HOST = "192.168.1.243";
export const DEFAULT_DEPLOY_USER = "root";
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_REMOTE_DIR = "/home/blackcat-server";
export const DEFAULT_SERVER_PORT = 8765;

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

export function assertSafeRemoteDir(remoteDir) {
  const normalized = path.posix
    .normalize(String(remoteDir || "").trim())
    .replace(/\/+$/, "");
  if (!normalized.startsWith("/") || normalized === "/") {
    throw new Error(`远端目录必须是安全的绝对路径，当前为: ${remoteDir}`);
  }
  if (normalized === "/home/gmserv" || normalized.startsWith("/home/gmserv/")) {
    throw new Error(`拒绝部署到 GM 目录 (${normalized})，黑猫中心服务必须与 GM 隔离`);
  }
  const forbidden = ["/etc", "/usr", "/bin", "/sbin", "/var", "/lib", "/root", "/home"];
  for (const blocked of forbidden) {
    if (normalized === blocked) {
      throw new Error(`拒绝使用受保护目录作为部署根目录: ${normalized}`);
    }
  }
  return normalized;
}

export function assertSafePort(rawPort, label = "端口") {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label}无效: ${rawPort}`);
  }
  return port;
}

export function generateStandaloneWorkspaceCargoToml() {
  return `[workspace]\nresolver = "2"\nmembers = ["server"]\n`;
}

export function validateLinuxElfBinary(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到预编译二进制文件: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < 4) {
    throw new Error(`预编译二进制文件无效: ${resolved}`);
  }
  const fd = fs.openSync(resolved, "r");
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    if (!magic.equals(ELF_MAGIC)) {
      throw new Error(
        `文件不是 Linux ELF 可执行程序 (${resolved})；macOS/Windows 可执行文件不能直接运行在 Linux 243 上`,
      );
    }
  } finally {
    fs.closeSync(fd);
  }
  return resolved;
}

export function validateMigrationSqliteFile(filePath, { allowWal = false } = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`找不到要迁移的数据库文件: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < SQLITE_HEADER.length) {
    throw new Error(`迁移文件不是有效的 SQLite 数据库: ${resolved}`);
  }
  const fd = fs.openSync(resolved, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    fs.readSync(fd, header, 0, SQLITE_HEADER.length, 0);
    if (!header.equals(SQLITE_HEADER)) {
      throw new Error(`文件头不符合 SQLite 格式: ${resolved}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  const walPath = `${resolved}-wal`;
  if (!allowWal && fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error(
      `检测到非空 WAL 文件 (${walPath})。请先停止 193 上的旧服务并运行 scripts/export-dbscout-server-db.ps1 导出干净单文件后再迁移，避免丢失最近写入。`,
    );
  }
  return resolved;
}

export function renderDeployTemplates({ remoteDir, serverPort }) {
  const safeDir = assertSafeRemoteDir(remoteDir);
  const port = assertSafePort(serverPort, "服务端口");
  const deployDir = path.join(REPO_ROOT, "server", "deploy");
  const readTemplate = (name) =>
    fs
      .readFileSync(path.join(deployDir, name), "utf8")
      .replace(/\r\n/g, "\n")
      .replaceAll("/home/blackcat-server", safeDir)
      .replaceAll("0.0.0.0:8765", `0.0.0.0:${port}`);

  return {
    "run-blackcat-server.sh": readTemplate("run-blackcat-server.sh"),
    "backup-blackcat-db.sh": readTemplate("backup-blackcat-db.sh"),
    "blackcat-server.service": readTemplate("blackcat-server.service"),
    "blackcat-server-backup.service": readTemplate("blackcat-server-backup.service"),
    "blackcat-server-backup.timer": readTemplate("blackcat-server-backup.timer"),
  };
}

export function parseArgs(argv, env = process.env) {
  const config = {
    mode: "deploy",
    host: env.DBSCOUT_DEPLOY_HOST || DEFAULT_DEPLOY_HOST,
    user: env.DBSCOUT_DEPLOY_USER || DEFAULT_DEPLOY_USER,
    sshPort: assertSafePort(env.DBSCOUT_DEPLOY_SSH_PORT || DEFAULT_SSH_PORT, "SSH 端口"),
    remoteDir: assertSafeRemoteDir(env.DBSCOUT_REMOTE_DIR || DEFAULT_REMOTE_DIR),
    serverPort: assertSafePort(env.DBSCOUT_SERVER_PORT || DEFAULT_SERVER_PORT, "服务端口"),
    binaryPath: null,
    migrateDbPath: null,
    forceOverwriteDb: false,
    allowWal: false,
    dryRun: false,
    help: false,
  };

  const nextValue = (args, index, flag) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少取值`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      config.help = true;
    } else if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg === "--status") {
      config.mode = "status";
    } else if (arg === "--backup") {
      config.mode = "backup";
    } else if (arg === "--host") {
      config.host = nextValue(argv, i, arg).trim();
      i += 1;
    } else if (arg === "--user") {
      config.user = nextValue(argv, i, arg).trim();
      i += 1;
    } else if (arg === "--ssh-port") {
      config.sshPort = assertSafePort(nextValue(argv, i, arg), "SSH 端口");
      i += 1;
    } else if (arg === "--remote-dir") {
      config.remoteDir = assertSafeRemoteDir(nextValue(argv, i, arg));
      i += 1;
    } else if (arg === "--port") {
      config.serverPort = assertSafePort(nextValue(argv, i, arg), "服务端口");
      i += 1;
    } else if (arg === "--binary") {
      config.binaryPath = nextValue(argv, i, arg);
      i += 1;
    } else if (arg === "--migrate-db") {
      config.mode = "migrate-db";
      config.migrateDbPath = nextValue(argv, i, arg);
      i += 1;
    } else if (arg === "--force-overwrite-db") {
      config.forceOverwriteDb = true;
    } else if (arg === "--allow-wal") {
      config.allowWal = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  if (!config.host) {
    throw new Error("部署主机地址不能为空");
  }
  if (!config.user) {
    throw new Error("SSH 用户名不能为空");
  }
  return config;
}

function printHelp() {
  console.log(`黑猫中心服务（dbscout-server）独立部署与运维工具

用法:
  node scripts/deploy-blackcat-server.mjs [选项]

常用模式:
  (默认)                  上传服务端源码到 243 编译部署、安装开机自启与每日备份并验证健康状态
  --binary <路径>         直接上传预编译好的 Linux ELF 可执行文件（243 无需安装 Rust）
  --migrate-db <路径>     安全迁移 193 导出的 dbscout-server.sqlite 到 243 并核对记录数
  --status                查看 243 上黑猫中心服务的运行状态、记录数与最近备份
  --backup                立即在 243 上执行一次在线热备份

可选参数:
  --host <IP>             目标主机（默认: ${DEFAULT_DEPLOY_HOST}，环境变量 DBSCOUT_DEPLOY_HOST）
  --user <用户>           SSH 用户名（默认: ${DEFAULT_DEPLOY_USER}，环境变量 DBSCOUT_DEPLOY_USER）
  --ssh-port <端口>       SSH 端口（默认: ${DEFAULT_SSH_PORT}，环境变量 DBSCOUT_DEPLOY_SSH_PORT）
  --remote-dir <目录>     远端独立目录（默认: ${DEFAULT_REMOTE_DIR}，严禁指向 /home/gmserv）
  --port <端口>           服务监听端口（默认: ${DEFAULT_SERVER_PORT}）
  --force-overwrite-db    配合 --migrate-db，允许覆盖 243 上已有非空库（仍会先自动备份）
  --dry-run               仅校验本地文件并打印将要执行的步骤，不连接远端
  -h, --help              显示此帮助
`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function createSshClient(config) {
  const target = `${config.user}@${config.host}`;
  const useControlMaster = process.platform !== "win32";
  const controlDir = useControlMaster
    ? fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-ssh-"))
    : null;
  const controlPath = controlDir ? path.join(controlDir, "ctl") : null;

  const baseSshArgs = [
    "-p",
    String(config.sshPort),
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ConnectTimeout=10",
  ];
  const baseScpArgs = [
    "-P",
    String(config.sshPort),
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ConnectTimeout=10",
  ];
  if (controlPath) {
    const ctlOpts = ["-o", "ControlMaster=auto", "-o", `ControlPath=${controlPath}`, "-o", "ControlPersist=120"];
    baseSshArgs.push(...ctlOpts);
    baseScpArgs.push(...ctlOpts);
  }

  const run = (cmd, args, options = {}) => {
    const result = spawnSync(cmd, args, {
      stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
      encoding: "utf8",
      input: options.input,
    });
    if (result.error) {
      throw new Error(`执行 ${cmd} 失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`${cmd} 退出码异常 (${result.status})`);
    }
    return result.stdout || "";
  };

  return {
    target,
    execPipe(remoteScript) {
      const result = spawnSync("ssh", [...baseSshArgs, target, "bash", "-s"], {
        input: remoteScript,
        stdio: ["pipe", "inherit", "inherit"],
        encoding: "utf8",
      });
      if (result.error) {
        throw new Error(`SSH 执行失败: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(`远端命令执行失败 (退出码 ${result.status})`);
      }
    },
    upload(localPath, remotePath) {
      run("scp", [...baseScpArgs, localPath, `${target}:${remotePath}`]);
    },
    close() {
      if (controlPath) {
        spawnSync("ssh", ["-p", String(config.sshPort), "-o", `ControlPath=${controlPath}`, "-O", "exit", target], {
          stdio: "ignore",
        });
        fs.rmSync(controlDir, { recursive: true, force: true });
      }
    },
  };
}

export function createDeployBundle(config, tempRoot) {
  const bundleDir = path.join(tempRoot, "bundle");
  const templatesDir = path.join(bundleDir, "deploy");
  fs.mkdirSync(templatesDir, { recursive: true });

  const templates = renderDeployTemplates(config);
  for (const [name, content] of Object.entries(templates)) {
    fs.writeFileSync(path.join(templatesDir, name), content, "utf8");
  }

  if (!config.binaryPath) {
    const srcDir = path.join(bundleDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "Cargo.toml"), generateStandaloneWorkspaceCargoToml(), "utf8");
    const cargoLock = path.join(REPO_ROOT, "Cargo.lock");
    if (fs.existsSync(cargoLock)) {
      fs.copyFileSync(cargoLock, path.join(srcDir, "Cargo.lock"));
    }
    fs.cpSync(path.join(REPO_ROOT, "server"), path.join(srcDir, "server"), {
      recursive: true,
      filter: (item) => {
        const base = path.basename(item);
        return base !== "target" && base !== ".DS_Store";
      },
    });
  }

  const archivePath = path.join(tempRoot, "blackcat-server-bundle.tar.gz");
  const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", bundleDir, "."], {
    stdio: "inherit",
  });
  if (tarResult.error || tarResult.status !== 0) {
    throw new Error(`打包部署归档失败: ${tarResult.error?.message || `exit ${tarResult.status}`}`);
  }
  return archivePath;
}

function buildRemoteDeployScript(config, hasPrebuiltBinary) {
  const root = shellQuote(config.remoteDir);
  const port = Number(config.serverPort);
  return `set -euo pipefail
ROOT=${root}
PORT=${port}
STAGE="$ROOT/.stage-deploy"

mkdir -p "$ROOT/bin" "$ROOT/data" "$ROOT/backups" "$ROOT/logs" "$ROOT/run" "$ROOT/scripts"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$ROOT/.blackcat-server-bundle.tar.gz" -C "$STAGE"
rm -f "$ROOT/.blackcat-server-bundle.tar.gz"

install -m 755 "$STAGE/deploy/run-blackcat-server.sh" "$ROOT/scripts/run-blackcat-server.sh"
install -m 755 "$STAGE/deploy/backup-blackcat-db.sh" "$ROOT/scripts/backup-blackcat-db.sh"

# 先对已有数据库做一次热备份（首次部署无库时自动跳过）
"$ROOT/scripts/backup-blackcat-db.sh"

${
  hasPrebuiltBinary
    ? `chmod 755 "$ROOT/bin/dbscout-server.new"`
    : `export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  echo "错误: 远端主机未安装 Rust (cargo)。可任选其一：" >&2
  echo "  1) 在 243 上安装一次 Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y" >&2
  echo "  2) 在其他 Linux 环境编译后使用 --binary <linux二进制> 直接上传" >&2
  rm -rf "$STAGE"
  exit 2
fi
mkdir -p "$ROOT/src"
rm -rf "$ROOT/src/server"
cp "$STAGE/src/Cargo.toml" "$ROOT/src/Cargo.toml"
if [[ -f "$STAGE/src/Cargo.lock" ]]; then
  cp "$STAGE/src/Cargo.lock" "$ROOT/src/Cargo.lock"
fi
cp -R "$STAGE/src/server" "$ROOT/src/server"
echo "正在 243 上编译 dbscout-server (release)..."
(cd "$ROOT/src" && cargo build --release -p dbscout-server)
install -m 755 "$ROOT/src/target/release/dbscout-server" "$ROOT/bin/dbscout-server.new"`
}

# 安装或刷新 systemd 托管与每日 04:00 定时备份（无 systemd 时回退 cron + nohup）
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  install -m 644 "$STAGE/deploy/blackcat-server.service" /etc/systemd/system/blackcat-server.service
  install -m 644 "$STAGE/deploy/blackcat-server-backup.service" /etc/systemd/system/blackcat-server-backup.service
  install -m 644 "$STAGE/deploy/blackcat-server-backup.timer" /etc/systemd/system/blackcat-server-backup.timer
  systemctl daemon-reload
  systemctl enable blackcat-server.service >/dev/null
  systemctl enable --now blackcat-server-backup.timer >/dev/null
else
  echo "提示: 未检测到 systemd，已使用 run-blackcat-server.sh (nohup) 托管。"
  if command -v crontab >/dev/null 2>&1; then
    CRON_LINE="0 4 * * * $ROOT/scripts/backup-blackcat-db.sh >> $ROOT/logs/backup.log 2>&1"
    (crontab -l 2>/dev/null | grep -v "backup-blackcat-db.sh" || true; echo "$CRON_LINE") | crontab -
  fi
fi

# 原子切换二进制，并在重启失败时自动回滚
HAD_PREV=0
if [[ -f "$ROOT/bin/dbscout-server" ]]; then
  cp -p "$ROOT/bin/dbscout-server" "$ROOT/bin/dbscout-server.prev"
  HAD_PREV=1
fi
mv -f "$ROOT/bin/dbscout-server.new" "$ROOT/bin/dbscout-server"
chmod 755 "$ROOT/bin/dbscout-server"

if ! "$ROOT/scripts/run-blackcat-server.sh" restart; then
  echo "警告: 新版本健康检查失败，正在自动回滚到上一版本..." >&2
  if [[ "$HAD_PREV" == "1" ]]; then
    mv -f "$ROOT/bin/dbscout-server.prev" "$ROOT/bin/dbscout-server"
    "$ROOT/scripts/run-blackcat-server.sh" restart || true
  fi
  rm -rf "$STAGE"
  exit 1
fi

rm -rf "$STAGE"
"$ROOT/scripts/run-blackcat-server.sh" status
echo "部署完成: http://${config.host}:$PORT"
`;
}

function buildRemoteMigrateScript(config) {
  const root = shellQuote(config.remoteDir);
  const force = config.forceOverwriteDb ? "1" : "0";
  return `set -euo pipefail
ROOT=${root}
FORCE=${force}
DB_PATH="$ROOT/data/dbscout-server.sqlite"
INCOMING="$ROOT/data/dbscout-server.sqlite.incoming"

if [[ ! -f "$INCOMING" ]]; then
  echo "错误: 未找到上传的数据库文件 $INCOMING" >&2
  exit 1
fi

count_rows() {
  local target="$1"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$target" "SELECT (SELECT COUNT(*) FROM users) || ',' || (SELECT COUNT(*) FROM audit_log);" 2>/dev/null || echo "?,?"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$target" <<'PY'
import sqlite3, sys
try:
    con = sqlite3.connect(sys.argv[1])
    u = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    a = con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
    print(f"{u},{a}")
except Exception:
    print("?,?")
PY
  else
    echo "?,?"
  fi
}

if [[ -f "$DB_PATH" ]]; then
  EXISTING_COUNTS="$(count_rows "$DB_PATH")"
  if [[ "$EXISTING_COUNTS" != "0,0" && "$FORCE" != "1" ]]; then
    rm -f "$INCOMING"
    echo "拒绝覆盖: 243 上已有非空中心库 ($DB_PATH, users,audit=$EXISTING_COUNTS)。如确认覆盖，请加 --force-overwrite-db（覆盖前仍会自动备份）。" >&2
    exit 1
  fi
  if [[ -x "$ROOT/scripts/backup-blackcat-db.sh" ]]; then
    "$ROOT/scripts/backup-blackcat-db.sh"
  else
    mkdir -p "$ROOT/backups"
    cp -p "$DB_PATH" "$ROOT/backups/pre-migrate-$(date +%Y%m%d-%H%M%S).sqlite"
  fi
fi

if [[ -x "$ROOT/scripts/run-blackcat-server.sh" ]]; then
  "$ROOT/scripts/run-blackcat-server.sh" stop
fi

rm -f "$DB_PATH-wal" "$DB_PATH-shm"
mv -f "$INCOMING" "$DB_PATH"
chmod 600 "$DB_PATH" || true

if [[ -x "$ROOT/scripts/run-blackcat-server.sh" ]]; then
  "$ROOT/scripts/run-blackcat-server.sh" start
fi

FINAL_COUNTS="$(count_rows "$DB_PATH")"
echo "数据迁移完成: $DB_PATH (users,audit_log=$FINAL_COUNTS)"
`;
}

function buildRemoteStatusScript(config) {
  const root = shellQuote(config.remoteDir);
  return `set -euo pipefail
ROOT=${root}
if [[ -x "$ROOT/scripts/run-blackcat-server.sh" ]]; then
  "$ROOT/scripts/run-blackcat-server.sh" status
else
  echo "尚未在 $ROOT 部署黑猫中心服务"
  exit 0
fi
DB_PATH="$ROOT/data/dbscout-server.sqlite"
if [[ -f "$DB_PATH" ]]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "库内统计: $(sqlite3 "$DB_PATH" "SELECT 'users=' || (SELECT COUNT(*) FROM users) || ', audit_log=' || (SELECT COUNT(*) FROM audit_log);")"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$DB_PATH" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
u = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
a = con.execute("SELECT COUNT(*) FROM audit_log").fetchone()[0]
print(f"库内统计: users={u}, audit_log={a}")
PY
  fi
fi
echo "最近备份:"
ls -lh "$ROOT/backups"/dbscout-server-*.sqlite 2>/dev/null | tail -n 5 || echo "  (暂无)"
`;
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArgs(argv);
  if (config.help) {
    printHelp();
    return 0;
  }

  let validatedBinary = null;
  let validatedDb = null;
  if (config.mode === "deploy" && config.binaryPath) {
    validatedBinary = validateLinuxElfBinary(config.binaryPath);
  }
  if (config.mode === "migrate-db") {
    validatedDb = validateMigrationSqliteFile(config.migrateDbPath, {
      allowWal: config.allowWal,
    });
  }

  if (config.dryRun) {
    const plan = {
      mode: config.mode,
      target: `${config.user}@${config.host}:${config.sshPort}`,
      remoteDir: config.remoteDir,
      serverUrl: `http://${config.host}:${config.serverPort}`,
      binaryPath: validatedBinary,
      migrateDbPath: validatedDb,
      forceOverwriteDb: config.forceOverwriteDb,
    };
    console.log("[dry-run] 校验通过，将按以下计划执行（未连接远端）：");
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  const ssh = createSshClient(config);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-deploy-"));
  try {
    if (config.mode === "status") {
      ssh.execPipe(buildRemoteStatusScript(config));
      return 0;
    }

    if (config.mode === "backup") {
      ssh.execPipe(`set -euo pipefail\n${shellQuote(`${config.remoteDir}/scripts/backup-blackcat-db.sh`)}\n`);
      return 0;
    }

    if (config.mode === "migrate-db") {
      console.log(`正在准备远端目录 ${config.remoteDir}/data ...`);
      ssh.execPipe(`set -euo pipefail\nmkdir -p ${shellQuote(`${config.remoteDir}/data`)}\n`);
      console.log(`正在上传数据库文件到 ${config.host} ...`);
      ssh.upload(validatedDb, `${config.remoteDir}/data/dbscout-server.sqlite.incoming`);
      ssh.execPipe(buildRemoteMigrateScript(config));
      return 0;
    }

    console.log(`正在打包部署文件（目标: ${config.user}@${config.host} -> ${config.remoteDir}）...`);
    const archivePath = createDeployBundle(config, tempRoot);
    ssh.execPipe(`set -euo pipefail\nmkdir -p ${shellQuote(`${config.remoteDir}/bin`)}\n`);
    ssh.upload(archivePath, `${config.remoteDir}/.blackcat-server-bundle.tar.gz`);
    if (validatedBinary) {
      console.log(`正在上传预编译 Linux 二进制 ${validatedBinary} ...`);
      ssh.upload(validatedBinary, `${config.remoteDir}/bin/dbscout-server.new`);
    }
    ssh.execPipe(buildRemoteDeployScript(config, Boolean(validatedBinary)));
    return 0;
  } finally {
    ssh.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
