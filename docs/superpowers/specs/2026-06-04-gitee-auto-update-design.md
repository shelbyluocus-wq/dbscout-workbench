# Gitee Auto Update Design

**Status:** Approved by user on 2026-06-04.

## Goal

Add an in-app auto-update workflow for DB Scout Workbench that uses a free
mainland-friendly distribution path. When a new version is published, users can
see an update notice inside the app, review release notes, download the signed
update package, install it, and move to the latest version.

The first production update source is Gitee only. Aliyun OSS, Tencent COS, CDN,
and self-hosted paid services are out of scope for this version because the
user wants a free solution.

## Chosen Release Source

Use a public Gitee release repository:

- Release repository: `shelbylouis/dbscout-workbench-release`
- Manifest URL:
  `https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json`
- Versioned release URL pattern:
  `https://gitee.com/shelbylouis/dbscout-workbench-release/releases/tag/v<version>`
- Windows updater asset URL pattern:
  `https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v<version>/DBScoutWorkbench_<version>_x64-setup.exe`

The release repository must be public because the Tauri updater checks for
updates without user-specific authentication. The app repository remains
separate from the release repository so installer binaries do not bloat the
source Git history.

Gitee community limits are part of the design:

- Release attachments must stay at or below 100 MB per file.
- The release repository must stay within the free attachment quota.
- The release process must fail loudly if a required updater artifact exceeds
  the free limit.

If a future installer cannot fit inside Gitee's free attachment limit, the app
code remains usable, but a new free distribution decision is required before
that version can be published through the updater.

## Tauri Updater Architecture

Use Tauri v2's official updater plugin with a static JSON manifest.

Backend/native configuration:

- Add `tauri-plugin-updater` and `tauri-plugin-process` to the Rust side.
- Initialize both plugins in `src-tauri/src/lib.rs`.
- Enable updater artifact creation in `src-tauri/tauri.conf.json`.
- Configure the Gitee `latest.json` URL as the updater endpoint.
- Add the updater public key to `tauri.conf.json`; the matching private key is
  never committed.
- Use Windows `installMode: "passive"` so the installer can show native progress
  while avoiding extra user decisions.
- Add capability permissions `updater:default` and `process:default` for the
  main window.

Frontend configuration:

- Add `@tauri-apps/plugin-updater` for `check()` and
  `downloadAndInstall()`.
- Add `@tauri-apps/plugin-process` for `relaunch()`.
- Keep browser-only `npm run dev` usable by providing a no-op/mock updater
  adapter when Tauri internals are unavailable.

Tauri validates signatures before installing updates. The public key embedded
in the app is safe to publish. The private signing key is a release secret; if
it is lost, already installed clients cannot trust newly signed updates.

## Manifest Format

The release manifest is a static `latest.json` file in the release repository.
It uses Tauri's platform map format:

```json
{
  "version": "0.2.0",
  "notes": "Short release notes shown in the update dialog.",
  "pub_date": "2026-06-04T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<exact .sig file contents>",
      "url": "https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe"
    }
  }
}
```

The manifest may include `darwin-x86_64` and `darwin-aarch64` entries when
macOS updater artifacts are built and uploaded under the same free Gitee
constraints. It must not include incomplete platform entries; a platform entry
is only published when both its URL and signature have been verified.

## Release Flow

Add release tooling for the free Gitee path:

