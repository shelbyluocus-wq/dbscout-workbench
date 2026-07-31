# DB Scout Workbench

Standalone NimbleKit-style database workbench built with Tauri 2, Rust, Vue, and Vite.

This app is intentionally separate from the original `dbsearch` project. It can be moved, versioned, and built independently.

## Run

```bash
npm install
npm run tauri -- dev
```

The frontend dev server uses port `1431`.

## MySQL

Without configuration, the app runs against built-in demo tables.

To connect to a real MySQL server, set:

```bash
export DBSCOUT_MYSQL_URL="mysql://user:password@127.0.0.1:3306"
npm run tauri -- dev
```

The first phase focuses on database reading/editing: connection tree, table sessions, paging, filtering, sorting, inline cell saving, insert row, delete row, and quick search.

## Build

```bash
npm run build
cd src-tauri && cargo check
```

### Bundling for distribution

Use the canonical release command for Windows distribution:

```bash
npm run release:package
```

It builds the desktop app, renames the installer to
`blackcat_<version>_x64-setup.exe`, and updates `latest.json` to reference that
exact filename. The installed product name remains **黑猫**.

The main installer deliberately excludes portable Node and the native Claude
CLI, and the release command fails if those resources are added back or the
Windows installer exceeds 20 MB.

Publish the AI runtime separately into the SVN release working copy:

```bash
npm run release:agent-runtime -- --version 1 --output-dir E:\path\to\navicat
```

The integer version is explicit and changes only when Node or the native CLI
changes. The command prepares the local sources, creates
`agent-runtime-v1-win-x64.zip`, calculates SHA-256, and writes
`agent-runtime.json`. Re-running identical content at the same version is a
no-op; different content requires a higher version. Use `--min-app-version` to
override the default minimum (the current application version).

`npm run fetch-node` downloads pinned Node 22 into
`src-tauri/resources/node/` for desktop development and AI-runtime packaging.
It is not part of the main application build. To prepare another platform,
pass `--target=`:

```bash
node scripts/fetch-node.mjs --target=win32-x64
node scripts/fetch-node.mjs --target=darwin-arm64
```

The script tries Tsinghua → npmmirror.com (Aliyun) → mirrors.aliyun.com → nodejs.org in order, so it works on networks where the official mirror is slow. Override with `DBSCOUT_NODE_MIRROR=https://your-mirror/` if needed.

The resulting `resources/node/node[.exe]` is gitignored. `npm run tauri -- dev`
fetches and uses it directly; installed production apps instead install the
separately published runtime under their application-data directory on first
AI use.

## AI agent

The AI assistant downloads its managed Node runtime and Claude Code native CLI
from the configured SVN release directory the first time the AI panel is
opened, so coworkers do not need to install Claude Code locally. Runtime
updates happen independently in the background; failure leaves the previous
valid runtime usable and never blocks database features. Authentication can be
supplied by environment variables at launch:

```bash
DBSCOUT_AGENT_AUTH_TOKEN=... DBSCOUT_AGENT_BASE_URL=https://... npm run tauri -- dev
```

For release packaging, place private credentials in gitignored `src-tauri/resources/agent-auth.local.json` before building, for example:

```json
{ "authToken": "...", "baseUrl": "https://...", "model": "..." }
```

The checked-in `src-tauri/resources/agent-auth.json` is intentionally empty. Without an explicit override, DB Scout reuses the computer's working Claude Code credentials and endpoint settings. When `apiKey` or `authToken` is supplied through the release file, environment variables, or the Agent settings gear, DB Scout uses a DB Scout-owned Claude config directory and passes the credential to the embedded runtime, so the UI-provided endpoint is isolated from local Claude settings. If neither path is configured, the Agent opens DB Scout's own API configuration experience instead of asking the user to run `/login`.

Users can still override API Key, Auth Token, Base URL, and model from the Agent settings gear; those overrides are saved in `localStorage`. Do not commit real credentials to `agent-auth.json`.
