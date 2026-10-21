# Validation on 2026-10-21 (Apple Silicon)

- Built and launched the debug macOS application bundle. Native UI shows the
  `.sh / .command` hint and opens the script picker.
- Ran the existing Juesheng 2 converter against `newsg_4cfg` on this Mac, with
  team alerts disabled. It processed 322 source tables; the existing filtering
  rules emitted 311 JSON tables plus generated types/keys and compressed data.
- Verified every emitted JSON table against the decompressed package.
- A deliberately nonexistent database exits nonzero and does not proceed to copy.
- 18 Rust transfer tests passed, including a real temporary SVN repository with
  Chinese/space paths, script execution, output discovery, SVN update, merge-copy
  preservation, and cancellation of a TERM-resistant descendant process.
- 26 focused JavaScript/launcher tests passed, including missing completion,
  stale output, missing files, inconsistent data, and empty-package rejection.
- Production frontend build passed. Whole-workbench suite: 2235 passed / 3 failed.
  Failures are existing activity-rail source assertion, the user's pre-existing
  macOS maximized setting, and an outdated SVN-updater source assertion; those
  unrelated behaviors were not changed to make the tests green.

No real game project was SVN-updated or overwritten; copy tests use temporary
repositories only. No database writes, team notifications, commits or pushes.
Windows-equivalence has not been verified: no same-snapshot Windows output was
available. Successive live Mac exports changed several activity tables, so those
runs cannot serve as a frozen-input cross-platform comparison.

Built app: `target/debug/bundle/macos/黑猫.app` (development bundle, not a release).
The installed `/Applications/黑猫.app` was not replaced.
