#!/bin/bash
set -euo pipefail

# Place beside the existing Windows client conversion scripts (two levels below tools).
cd -- "$(dirname -- "$0")"
export PATH="${PATH}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
database="${1:-newsg_4cfg}"
if [[ ! "$database" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo 'Invalid database name.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22+ is required. Install the macOS Node.js runtime first.' >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo 'Node.js 22+ is required.' >&2
  exit 1
}
for required in ./verify-output.mjs ../../genPropCli.ts ../../propcfg.json ../../node_modules/ts-node/esm.mjs; do
  if [[ ! -f "$required" ]]; then
    echo "Missing $required. Place this launcher beside the Windows scripts and install the tools dependencies on Mac." >&2
    exit 1
  fi
done
# Do not revert/update SVN or copy into the game project here.
# The converter retains its existing configuration-alert behavior.
before="$(find "$database" -mindepth 1 -maxdepth 1 -type d -name '????-??-?? ??-??-??' 2>/dev/null || true)"
log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT
node --loader ../../node_modules/ts-node/esm.mjs --no-warnings ../../genPropCli.ts "$database" >"$log_file" 2>&1 &
converter_pid=$!
trap 'kill "$converter_pid" 2>/dev/null || true; exit 130' INT TERM
status=0
wait "$converter_pid" || status=$?
cat "$log_file"
if [[ "$status" -ne 0 ]] || ! grep -qx 'genBinProp end' "$log_file"; then
  echo 'Conversion did not complete. No files will be copied.' >&2
  exit 1
fi
output="$(find "$database" -mindepth 1 -maxdepth 1 -type d -name '????-??-?? ??-??-??' | LC_ALL=C sort | tail -1)"
if [[ -z "$output" ]] || printf '%s\n' "$before" | grep -Fxq -- "$output"; then
  echo 'No new output directory found. Refusing to copy an older package.' >&2
  exit 1
fi
node ./verify-output.mjs "$output"
