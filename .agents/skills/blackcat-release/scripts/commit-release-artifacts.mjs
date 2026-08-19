import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export const RELEASE_TRACKED_FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "Cargo.lock",
  "src/workbench/appVersion.js",
  "latest.json",
];

export function buildReleaseCommitMessage({ appVersion, agentRuntimeVersion } = {}) {
  if (appVersion) {
    if (!/^\d+\.\d+\.\d+$/.test(appVersion)) {
      throw new Error(`app version must use x.y.z format: ${appVersion}`);
    }
    return `chore(release): bump version to ${appVersion}`;
  }
  if (agentRuntimeVersion != null && agentRuntimeVersion !== "") {
    if (!/^[1-9]\d*$/.test(String(agentRuntimeVersion))) {
      throw new Error(`agent runtime version must be a positive integer: ${agentRuntimeVersion}`);
    }
    return `chore(release): bump agent runtime to ${agentRuntimeVersion}`;
  }
  throw new Error("app version or agent runtime version is required");
}

export function parsePorcelainForAllowlist(output, allowlist = RELEASE_TRACKED_FILES) {
  const allowed = new Set(allowlist.map(normalizeGitPath));
  const files = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = porcelainPath(line);
    if (!allowed.has(file)) continue;
    if (code.includes("U") || code === "AA" || code === "DD") {
      throw new Error(`release file has a merge conflict: ${file}`);
    }
    files.push(file);
  }
  return [...new Set(files)];
}

function normalizeGitPath(value) {
  return String(value || "").trim().replaceAll("\\", "/");
}

function porcelainPath(line) {
  let file = line.slice(3);
  if (file.startsWith('"') && file.endsWith('"')) {
    file = file.slice(1, -1).replaceAll("\\n", "\n").replaceAll('\\"', '"');
  }
  if (file.includes(" -> ")) file = file.slice(file.lastIndexOf(" -> ") + 4);
  return normalizeGitPath(file);
}

function runGit(repoRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr || error.message || error).trim();
    throw new Error(stderr || `git ${args.join(" ")} failed`);
  }
}

function hasRemote(repoRoot, name) {
  const remotes = runGit(repoRoot, ["remote"]).split(/\r?\n/).filter(Boolean);
  return remotes.includes(name);
}

function refExists(repoRoot, ref) {
  try {
    runGit(repoRoot, ["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

export function listChangedReleaseFiles(repoRoot, allowlist = RELEASE_TRACKED_FILES) {
  const output = runGit(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  return parsePorcelainForAllowlist(output, allowlist);
}

export function commitReleaseArtifacts({
  repoRoot,
  appVersion,
  agentRuntimeVersion,
  push = true,
  remote = "origin",
  branch = "main",
} = {}) {
  if (!repoRoot || !path.isAbsolute(repoRoot)) {
    throw new Error("repo root must be an absolute directory");
  }

  const message = buildReleaseCommitMessage({ appVersion, agentRuntimeVersion });
  const currentBranch = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch !== branch) {
    throw new Error(`release commits must be made on ${branch}, current branch is ${currentBranch}`);
  }

  if (push) {
    if (!hasRemote(repoRoot, remote)) {
      throw new Error(`${remote} remote is required to push release commits`);
    }
    runGit(repoRoot, ["fetch", remote]);
    const upstream = `${remote}/${branch}`;
    if (refExists(repoRoot, upstream)) {
      runGit(repoRoot, ["merge", "--ff-only", upstream]);
    }
  }

  const changedFiles = listChangedReleaseFiles(repoRoot);
  let commitSha = runGit(repoRoot, ["rev-parse", "HEAD"]);
  let action = "skipped";

  if (changedFiles.length > 0) {
    runGit(repoRoot, ["add", "--", ...changedFiles]);
    runGit(repoRoot, ["commit", "-m", message]);
    commitSha = runGit(repoRoot, ["rev-parse", "HEAD"]);
    action = "committed";
  }

  if (push) {
    const upstream = `${remote}/${branch}`;
    const remoteSha = refExists(repoRoot, upstream)
      ? runGit(repoRoot, ["rev-parse", upstream])
      : null;
    if (remoteSha !== commitSha) {
      runGit(repoRoot, ["push", remote, branch]);
      action = action === "committed" ? "committed-and-pushed" : "pushed";
    }
  }

  return {
    action,
    branch,
    commitSha,
    files: changedFiles,
    message: action === "skipped" ? null : message,
    pushed: action === "committed-and-pushed" || action === "pushed",
  };
}

function readArguments(argv) {
  const values = {};
  let push = true;
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--no-push") {
      push = false;
      continue;
    }
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    values[name] = value;
    index += 1;
  }
  return {
    repoRoot: path.resolve(values["--repo"] || process.cwd()),
    appVersion: values["--version"],
    agentRuntimeVersion: values["--agent-runtime-version"],
    push,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  try {
    const result = commitReleaseArtifacts(readArguments(process.argv.slice(2)));
    if (result.action === "skipped") {
      console.log("No tracked release files to commit; git push was not needed.");
    } else {
      console.log(`Git ${result.action}: ${result.commitSha} (${result.branch})`);
      if (result.files.length > 0) {
        console.log(`Files: ${result.files.join(", ")}`);
      }
      if (result.message) console.log(`Message: ${result.message}`);
    }
  } catch (error) {
    console.error(`Release git publish failed: ${error.message || error}`);
    process.exitCode = 1;
  }
}
