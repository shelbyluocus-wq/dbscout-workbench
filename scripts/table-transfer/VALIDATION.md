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

## 2026-10-22: Finder/Dock SVN locale regression

The earlier temporary-SVN test inherited the terminal locale and did not exercise
Finder's missing locale. The shared production SVN runner now sets LANG and
LC_ALL to en_US.UTF-8 on macOS only, without modifying the parent environment.
Nine SVN-client tests passed in each of two environments: all locale variables
unset, and LANG/LC_ALL/LC_CTYPE=C. The opt-in integration test runs real SVN
checkout, info, update and status on a temporary Chinese/space-named working copy
through the production runner. The real game assets directory was checked with
read-only `svn info`; no game files were updated or copied.

Built and installed the debug app in /Applications, verified its ad-hoc signature,
and retained the previous app as a verified ZIP backup. Removed the duplicate
build bundle from Spotlight eligibility. No commit or push performed.

## 2026-10-22: server-specific legacy TLS

Read-only `svn info --non-interactive --show-item revision` against the actual
Juesheng SVN URL reproduced E120171 with the default TLS policy. The previously
used legacy OpenSSL policy reached certificate verification, which failed with
E230001 (issuer not trusted). Thus real-server connectivity is NOT yet complete;
an administrator-verified CA/certificate is required. No certificate bypass or
permanent trust exception was installed; no game working copy was updated.

macOS now supports an explicit `svn-legacy-tls.json` map in the app config folder:
exact HTTPS origin -> absolute existing OpenSSL config path. Only that client's
child process receives OPENSSL_CONF. Legacy updates ignore externals to avoid
applying a weak policy to another server. Certificate errors remain failures and
produce actionable feedback. Windows fallback behavior is unchanged.

## Explicit certificate approval

The user approved trusting 192.168.1.187 as in Cairn. The local
`svn-trusted-servers.json` contains only that exact HTTPS origin. Its SVN child
receives Cairn's certificate-exception flag; update still ignores externals.
Other servers retain normal certificate validation. Tests verify the exception
is absent without opt-in and present with opt-in.

A real read-only request now passes TLS/certificate validation and reaches
E215004 (authentication failed). No usable credentials are available to this SVN
client. Cairn's password storage was not read or copied. A separate interactive
login is still required; do not claim full update success yet.
