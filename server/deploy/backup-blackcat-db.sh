#!/usr/bin/env bash
# Safe online backup for Blackcat central SQLite database (WAL-safe).
# Keeps daily backups under /home/blackcat-server/backups and prunes old ones.
set -euo pipefail

ROOT="${BLACKCAT_SERVER_ROOT:-/home/blackcat-server}"
DB_PATH="${DBSCOUT_SERVER_DB:-$ROOT/data/dbscout-server.sqlite}"
BACKUP_DIR="${BLACKCAT_BACKUP_DIR:-$ROOT/backups}"
KEEP_DAYS="${BLACKCAT_BACKUP_KEEP_DAYS:-30}"
KEEP_MIN="${BLACKCAT_BACKUP_KEEP_MIN:-7}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "跳过备份: 尚未找到数据库文件 $DB_PATH"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/dbscout-server-${STAMP}.sqlite"
TMP_TARGET="${TARGET}.tmp"
rm -f "$TMP_TARGET"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$TMP_TARGET'"
  CHECK="$(sqlite3 "$TMP_TARGET" "PRAGMA quick_check;" | head -n 1 || true)"
  if [[ "$CHECK" != "ok" ]]; then
    rm -f "$TMP_TARGET"
    echo "错误: 备份完整性校验失败 ($CHECK)" >&2
    exit 1
  fi
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$DB_PATH" "$TMP_TARGET" <<'PY'
import sqlite3, sys
src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(src_path, timeout=5.0)
dst = sqlite3.connect(dst_path)
try:
    src.backup(dst)
    row = dst.execute("PRAGMA quick_check;").fetchone()
    if not row or row[0] != "ok":
        raise RuntimeError(f"integrity check failed: {row}")
finally:
    dst.close()
    src.close()
PY
else
  # Neither sqlite3 nor python3 is installed. Refuse to copy an active WAL DB unsafely.
  if [[ -s "${DB_PATH}-wal" ]]; then
    echo "错误: 服务器缺少 sqlite3 与 python3，且数据库存在未合并的 WAL 文件，无法在线安全备份。请先安装 sqlite3 或 python3。" >&2
    exit 1
  fi
  cp -p "$DB_PATH" "$TMP_TARGET"
fi

mv "$TMP_TARGET" "$TARGET"
chmod 600 "$TARGET" || true
echo "备份完成: $TARGET ($(du -h "$TARGET" | awk '{print $1}'))"

# Prune old backups beyond KEEP_DAYS while always retaining at least KEEP_MIN newest files.
mapfile -t ALL_BACKUPS < <(ls -1t "$BACKUP_DIR"/dbscout-server-*.sqlite 2>/dev/null || true)
TOTAL="${#ALL_BACKUPS[@]}"
if (( TOTAL > KEEP_MIN )); then
  CUTOFF="$(date -d "${KEEP_DAYS} days ago" +%s 2>/dev/null || echo 0)"
  for ((i = KEEP_MIN; i < TOTAL; i++)); do
    FILE="${ALL_BACKUPS[$i]}"
    if (( CUTOFF > 0 )); then
      MTIME="$(stat -c %Y "$FILE" 2>/dev/null || echo 0)"
      if (( MTIME > 0 && MTIME < CUTOFF )); then
        rm -f "$FILE"
      fi
    fi
  done
fi
