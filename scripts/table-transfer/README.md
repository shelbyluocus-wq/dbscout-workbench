# macOS client table conversion

Copy `juesheng2-macos.command` and `verify-output.mjs` beside the existing
`4区生成全部配置.bat` (two levels below the game tools folder). Select the
`.command` file in Blackcat and the game project containing `assets`.
The default database is `newsg_4cfg`; standalone invocation also accepts a database
name as the first argument. A double-click or Blackcat launch uses the default.

## Dependencies

Use macOS Node.js 22+ and Subversion. Blackcat checks PATH, Homebrew locations and
`~/.local/bin` (also when launched from Finder). Install dependencies from the game
tools package lock; do not reuse Windows native dependencies.

On this Mac, Node 22 and SVN 1.14.5 are installed in the user-owned
`~/.local/share/blackcat-tools/runtime`, with links in `~/.local/bin`.
The conda-forge APR-util build lacked charset conversion; APR-util 1.6.3 was
rebuilt with iconv support to handle Chinese paths. Replacing that environment's
APR-util package requires rechecking `svn status` on a Chinese path.

## Safety

The launcher does not revert/update SVN or delete source files. It generates a
new package and requires a successful exit, the converter's completion message,
a new timestamp directory, nonempty generated TypeScript files, and matching
JSON/compressed data. Blackcat then updates the selected project and merge-copies
`props` and `src/props`, preserving extra files. Choose manual conflict resolution
to stop before copying if SVN reports conflicts.

`converter-safety.patch` contains the changes applied to the local game converter:
nonzero exit on failure, rejection of empty databases, removal of credential
logging, and an opt-out for notification-free validation. Apply once from the game
tools folder with `patch -p1 < /path/to/converter-safety.patch`; review differences
first if the converter has changed. The patch excludes unchanged secrets.

Normal runs retain configuration alerts. Test with `DBSCOUT_SKIP_CONFIG_ALARMS=1`
to avoid sending team notifications. Tests read databases but never write them.

## Checks

- `node --test scripts/table-transfer/verify-output.test.mjs`
- `cargo test --manifest-path src-tauri/Cargo.toml table_transfer::tests --lib`
- `node scripts/table-transfer/verify-output.mjs '<output directory>'`

Mac script/project selection is manual; Windows discovery is unchanged.
Actual Windows-versus-Mac comparison requires output generated from the same
unchanged database. Local successful runs verify internal package consistency,
not byte-for-byte parity with an unavailable Windows build.
