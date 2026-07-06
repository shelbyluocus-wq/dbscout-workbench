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
npm run fetch-node       # one-time per platform: fetch portable Node 22 → src-tauri/resources/node/
npm run build
cd src-tauri && cargo check
```

### Bundling for distribution

`npm run fetch-node` downloads a pinned Node.js runtime (default: Node 22 LTS for the host platform) into `src-tauri/resources/node/` so the AI sidecar runs without depending on the user's system Node install. Run it once before each release build. To target a different platform, pass `--target=`:

```bash
node scripts/fetch-node.mjs --target=win32-x64
node scripts/fetch-node.mjs --target=darwin-arm64
node scripts/fetch-node.mjs --target=linux-x64
```

The script tries Tsinghua → npmmirror.com (Aliyun) → mirrors.aliyun.com → nodejs.org in order, so it works on networks where the official mirror is slow. Override with `DBSCOUT_NODE_MIRROR=https://your-mirror/` if needed.

The resulting `resources/node/node[.exe]` is gitignored; coworkers running an installed app get the bundled copy via Tauri's resource directory. Developers running `cargo run` / `tauri dev` fall back to the system `node` if no bundled copy exists.

## AI agent

The AI assistant ships its own Node runtime and Claude Code native CLI, so coworkers do not need to install Claude Code locally. Authentication can be supplied by environment variables at launch:

```bash
DBSCOUT_AGENT_AUTH_TOKEN=... DBSCOUT_AGENT_BASE_URL=https://... npm run tauri -- dev
```

For release packaging, place private credentials in gitignored `src-tauri/resources/agent-auth.local.json` before building, for example:

```json
{ "authToken": "...", "baseUrl": "https://...", "model": "..." }
```

The checked-in `src-tauri/resources/agent-auth.json` is intentionally empty. Without an explicit override, DB Scout reuses the computer's working Claude Code credentials and endpoint settings. When `apiKey` or `authToken` is supplied through the release file, environment variables, or the Agent settings gear, DB Scout uses a DB Scout-owned Claude config directory and passes the credential to the embedded runtime, so the UI-provided endpoint is isolated from local Claude settings. If neither path is configured, the Agent opens DB Scout's own API configuration experience instead of asking the user to run `/login`.

Users can still override API Key, Auth Token, Base URL, and model from the Agent settings gear; those overrides are saved in `localStorage`. Do not commit real credentials to `agent-auth.json`.