1. Synchronize the version across `package.json`, `package-lock.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
   `src-tauri/tauri.conf.json`.
2. Build the frontend and signed Tauri bundle.
3. Read the generated `.sig` file exactly as trimmed text.
4. Check each artifact size against Gitee's free release attachment limit.
5. Upload the installer/update artifact to the Gitee release `v<version>`.
6. Generate `latest.json` with the verified artifact URL and signature.
7. Commit or update `latest.json` in the release repository.
8. Fetch the raw remote `latest.json`, parse it, and verify:
   - `version` equals the new app version.
   - the platform URL points to the `v<version>` release.
   - the remote signature equals the local `.sig`.
9. Verify the release asset URL with a `HEAD` request or ranged `GET`.

The source repository should contain scripts and documentation for this flow,
but credentials and signing keys stay outside Git. Gitee upload can be manual
through the web UI for the first version, with script-assisted verification so
the critical manifest and asset checks are still repeatable.

## App Update Behavior

The app checks for updates in two situations:

- Once after startup, after existing connection/workspace restoration starts.
- Manually when the user clicks the titlebar update control.

The updater must not block database work. A startup check runs in the
background and reports only meaningful results:

- No update: keep the titlebar quiet and set the updater status to current.
- Update found: show a compact titlebar badge and allow opening the dialog.
- Check failed: do not interrupt the user; the dialog can show the error after
  a manual check.
- Browser dev mode: show "desktop updater unavailable" only if the user manually
  opens the update dialog.

This is not a push notification service. Users receive the notice when they run
the app and it reaches the Gitee manifest.

## UI Design

Add a compact updater entry to the custom titlebar, placed between the app
brand and the native window controls:

- Normal state: small icon button with current version tooltip.
- Checking state: subdued spinner or pulse.
- Update available: accent badge and text such as `0.2.0`.
- Error after manual check: subtle warning state, not a modal interruption.

Add `UpdateDialog.vue` as a focused dialog component. It uses existing
`wb-dialog-*` styles and extends `workbench.css` with updater-specific tokens
and classes.

Dialog states:

- Current: current version, "already up to date", last checked time, close.
- Checking: progress text and disabled actions.
- Available: current version, latest version, publish date, notes, "Later" and
  "Download and install".
- Downloading: determinate progress when content length is known; otherwise
  indeterminate progress with downloaded byte count.
- Installed: "Restart now" primary action and "Restart later" secondary action.
- Error: readable error message plus "Check again".

The dialog must be concise and work in both light and dark themes. It should not
look like a marketing page or a separate settings screen. It is a small utility
surface in the workbench chrome.

## Frontend Boundaries

Create a small updater domain:

- `src/workbench/composables/useUpdater.js`
  owns updater state, checking, downloading, installing, progress accounting,
  and relaunch requests.
- `src/workbench/utils/updaterAdapter.js`
  wraps Tauri updater/process imports and exposes a browser-safe fallback.
- `src/workbench/components/UpdateDialog.vue`
  renders the dialog and emits check/install/relaunch/close events.
- `src/workbench/MySqlWorkbench.vue`
  wires the composable to the titlebar and dialog only. It does not contain the
  updater algorithm.

The composable state shape should be easy to test without a Tauri runtime:

- `status`: `idle`, `checking`, `current`, `available`, `downloading`,
  `installed`, or `error`.
- `currentVersion`
- `availableUpdate`
- `downloadedBytes`
- `contentLength`
- `lastCheckedAt`
- `errorMessage`
- `isDialogOpen`

## Error Handling

Handle these cases explicitly:

- Gitee manifest not reachable.
- Manifest reachable but invalid for Tauri.
- No matching platform entry.
- Signature mismatch or install rejection.
- Download progress without content length.
- Download/install interrupted.
- Relaunch denied because process permissions are missing.
- Browser-only development mode with no Tauri updater.

Errors should be visible when the user asks for updater status. Startup errors
should not steal focus from database work.

## Security And Privacy

- All update endpoints use HTTPS.
- No Gitee access token is embedded in the app.
- The updater private key is stored outside the repository, preferably under
  the developer's user profile or CI secret storage.
- `latest.json` contains only release metadata, package URLs, release notes, and
  signatures.
- The app does not send database connection data, schema names, or usage data to
  the update endpoint.

## Verification

Add tests before implementation:

- Updater adapter falls back cleanly in browser mode.
- `useUpdater` transitions from idle to current when no update exists.
- `useUpdater` records update metadata and opens the available state.
- Download progress computes percentages and handles unknown content length.
- Install completion exposes the relaunch action.
- Manual check errors are visible without corrupting existing update metadata.
- `MySqlWorkbench.vue` renders the titlebar updater entry and dialog wiring.
- `UpdateDialog.vue` contains states for current, available, downloading,
  installed, and error.
- `tauri.conf.json` includes updater endpoint, artifact creation, public key,
  and Windows passive install mode.
- `capabilities/main.json` includes updater and process permissions.
- Release manifest generation rejects missing signatures and oversized Gitee
  artifacts.

Final verification after implementation:

- `node --test src/workbench`
- `npm run build`
- `cd src-tauri && cargo check`
- `cd src-tauri && cargo test`
- Manually run browser dev mode and confirm updater fallback UI.
- In a desktop build or updater harness, verify the app can read a Gitee
  `latest.json` and present update metadata.

## Out Of Scope

- Paid object storage, paid CDN, or self-hosted paid update servers.
- Background push notifications while the app is closed.
- Forced updates.
- Beta/canary channels.
- Rollback/downgrade support.
- Telemetry about update checks or installs.
- Committing signing private keys or Gitee tokens.
