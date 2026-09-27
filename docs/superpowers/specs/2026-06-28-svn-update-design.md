# SVN Update Directory Design

**Status:** Approved by user on 2026-06-28.

## Goal

Replace the Gitee/browser-based updater with a simple company-LAN workflow:
the publisher copies release files into a company SVN working copy, and each
installed app updates that working copy on startup before checking for a new
version.

The user experience should be:

1. On first use, the app asks the user to select the local SVN update folder.
2. The app remembers that folder.
3. On startup and manual checks, the app runs `svn update` for that folder.
4. If the SVN update succeeds, the app reads local release metadata from the
   updated folder.
5. If a newer version exists, the app prompts the user.
6. After confirmation, the app runs the local installer and then offers to
   relaunch or tells the user what failed.
7. If SVN update fails, the app shows the error and opens the update folder so
   the user can resolve permissions, locks, or conflicts.

No HTTP server, fixed IP, Gitee release page, browser automation, or public
download URL is required.

## Replaced Gitee Scope

The earlier Gitee updater design is superseded by this design.

Remove or stop using these Gitee-specific pieces:

- Gitee updater endpoint in `src-tauri/tauri.conf.json`.
- Frontend copy that names Gitee as the update source.
- Gitee-only missing-manifest error translation.
- `release:gitee-manifest` script and Gitee attachment-size checks.
- Tests that require the updater to point at
  the retired release repository.

The Tauri updater plugin may also be removed if the final implementation runs
the local installer directly. The `process` plugin can stay if it is still used
for restart behavior.

## Release Folder Layout

The SVN folder name is not fixed. The app only needs the user to select the
correct local folder once.

Inside that folder, release files follow a fixed layout:

```text
<selected svn update folder>/
  latest.json
  blackcat_<version>_x64-setup.exe
  blackcat_<version>_x64-setup.exe.sig
```

The actual installer filename can keep the current product name convention,
including Chinese characters. `latest.json` is the stable contract and points
to the installer filename.

Manifest format:

```json
{
  "version": "0.1.5",
  "notes": "Release notes shown in the app.",
  "pub_date": "2026-06-28T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "path": "blackcat_0.1.5_x64-setup.exe",
      "signature": "<optional signature text>"
    }
  }
}
```

The manifest deliberately uses a local relative `path`, not an HTTP URL.

## SVN Command Strategy

Use `svn.exe` as the first implementation target.

Resolution order:

1. Bundled `svn.exe` under the app resources (`resources/svn/svn.exe` on Windows).
2. `svn.exe` on `PATH`, if the user or IT installed command-line SVN.
3. Clear error explaining that SVN command-line tools are missing.

The app should not depend on TortoiseSVN UI automation. TortoiseSVN may be
installed on some machines, but the app update path should be command-line and
predictable.

Running update:

```text
svn update "<selected folder>"
```

The backend captures exit code, stdout, and stderr. A non-zero exit code is an
update failure and should be shown to the user.

## Backend Components

Add a small Rust module for SVN updater behavior, for example
`src-tauri/src/svn_updater.rs`.

Responsibilities:

- Store and load the selected SVN update folder path.
- Open a folder picker when no folder is configured or when the user chooses to
  change it.
- Validate that the selected folder exists.
- Resolve `svn.exe`.
- Run `svn update`.
- Read and validate `latest.json`.
- Compare the manifest version with the current app version.
- Resolve the installer path inside the selected folder.
- Open the selected folder in Windows Explorer after SVN update errors.
- Launch the installer when the user confirms installation.

Expose focused Tauri commands:

- `svn_update_get_config`
- `svn_update_pick_directory`
- `svn_update_check`
- `svn_update_install`
- `svn_update_open_directory`

The commands should return structured objects rather than raw strings wherever
possible so the frontend can show clear states.

## Frontend Components

Keep the current updater surface, but swap the implementation underneath it.

Use these boundaries:

- `src/workbench/utils/updaterAdapter.js`
  becomes an adapter over the new Tauri SVN update commands.
- `src/workbench/composables/useUpdater.js`
  keeps the state machine and dialog wiring, but its copy changes from
  "download" language to "update/install from SVN folder" language.
- `src/workbench/components/UpdateDialog.vue`
  keeps the existing compact dialog, adding states for selecting a folder and
  SVN update failure.
- `src/workbench/MySqlWorkbench.vue`
  keeps startup check and titlebar wiring.

Normal startup checks should not interrupt the user unless a new version is
available. Manual checks may open the dialog for configuration or errors.

## Error Handling

Handle these cases explicitly:

- No SVN update folder selected yet.
- Selected folder no longer exists.
- `svn.exe` is missing.
- `svn update` exits with an error.
- `latest.json` is missing after a successful SVN update.
- `latest.json` is invalid.
- Manifest has no Windows installer entry.
- Installer file listed in the manifest does not exist.
- Installer launch fails, including permission/UAC-related failure.

For SVN update failures, the app should automatically open the selected update
folder after showing the error. This supports conflict and lock cleanup without
requiring the app to understand every SVN edge case.

## Permissions And Admin Rights

SVN update itself does not need administrator privileges if the user already
has permission to update that working copy.

Installing the new app version may trigger Windows permissions depending on
where the current app was installed. The app should try the install first and
only show an error if Windows refuses or the installer fails to start.

## Release Tooling

Replace the Gitee manifest script with a local SVN manifest script, for example:

```text
npm run release:svn-manifest -- --version 0.1.5 --artifact <setup.exe> --out <svn-folder>/latest.json
```

The script should:

- Validate SemVer.
- Read the generated `.sig` if available.
- Copy or reference the installer filename.
- Write `latest.json` with a relative installer path.

Publishing then becomes a human-friendly two-step process:

1. Build the signed installer.
2. Copy installer, signature, and `latest.json` into the SVN release folder and
   commit them with the normal SVN client.

## Verification

Add focused tests for:

- Browser fallback when Tauri commands are unavailable.
- No-folder configuration state.
- Successful available-update response from a local manifest.
- SVN update failure preserving the error and requesting folder open behavior.
- Missing installer file becomes a readable error.
- Dialog copy no longer references Gitee.
- Tauri config no longer contains the Gitee update endpoint.
- Release manifest script writes a relative local path.

Manual verification:

- Configure a test SVN working copy folder.
- Run a check with no newer version.
- Update `latest.json` to a newer version and confirm the dialog opens.
- Break the SVN working copy or point to a bad folder and confirm the app shows
  the error and opens the folder.
- Launch the installer from the update dialog.

## Out Of Scope

- Hosting a LAN HTTP server.
- Using fixed IP addresses.
- Gitee release publication.
- Browser automation for releases.
- Forced updates.
- Automatic SVN conflict resolution.
- Supporting macOS updater files in this SVN flow.
