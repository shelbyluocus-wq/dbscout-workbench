# Gitee Auto Update Release Checklist

This project uses the free Gitee updater path for mainland-China friendly desktop updates.

## Release Repository

- Public repo: `shelbylouis/dbscout-workbench-release`
- Raw manifest: `https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json`
- Attachment limit: 100 MB per file on the free Gitee path
- Keep old release attachments trimmed so the release repo remains within the free quota

## Signing Key

Private key path on the release machine:

```text
C:\Users\Administrator\.tauri\dbscout-workbench.key
```

Set this before building. Tauri v2 reads the private key path or private key content from `TAURI_SIGNING_PRIVATE_KEY`:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="$env:USERPROFILE\.tauri\dbscout-workbench.key"
```

## Release Steps

1. Sync versions:

```powershell
npm run release:sync-version -- 0.2.0
```

2. Build signed bundle:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY="$env:USERPROFILE\.tauri\dbscout-workbench.key"
npm run tauri -- build
```

If the build produces the installer but no `.sig` file, sign the installer manually:

```powershell
npm run tauri -- signer sign --private-key-path "$env:USERPROFILE\.tauri\dbscout-workbench.key" --password= "src-tauri\target\release\bundle\nsis\DB Scout Workbench_0.2.0_x64-setup.exe"
```

3. Upload the Windows setup `.exe` from `src-tauri\target\release\bundle\nsis` to Gitee release `v0.2.0`.

4. Generate `latest.json` after the Gitee attachment URL is available:

```powershell
node scripts/gitee-updater-manifest.mjs --version 0.2.0 --artifact "src-tauri\target\release\bundle\nsis\DBScoutWorkbench_0.2.0_x64-setup.exe" --signature "src-tauri\target\release\bundle\nsis\DBScoutWorkbench_0.2.0_x64-setup.exe.sig" --url "https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe" --out latest.json
```

5. Commit or upload `latest.json` to the root of `shelbylouis/dbscout-workbench-release`.

6. Verify the raw manifest and installer URL before announcing the release:

```powershell
Invoke-WebRequest "https://gitee.com/shelbylouis/dbscout-workbench-release/raw/master/latest.json" -UseBasicParsing
Invoke-WebRequest "https://gitee.com/shelbylouis/dbscout-workbench-release/releases/download/v0.2.0/DBScoutWorkbench_0.2.0_x64-setup.exe" -Method Head -UseBasicParsing
```

## Notes

- The current documented free release path covers Windows x64 installers.
- macOS can use the same manifest format after signed/notarized artifacts are available by passing `--platform darwin-x86_64` or `--platform darwin-aarch64` to the manifest script.
- Do not commit the private signing key to this repository.
