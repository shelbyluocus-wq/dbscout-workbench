// Command-line build for Cocos Creator, as documented in "Publish from the
// Command Line": 3.x takes `--project` and reports through its exit code
// (36 success, 32 invalid build options, 34 build error); 2.4 takes `--path`
// and documents no exit codes, so only 0 counts as success there. Build
// options travel in one quoted `--build` argument separated by semicolons.
// The editor still needs a desktop session even when started this way.

export const COCOS_EXIT = Object.freeze({ SUCCESS: 36, INVALID_OPTIONS: 32, BUILD_ERROR: 34 });

export function cocosMajorVersion(version) {
  const major = Number.parseInt(String(version ?? "").trim(), 10);
  return Number.isFinite(major) && major > 0 ? major : 0;
}

/** Where Cocos Dashboard installs an editor version by default. */
export function defaultCocosEditorPath(version, { mac = false } = {}) {
  const value = String(version || "").trim();
  return mac
    ? `/Applications/Cocos/Creator/${value}/CocosCreator.app/Contents/MacOS/CocosCreator`
    : `C:\\ProgramData\\cocos\\editors\\Creator\\${value}\\CocosCreator.exe`;
}

function quoteArgument(value) {
  const text = String(value);
  return /[\s;"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * Build the process invocation. `configPath` is a build configuration
 * exported from the Build panel; without it the platform and a few common
 * options are passed explicitly.
 */
export function cocosBuildCommand({
  editorPath,
  projectPath,
  version,
  platform = "web-mobile",
  configPath = "",
  debug = false,
  md5Cache = true,
  logPath = "",
}) {
  const modern = cocosMajorVersion(version) >= 3;
  const options = [];
  if (configPath) options.push(`configPath=${configPath}`);
  if (!configPath || !modern) options.push(`platform=${platform}`);
  if (!configPath) options.push(`debug=${Boolean(debug)}`, `md5Cache=${Boolean(md5Cache)}`);
  if (modern && logPath) options.push(`logDest=${logPath}`);
  const args = [modern ? "--project" : "--path", String(projectPath || ""), "--build", options.join(";")];
  const program = String(editorPath || "");
  return { program, args, display: [program, ...args].map(quoteArgument).join(" ") };
}

/** "success", "invalidOptions", "buildError" or "unknown". */
export function describeCocosExit(version, code) {
  if (cocosMajorVersion(version) >= 3) {
    if (code === COCOS_EXIT.SUCCESS) return "success";
    if (code === COCOS_EXIT.INVALID_OPTIONS) return "invalidOptions";
    if (code === COCOS_EXIT.BUILD_ERROR) return "buildError";
    return "unknown";
  }
  return code === 0 ? "success" : "unknown";
}
