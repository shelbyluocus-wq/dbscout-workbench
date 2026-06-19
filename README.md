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

The AI assistant panel is gated by an in-app onboarding screen on first launch — coworkers only need to enter their own API Key; the company Base URL and model are pre-filled. Settings are persisted in `localStorage` and can be edited via the gear icon.

Claude Code CLI itself is bundled (`src-tauri/resources/claude-code-native.exe`); coworkers do not need to install it.
