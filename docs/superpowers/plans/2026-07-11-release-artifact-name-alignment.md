# Release Artifact Name Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Windows installer and `latest.json` use the same canonical `blackcat_<version>_x64-setup.exe` filename while preserving the displayed product name `黑猫`.

**Architecture:** Keep manifest construction in `scripts/svn-updater-manifest.mjs`, adding a canonical filename helper and validation. Add `scripts/package-release.mjs` as the release orchestrator that runs the existing Tauri build, renames its NSIS output, writes `latest.json`, and validates the final release pair.

**Tech Stack:** Node.js ESM, `node:test`, Tauri CLI, NSIS

---

### Task 1: Enforce the canonical manifest filename

**Files:**
- Modify: `scripts/svn-updater-manifest.test.mjs`
- Modify: `scripts/svn-updater-manifest.mjs`

- [ ] **Step 1: Write the failing filename tests**

Add tests that import `windowsInstallerName`, expect
`windowsInstallerName("0.1.10")` to equal
`blackcat_0.1.10_x64-setup.exe`, and expect `createManifest` to reject
`黑猫_0.1.10_x64-setup.exe` for `windows-x86_64`.

```js
assert.equal(windowsInstallerName("0.1.10"), "blackcat_0.1.10_x64-setup.exe");
assert.throws(
  () => createManifest({
    version: "0.1.10",
    artifactPath: "黑猫_0.1.10_x64-setup.exe",
  }),
  /must be named blackcat_0\.1\.10_x64-setup\.exe/,
);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/svn-updater-manifest.test.mjs`

Expected: FAIL because `windowsInstallerName` is not exported.

- [ ] **Step 3: Implement minimal canonical-name validation**

Export a helper that validates SemVer and returns the canonical name. In
`createManifest`, reject a default Windows artifact whose basename differs.

```js
export function windowsInstallerName(version) {
  assertSemver(version);
  return `blackcat_${version}_x64-setup.exe`;
}

if (platform === "windows-x86_64") {
  const expectedName = windowsInstallerName(version);
  if (artifactName !== expectedName) {
    throw new Error(`Windows installer must be named ${expectedName}`);
  }
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test scripts/svn-updater-manifest.test.mjs`

Expected: all tests pass.

### Task 2: Add the release packaging orchestrator

**Files:**
- Create: `scripts/package-release.test.mjs`
- Create: `scripts/package-release.mjs`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write the failing release finalization test**

Use a real temporary directory containing
`target/release/bundle/nsis/黑猫_0.1.10_x64-setup.exe`. Call the wished-for
`finalizeWindowsRelease` API and assert that the source is renamed, the
canonical destination exists, and root `latest.json` points to the destination.
Add a second temporary-directory case where both source and destination exist,
and assert that finalization rejects the conflict without changing either file.

```js
const result = finalizeWindowsRelease({
  root,
  version: "0.1.10",
  pubDate: "2026-07-11T00:00:00.000Z",
});
assert.equal(path.basename(result.artifactPath), "blackcat_0.1.10_x64-setup.exe");
assert.equal(result.manifest.platforms["windows-x86_64"].path, path.basename(result.artifactPath));
assert.throws(
  () => finalizeWindowsRelease({ root: conflictRoot, version: "0.1.10" }),
  /already exists/,
);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test scripts/package-release.test.mjs`

Expected: FAIL because `scripts/package-release.mjs` does not exist.

- [ ] **Step 3: Implement minimal release orchestration**

Implement `finalizeWindowsRelease({ root, version, pubDate })` using `fs.renameSync`
and `createManifest`, and implement the CLI flow:

```js
if (!process.argv.includes("--skip-build")) {
  execFileSync(npmCommand(), ["run", "tauri", "--", "build"], {
    cwd: root,
    stdio: "inherit",
  });
}
finalizeWindowsRelease({ root, version: readPackageVersion(root) });
```

After writing the manifest, read it back and verify its version and Windows path
match the destination file, and verify the destination exists.

- [ ] **Step 4: Expose the future release command**

Add this script to `package.json`:

```json
"release:package": "node scripts/package-release.mjs"
```

Document `npm run release:package` in both repository instruction files as the
canonical command that builds, renames, and updates `latest.json`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:
`node --test scripts/svn-updater-manifest.test.mjs scripts/package-release.test.mjs`

Expected: all tests pass.

### Task 3: Finalize and verify release 0.1.10

**Files:**
- Modify: `latest.json`
- Rename generated artifact under: `target/release/bundle/nsis/`

- [ ] **Step 1: Finalize the existing build without recompiling**

Run: `npm run release:package -- --skip-build`

Expected: rename the existing Chinese-named installer to
`blackcat_0.1.10_x64-setup.exe` and update root `latest.json` to `0.1.10`.

- [ ] **Step 2: Run release verification**

Run the focused Node tests, parse `latest.json`, confirm its declared file
exists beside the generated NSIS output, inspect the executable product version,
and run `git diff --check`.

Expected: version `0.1.10`, exact filename match, non-empty installer, product
version `0.1.10`, no whitespace errors.
