#!/usr/bin/env node
/**
 * Build a clean, self-contained deployment zip for the standalone Blackcat
 * central server (`dbscout-server`) on 192.168.1.243.
 *
 * Contains ONLY the server crate (`server/`), deploy scripts/templates, and a
 * pruned Cargo.lock — zero Blackcat desktop/client source code.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_REMOTE_DIR,
  DEFAULT_SERVER_PORT,
  REPO_ROOT,
  generateStandaloneWorkspaceCargoToml,
  renderDeployTemplates,
} from "./deploy-blackcat-server.mjs";

const __filename = fileURLToPath(import.meta.url);

const PACKAGE_ROOT_NAME = "blackcat-server-243";
const DEFAULT_OUTPUT_ZIP = path.join(REPO_ROOT, "output", "blackcat-server-243-package.zip");

function buildInstallOn243Script() {
  return `#!/usr/bin/env bash
# 在 192.168.1.243 上独立安装/升级黑猫中心服务（dbscout-server）。
# 严禁触碰 /home/gmserv 及任何 GM 进程/端口/数据库。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ROOT="\${BLACKCAT_SERVER_ROOT:-${DEFAULT_REMOTE_DIR}}"
PORT="\${BLACKCAT_SERVER_PORT:-${DEFAULT_SERVER_PORT}}"
PREBUILT_BINARY=""

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --binary)
      PREBUILT_BINARY="\${2:-}"
      shift 2
      ;;
    --root)
      ROOT="\${2:-}"
      shift 2
      ;;
    --port)
      PORT="\${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "用法: bash install-on-243.sh [--binary /path/to/linux/dbscout-server] [--root /home/blackcat-server] [--port 8766]"
      exit 0
      ;;
    *)
      echo "未知参数: \$1" >&2
      exit 1
      ;;
  esac
done

ROOT="\${ROOT%/}"
if [[ -z "\$ROOT" || "\$ROOT" != /* || "\$ROOT" == "/" || "\$ROOT" == "/home/gmserv" || "\$ROOT" == /home/gmserv/* ]]; then
  echo "错误: 拒绝安装到不安全或 GM 目录 (\$ROOT)" >&2
  exit 1
fi

mkdir -p "\$ROOT/bin" "\$ROOT/data" "\$ROOT/backups" "\$ROOT/logs" "\$ROOT/run" "\$ROOT/scripts"

render_file() {
  local src="\$1" dst="\$2" mode="\$3"
  sed -e 's/\\r\$//' \
      -e "s|/home/blackcat-server|\$ROOT|g" \
      -e "s|0.0.0.0:8766|0.0.0.0:\$PORT|g" \
      "\$src" > "\$dst"
  chmod "\$mode" "\$dst"
}

render_file "\$SCRIPT_DIR/deploy/run-blackcat-server.sh" "\$ROOT/scripts/run-blackcat-server.sh" 755
render_file "\$SCRIPT_DIR/deploy/backup-blackcat-db.sh" "\$ROOT/scripts/backup-blackcat-db.sh" 755

# 升级前对已有数据库做一次在线热备份（首次无库时自动跳过）
"\$ROOT/scripts/backup-blackcat-db.sh"

if [[ -n "\$PREBUILT_BINARY" ]]; then
  if [[ ! -f "\$PREBUILT_BINARY" ]]; then
    echo "错误: 找不到预编译文件 \$PREBUILT_BINARY" >&2
    exit 1
  fi
  if ! head -c 4 "\$PREBUILT_BINARY" | od -An -tx1 | tr -d ' \\n' | grep -qi '^7f454c46\$'; then
    echo "错误: \$PREBUILT_BINARY 不是 Linux ELF 可执行文件" >&2
    exit 1
  fi
  install -m 755 "\$PREBUILT_BINARY" "\$ROOT/bin/dbscout-server.new"
else
  export PATH="\$HOME/.cargo/bin:\$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "错误: 当前机器未安装 Rust (cargo)。可选以下任一方式：" >&2
    echo "  1) 安装一次 Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source \\"\$HOME/.cargo/env\\"" >&2
    echo "  2) 在其他 Linux 机器进入本包 src/ 执行 cargo build --release --locked -p dbscout-server，再用 --binary 传入编译产物" >&2
    exit 2
  fi
  mkdir -p "\$ROOT/src"
  rm -rf "\$ROOT/src/server"
  cp "\$SCRIPT_DIR/src/Cargo.toml" "\$ROOT/src/Cargo.toml"
  cp "\$SCRIPT_DIR/src/Cargo.lock" "\$ROOT/src/Cargo.lock"
  cp -R "\$SCRIPT_DIR/src/server" "\$ROOT/src/server"
  echo "正在编译 dbscout-server (release)..."
  (cd "\$ROOT/src" && cargo build --release --locked -p dbscout-server)
  install -m 755 "\$ROOT/src/target/release/dbscout-server" "\$ROOT/bin/dbscout-server.new"
fi

if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
  render_file "\$SCRIPT_DIR/deploy/blackcat-server.service" /etc/systemd/system/blackcat-server.service 644
  render_file "\$SCRIPT_DIR/deploy/blackcat-server-backup.service" /etc/systemd/system/blackcat-server-backup.service 644
  render_file "\$SCRIPT_DIR/deploy/blackcat-server-backup.timer" /etc/systemd/system/blackcat-server-backup.timer 644
  systemctl daemon-reload
  systemctl enable blackcat-server.service >/dev/null
  systemctl enable --now blackcat-server-backup.timer >/dev/null
else
  echo "提示: 未检测到 systemd，使用 run-blackcat-server.sh (nohup) 托管。"
  if command -v crontab >/dev/null 2>&1; then
    CRON_LINE="0 4 * * * \$ROOT/scripts/backup-blackcat-db.sh >> \$ROOT/logs/backup.log 2>&1"
    (crontab -l 2>/dev/null | grep -v "backup-blackcat-db.sh" || true; echo "\$CRON_LINE") | crontab -
  fi
fi

HAD_PREV=0
if [[ -f "\$ROOT/bin/dbscout-server" ]]; then
  cp -p "\$ROOT/bin/dbscout-server" "\$ROOT/bin/dbscout-server.prev"
  HAD_PREV=1
fi
mv -f "\$ROOT/bin/dbscout-server.new" "\$ROOT/bin/dbscout-server"
chmod 755 "\$ROOT/bin/dbscout-server"

if ! "\$ROOT/scripts/run-blackcat-server.sh" restart; then
  echo "警告: 新版本健康检查失败，自动回滚到上一版本..." >&2
  if [[ "\$HAD_PREV" == "1" ]]; then
    mv -f "\$ROOT/bin/dbscout-server.prev" "\$ROOT/bin/dbscout-server"
    "\$ROOT/scripts/run-blackcat-server.sh" restart || true
  fi
  exit 1
fi

"\$ROOT/scripts/run-blackcat-server.sh" status
echo "安装完成！请确认防火墙仅对局域网放行 \${PORT}/tcp（禁止对公网开放）。"
`;
}

function buildMigrateDbOn243Script() {
  return `#!/usr/bin/env bash
# 在 192.168.1.243 上安全导入旧机（192.168.1.193）导出的 dbscout-server.sqlite。
set -euo pipefail

ROOT="\${BLACKCAT_SERVER_ROOT:-${DEFAULT_REMOTE_DIR}}"
DB_PATH="\$ROOT/data/dbscout-server.sqlite"
FORCE=0
ALLOW_WAL=0
SRC_DB=""

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --force)
      FORCE=1
      shift
      ;;
    --allow-wal)
      ALLOW_WAL=1
      shift
      ;;
    --root)
      ROOT="\${2:-}"
      DB_PATH="\${ROOT%/}/data/dbscout-server.sqlite"
      shift 2
      ;;
    -h|--help)
      echo "用法: bash migrate-db-on-243.sh /path/to/dbscout-server.sqlite [--force]"
      exit 0
      ;;
    *)
      if [[ -z "\$SRC_DB" ]]; then
        SRC_DB="\$1"
        shift
      else
        echo "未知参数: \$1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "\$SRC_DB" || ! -f "\$SRC_DB" ]]; then
  echo "错误: 请提供有效的 dbscout-server.sqlite 文件路径" >&2
  exit 1
fi

HEADER="\$(head -c 15 "\$SRC_DB" 2>/dev/null || true)"
if [[ "\$HEADER" != "SQLite format 3" ]]; then
  echo "错误: 文件头不是有效的 SQLite 3 数据库 (\$SRC_DB)" >&2
  exit 1
fi

if [[ "\$ALLOW_WAL" != "1" && -s "\${SRC_DB}-wal" ]]; then
  echo "错误: 检测到非空 WAL 文件 (\${SRC_DB}-wal)。请确认旧机服务已停并导出完整单文件后再迁移。" >&2
  exit 1
fi

count_rows() {
  local target="\$1"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "\$target" "SELECT (SELECT COUNT(*) FROM users) || ',' || (SELECT COUNT(*) FROM audit_log);" 2>/dev/null || echo "?,?"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "\$target" <<'PY'
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

mkdir -p "\$ROOT/data" "\$ROOT/backups"

if [[ -f "\$DB_PATH" ]]; then
  EXISTING="\$(count_rows "\$DB_PATH")"
  if [[ "\$EXISTING" != "0,0" && "\$FORCE" != "1" ]]; then
    echo "拒绝覆盖: 243 上已有非空库 (\$DB_PATH, users,audit=\$EXISTING)。如确认覆盖请加 --force（覆盖前会自动备份）。" >&2
    exit 1
  fi
  if [[ -x "\$ROOT/scripts/backup-blackcat-db.sh" ]]; then
    "\$ROOT/scripts/backup-blackcat-db.sh"
  else
    cp -p "\$DB_PATH" "\$ROOT/backups/pre-migrate-\$(date +%Y%m%d-%H%M%S).sqlite"
  fi
fi

if [[ -x "\$ROOT/scripts/run-blackcat-server.sh" ]]; then
  "\$ROOT/scripts/run-blackcat-server.sh" stop
fi

rm -f "\$DB_PATH-wal" "\$DB_PATH-shm"
cp -f "\$SRC_DB" "\$DB_PATH"
chmod 600 "\$DB_PATH" || true

if [[ -x "\$ROOT/scripts/run-blackcat-server.sh" ]]; then
  "\$ROOT/scripts/run-blackcat-server.sh" start
fi

FINAL="\$(count_rows "\$DB_PATH")"
echo "迁移完成: \$DB_PATH (users,audit_log=\$FINAL，已按每表最近 20 次改动自动精简)"
`;
}

function buildPackageReadme() {
  return `# 黑猫中心服务（dbscout-server）243 独立部署包

本压缩包**仅包含黑猫中心服务源码与 Linux 托管脚本**，不含任何黑猫客户端/桌面端源码。

## 关键说明

- **与 GM 完全隔离**：默认安装到 \`/home/blackcat-server\`，监听 \`8766/tcp\`，**不碰 \`/home/gmserv\`、GM 进程、8700/8701 端口及任何 MySQL 数据库**。
- **仅限局域网访问**：本服务为公司内网无密码（用户名 + Token）共享变更日志服务，**请确认 243 防火墙仅对局域网放行 \`8766/tcp\`，严禁对公网开放**。
- **自动控体积**：默认每张表只保留最近 **20 次改动**（\`DBSCOUT_SERVER_MAX_REVISIONS_PER_TABLE=20\`），启动与每次写入自动清理旧记录，日常仅占几十 MB；同时配好每日 04:00 在线热备份到 \`/home/blackcat-server/backups/\`。

## 第 1 步：在 243 上解压并部署启动

\`\`\`bash
unzip -o blackcat-server-243-package.zip -d /tmp/
cd /tmp/blackcat-server-243
bash install-on-243.sh
\`\`\`

> 若 243 尚未安装 Rust（\`cargo\`），可任选其一：
> 1. 在 243 安装一次 Rust 后重跑 \`bash install-on-243.sh\`：
>    \`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source "$HOME/.cargo/env"\`
> 2. 或在任意其他 Linux 机器进入本包 \`src/\` 目录执行 \`cargo build --release --locked -p dbscout-server\`，把编译出的二进制拷到 243 后执行：
>    \`bash install-on-243.sh --binary /path/to/dbscout-server\`

验证（从局域网其他电脑测试）：
- \`GET http://192.168.1.243:8766/health\` → 返回 \`200\`（\`{"status":"ok"}\`）
- \`GET http://192.168.1.243:8766/me\` → 返回 \`401\`（未携带 Token 时正常拦截）
- 确认 GM \`8701/8700\` 不受任何影响。

## 第 2 步：导入旧机（192.168.1.193）导出的历史数据库

拿到从 193 导出的 \`dbscout-server.sqlite\` 后，传到 243 执行：

\`\`\`bash
bash /tmp/blackcat-server-243/migrate-db-on-243.sh /path/to/dbscout-server.sqlite
\`\`\`

脚本会自动先备份现有库、停服、放入旧库并重启（启动后自动将每张表精简到最近 20 次改动，同时保留全部老账号与 Token）。

## 日常运维命令（在 243 上执行）

\`\`\`bash
# 查看状态与健康检查
/home/blackcat-server/scripts/run-blackcat-server.sh status

# 手动触发一次在线热备份
/home/blackcat-server/scripts/backup-blackcat-db.sh

# 查看日志（systemd 托管）
journalctl -u blackcat-server -n 50 --no-pager
\`\`\`
`;
}

export function buildStandalonePackage(outputZip = DEFAULT_OUTPUT_ZIP) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-server-pkg-"));
  const pkgRoot = path.join(tempRoot, PACKAGE_ROOT_NAME);
  const deployDir = path.join(pkgRoot, "deploy");
  const srcDir = path.join(pkgRoot, "src");
  const serverDst = path.join(srcDir, "server");

  try {
    fs.mkdirSync(deployDir, { recursive: true });
    fs.mkdirSync(path.join(serverDst, "src"), { recursive: true });

    // 1. Copy ONLY server crate files (zero desktop/client files).
    fs.copyFileSync(
      path.join(REPO_ROOT, "server", "Cargo.toml"),
      path.join(serverDst, "Cargo.toml"),
    );
    const serverSrcDir = path.join(REPO_ROOT, "server", "src");
    for (const file of fs.readdirSync(serverSrcDir)) {
      if (!file.endsWith(".rs")) continue;
      fs.copyFileSync(path.join(serverSrcDir, file), path.join(serverDst, "src", file));
    }
    fs.writeFileSync(
      path.join(srcDir, "Cargo.toml"),
      generateStandaloneWorkspaceCargoToml(),
      "utf8",
    );
    fs.copyFileSync(path.join(REPO_ROOT, "Cargo.lock"), path.join(srcDir, "Cargo.lock"));

    // Prune Cargo.lock so it contains ONLY dbscout-server's locked dependency graph (no desktop/tauri entries).
    const cargoBin = fs.existsSync(path.join(os.homedir(), ".cargo", "bin", "cargo"))
      ? path.join(os.homedir(), ".cargo", "bin", "cargo")
      : "cargo";
    try {
      execFileSync(cargoBin, ["metadata", "--offline", "--format-version", "1"], {
        cwd: srcDir,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      execFileSync(cargoBin, ["metadata", "--format-version", "1"], {
        cwd: srcDir,
        stdio: ["ignore", "ignore", "inherit"],
      });
    }

    // 2. Render Linux deploy templates (LF line endings).
    const templates = renderDeployTemplates({
      remoteDir: DEFAULT_REMOTE_DIR,
      serverPort: DEFAULT_SERVER_PORT,
    });
    for (const [name, content] of Object.entries(templates)) {
      const target = path.join(deployDir, name);
      fs.writeFileSync(target, content, "utf8");
      if (name.endsWith(".sh")) {
        fs.chmodSync(target, 0o755);
      }
    }

    // 3. Write package root scripts and README.
    const installPath = path.join(pkgRoot, "install-on-243.sh");
    const migratePath = path.join(pkgRoot, "migrate-db-on-243.sh");
    fs.writeFileSync(installPath, buildInstallOn243Script(), "utf8");
    fs.writeFileSync(migratePath, buildMigrateDbOn243Script(), "utf8");
    fs.chmodSync(installPath, 0o755);
    fs.chmodSync(migratePath, 0o755);
    fs.writeFileSync(path.join(pkgRoot, "README.md"), buildPackageReadme(), "utf8");

    // 4. Zip into output path.
    fs.mkdirSync(path.dirname(outputZip), { recursive: true });
    if (fs.existsSync(outputZip)) {
      fs.rmSync(outputZip, { force: true });
    }
    execFileSync("zip", ["-rq", outputZip, PACKAGE_ROOT_NAME], {
      cwd: tempRoot,
      stdio: "inherit",
    });
    return outputZip;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const customOut = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT_ZIP;
  const zipPath = buildStandalonePackage(customOut);
  const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`已生成独立部署包: ${zipPath} (${sizeKb} KB)`);
}
