#!/usr/bin/env bash
# Manage the standalone Blackcat central server (dbscout-server) on Linux.
# Completely isolated under /home/blackcat-server (never touches /home/gmserv).
set -euo pipefail

ROOT="${BLACKCAT_SERVER_ROOT:-/home/blackcat-server}"
BIN="${BLACKCAT_SERVER_BIN:-$ROOT/bin/dbscout-server}"
DB_PATH="${DBSCOUT_SERVER_DB:-$ROOT/data/dbscout-server.sqlite}"
BIND_ADDR="${DBSCOUT_SERVER_BIND:-0.0.0.0:8765}"
PORT="${BLACKCAT_SERVER_PORT:-${BIND_ADDR##*:}}"
HEALTH_HOST="${BIND_ADDR%:*}"
case "$HEALTH_HOST" in
  0.0.0.0) HEALTH_HOST=127.0.0.1 ;;
  '[::]') HEALTH_HOST='[::1]' ;;
esac
HEALTH_URL="http://$HEALTH_HOST:$PORT"
SERVICE_NAME="${BLACKCAT_SERVICE_NAME:-blackcat-server}"
PID_FILE="$ROOT/run/server.pid"
LOG_FILE="$ROOT/logs/server.log"

has_systemd_service() {
  command -v systemctl >/dev/null 2>&1 \
    && [[ -d /run/systemd/system ]] \
    && [[ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]]
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(tr -dc '0-9' < "$PID_FILE" || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

http_status() {
  local path="$1"
  local url="$HEALTH_URL$path"
  if command -v curl >/dev/null 2>&1; then
    curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || echo "000"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$url" <<'PY'
import sys, urllib.request, urllib.error
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=2) as resp:
        print(resp.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print("000")
PY
    return
  fi
  echo "000"
}

health_once() {
  local health_code me_code
  health_code="$(http_status /health)"
  me_code="$(http_status /me)"
  [[ "$health_code" == "200" && ( "$me_code" == "401" || "$me_code" == "200" ) ]]
}

wait_healthy() {
  local attempts="${1:-20}"
  for ((i = 1; i <= attempts; i++)); do
    if health_once; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

start_service() {
  mkdir -p "$ROOT/bin" "$ROOT/data" "$ROOT/backups" "$ROOT/table-backups" "$ROOT/logs" "$ROOT/run"
  if [[ ! -x "$BIN" ]]; then
    echo "错误: 找不到可执行文件 $BIN" >&2
    return 1
  fi
  if has_systemd_service; then
    systemctl start "$SERVICE_NAME"
  else
    if read_pid >/dev/null 2>&1; then
      echo "blackcat-server 已在运行 (pid=$(read_pid))"
      return 0
    fi
    cd "$ROOT"
    DBSCOUT_SERVER_BIND="$BIND_ADDR" \
    DBSCOUT_SERVER_DB="$DB_PATH" \
    DBSCOUT_SERVER_MAX_REVISIONS_PER_TABLE="${DBSCOUT_SERVER_MAX_REVISIONS_PER_TABLE:-0}" \
    DBSCOUT_SERVER_AUDIT_DETAILED_DAYS="${DBSCOUT_SERVER_AUDIT_DETAILED_DAYS:-14}" \
    DBSCOUT_SERVER_AUDIT_DAILY_DAYS="${DBSCOUT_SERVER_AUDIT_DAILY_DAYS:-180}" \
    DBSCOUT_SERVER_COMPACT_TIME="${DBSCOUT_SERVER_COMPACT_TIME:-02:00}" \
    DBSCOUT_SERVER_GM_BACKUP_DIR="${DBSCOUT_SERVER_GM_BACKUP_DIR:-/home/servbin/dbback}" \
    DBSCOUT_SERVER_TABLE_BACKUP_DIR="${DBSCOUT_SERVER_TABLE_BACKUP_DIR:-$ROOT/table-backups}" \
    DBSCOUT_SERVER_TABLE_BACKUP_MAX_VERSIONS="${DBSCOUT_SERVER_TABLE_BACKUP_MAX_VERSIONS:-60}" \
    DBSCOUT_SERVER_TABLE_BACKUP_TIME="${DBSCOUT_SERVER_TABLE_BACKUP_TIME:-01:15}" \
    RUST_LOG="${RUST_LOG:-dbscout_server=info,tower_http=info}" \
      nohup "$BIN" </dev/null >>"$LOG_FILE" 2>&1 &
    echo "$!" > "$PID_FILE"
  fi
  if ! wait_healthy 20; then
    echo "错误: blackcat-server 启动后健康检查失败 (port=$PORT)" >&2
    return 1
  fi
  echo "blackcat-server 启动成功 ($HEALTH_URL)"
}

stop_service() {
  if has_systemd_service; then
    systemctl stop "$SERVICE_NAME" || true
  else
    local pid
    if pid="$(read_pid)"; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
  echo "blackcat-server 已停止"
}

restart_service() {
  if has_systemd_service; then
    systemctl restart "$SERVICE_NAME"
    if ! wait_healthy 20; then
      echo "错误: blackcat-server 重启后健康检查失败 (port=$PORT)" >&2
      return 1
    fi
    echo "blackcat-server 重启成功 ($HEALTH_URL)"
  else
    stop_service
    start_service
  fi
}

status_service() {
  if has_systemd_service; then
    echo "托管方式: systemd (${SERVICE_NAME})"
    systemctl is-active "$SERVICE_NAME" || true
  else
    echo "托管方式: nohup"
    local pid
    if pid="$(read_pid)"; then
      echo "状态: active (pid=$pid)"
    else
      echo "状态: stopped"
    fi
  fi
  echo "监听端口: ${PORT}"
  echo "数据文件: ${DB_PATH}"
  echo "健康检查: /health=$(http_status /health) /me=$(http_status /me)"
}

case "${1:-status}" in
  start) start_service ;;
  stop) stop_service ;;
  restart) restart_service ;;
  status) status_service ;;
  health)
    if health_once; then
      echo "ok (/health=200 /me=$(http_status /me))"
    else
      echo "unhealthy (/health=$(http_status /health) /me=$(http_status /me))" >&2
      exit 1
    fi
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|health}" >&2
    exit 1
    ;;
esac
