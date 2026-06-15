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
