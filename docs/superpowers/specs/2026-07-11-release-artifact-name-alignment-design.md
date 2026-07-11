# Release Artifact Name Alignment Design

## Goal

Keep the installed product name as `黑猫` while making every Windows release
artifact match the filename published in `latest.json`:

```text
blackcat_<version>_x64-setup.exe
```

The current `0.1.10` release must also use this convention.

## Approach

Add one release packaging entry point that owns the Windows release flow:

1. Read the version from `package.json`.
2. Run the existing Tauri production build.
3. Locate the NSIS installer generated from the Chinese product name.
4. Rename it to `blackcat_<version>_x64-setup.exe` in the same output folder.
5. Generate the root `latest.json` from the renamed artifact.
6. Fail the command unless the manifest version, manifest path, and real
   artifact filename all match.

The Tauri `productName` and the installed application name remain `黑猫`.

## Components

- `scripts/package-release.mjs`: orchestrates build, rename, manifest creation,
  and final validation.
- `scripts/svn-updater-manifest.mjs`: keeps manifest construction focused and
  exposes reusable filename validation where appropriate.
- Node tests: cover the canonical filename, mismatch rejection, and release
  path resolution without running a full desktop build.
- `package.json`: exposes a single release command for future packaging.

## Error Handling

The release command stops with an actionable error when the version is invalid,
the generated installer is missing, the destination filename conflicts, or the
manifest does not point to the renamed file. It must not publish a manifest that
references a nonexistent installer.

## Verification

- Run the focused Node release-script tests.
- Run the release command for version `0.1.10`.
- Confirm `latest.json` declares version `0.1.10` and path
  `blackcat_0.1.10_x64-setup.exe`.
- Confirm that exact installer exists and the old Chinese-named installer is no
  longer the release artifact handed to users.
