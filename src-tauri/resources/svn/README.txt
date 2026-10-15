Bundled Windows Subversion command-line clients for updates and table transfer.

The svn.exe and supporting DLLs are not committed. On Windows they are
downloaded by `npm run fetch-svn` / `npm run ensure-svn` from the pinned
Apache Subversion packages before `tauri build`.

The default client (1.14.5) lives in this directory. The SSL compatibility
client (1.9.7) and its own DLLs/licenses live in compat-1.9.7/. Do not mix DLLs.
Both archives have pinned sizes and SHA-256 hashes in scripts/fetch-svn.mjs.
DBSCOUT_SVN_URL and DBSCOUT_SVN_COMPAT_URL override their download locations
without bypassing verification.

An update retries once with the other client only for E120171 SSL communication
errors, never for certificate validation, authentication or working-copy errors.
Successful compatibility choices are saved per HTTPS server (scheme/host/port)
in svn-client-preferences.json under the app configuration directory. Install
upgrades preserve these choices; no installation paths or credentials are saved.
