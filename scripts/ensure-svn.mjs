// Ensures the Windows updater can ship its own svn.exe. Production installers
// include the files fetched into `src-tauri/resources/svn/`. The directory is
// gitignored, so Windows `tauri dev` / `tauri build` fetch the pinned package
// when it is missing. Set DBSCOUT_SKIP_SVN_FETCH=1 to bypass the download.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SVN_PACKAGES, bundledSvnExists, fetchSvn } from "./fetch-svn.mjs";

const SKIP = process.env.DBSCOUT_SKIP_SVN_FETCH === "1";

export async function ensureSvn({ platform = process.platform } = {}) {
  if (SKIP) {
    console.log("[ensure-svn] DBSCOUT_SKIP_SVN_FETCH=1, skipping");
    return;
  }
  if (platform !== "win32") return;
  for (const packageSpec of SVN_PACKAGES) {
    if (bundledSvnExists(undefined, packageSpec)) continue;
    console.log("[ensure-svn] Bundled SVN client missing, fetching…");
    await fetchSvn({ packageSpec });
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  ensureSvn().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
