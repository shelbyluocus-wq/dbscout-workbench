Bundled Windows Subversion command-line client for in-app updates.

The svn.exe and supporting DLLs are not committed. On Windows they are
downloaded by `npm run fetch-svn` / `npm run ensure-svn` from the pinned
Apache Subversion package before `tauri build`.
