// Command-line build for Cocos Creator, as documented in "Publish from the
// Command Line": 3.x takes `--project` and reports through its exit code
// (36 success, 32 invalid build options, 34 build error); 2.4 takes `--path`
// and documents no exit codes, so only 0 counts as success there. Build
// options travel in one `--build` argument separated by semicolons. The
// editor still needs a desktop session even when started this way. The
// backend (cocos_build.rs) builds the same arguments from the same options;
// this module shows them and checks the choices before a build starts.

export const COCOS_EXIT = Object.freeze({ SUCCESS: 36, INVALID_OPTIONS: 32, BUILD_ERROR: 34 });

// Common publish targets per major version; any other platform id Cocos
// knows can be typed in. Native targets need the platform SDKs set up in
// the editor's preferences.
export const COCOS_PLATFORMS = Object.freeze({
  3: Object.freeze([
    "android", "ios", "windows", "mac", "web-mobile", "web-desktop",
    "wechatgame", "bytedance-mini-game", "alipay-mini-game", "huawei-quick-game",
    "oppo-mini-game", "vivo-mini-game", "xiaomi-quick-game",
  ]),
  2: Object.freeze([
    "android", "ios", "win32", "mac", "web-mobile", "web-desktop",
    "wechatgame", "baidugame", "alipay", "qgame", "quickgame", "huawei", "fb-instant-games",
  ]),
});
const NATIVE_PLATFORMS = Object.freeze({
  3: new Set(["android", "ios", "windows", "mac", "ohos", "openharmony"]),
  2: new Set(["android", "ios", "win32", "mac", "android-instant"]),
});
export const COCOS_PLATFORM_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;

export function cocosMajorVersion(version) {
  const major = Number.parseInt(String(version ?? "").trim(), 10);
  return Number.isFinite(major) && major > 0 ? major : 0;
}

/** 3 for Cocos Creator 3.x, 2 for 2.4 and older 2.x, 0 when unknown. */
export function cocosFamily(version) {
  const major = cocosMajorVersion(version);
  if (major >= 3) return 3;
  return major === 2 ? 2 : 0;
}

export function cocosPlatformsFor(version) {
  return COCOS_PLATFORMS[cocosFamily(version) || 3];
}

export function isNativeCocosPlatform(version, platform) {
  return NATIVE_PLATFORMS[cocosFamily(version) || 3].has(platform);
}

/** Where Cocos Dashboard installs an editor version by default. */
export function defaultCocosEditorPath(version, { mac = false } = {}) {
  const value = String(version || "").trim();
  return mac
    ? `/Applications/Cocos/Creator/${value}/CocosCreator.app/Contents/MacOS/CocosCreator`
    : `C:\\ProgramData\\cocos\\editors\\Creator\\${value}\\CocosCreator.exe`;
}

function separatorOf(path) {
  return String(path || "").includes("\\") ? "\\" : "/";
}

function joinPath(base, ...parts) {
  const separator = separatorOf(base);
  return [String(base || "").replace(/[\\/]+$/, ""), ...parts.filter(Boolean)].join(separator);
}

export function isAbsolutePath(path) {
  return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(String(path || ""));
}

/** A build configuration path relative to the project, or an absolute one. */
export function resolveProjectPath(projectPath, path) {
  const value = String(path || "").trim();
  if (!value) return "";
  return isAbsolutePath(value) ? value : joinPath(projectPath, value.replace(/^\.[\\/]/, ""));
}

/** The build options a platform's settings describe. */
export function cocosBuildOptions(platform = {}) {
  return {
    editorPath: String(platform.cocosPath || ""),
    projectPath: String(platform.targetClient || ""),
    version: String(platform.cocosVersion || ""),
    platform: String(platform.buildPlatform || ""),
    configPath: resolveProjectPath(platform.targetClient, platform.buildConfig),
    outputName: String(platform.buildOutputName || "").trim(),
    debug: platform.buildDebug === true,
    md5Cache: platform.buildMd5Cache !== false,
    qaGuard: platform.buildQaGuard !== false,
  };
}

/**
 * Where the build lands: 3.x writes build/<output name or platform>; 2.4
 * writes native projects to build/jsb-link and others to build/<platform>.
 */
export function cocosOutputDir({ projectPath, version, platform, outputName = "" }) {
  if (!projectPath) return "";
  const family = cocosFamily(version) || 3;
  if (family >= 3) return joinPath(projectPath, "build", outputName || platform);
  return joinPath(projectPath, "build", NATIVE_PLATFORMS[2].has(platform) ? "jsb-link" : platform);
}

function quoteArgument(value) {
  const text = String(value);
  return /[\s;"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** The `--build` value. Options a build configuration sets are left to it. */
export function cocosBuildArgument({ version, platform = "web-mobile", configPath = "", debug = false, md5Cache = true, outputName = "", logPath = "" }) {
  const modern = cocosFamily(version) !== 2;
  const options = [];
  if (configPath) options.push(`configPath=${configPath}`);
  if (!configPath || !modern) options.push(`platform=${platform}`);
  if (!configPath) options.push(`debug=${Boolean(debug)}`, `md5Cache=${Boolean(md5Cache)}`);
  if (modern && outputName) options.push(`outputName=${outputName}`);
  if (modern && logPath) options.push(`logDest=${logPath}`);
  return options.join(";");
}

/**
 * The process invocation. `configPath` is a build configuration exported
 * from the Build panel; without it the platform and a few common options are
 * passed explicitly.
 */
export function cocosBuildCommand(options) {
  const modern = cocosFamily(options.version) !== 2;
  const args = [modern ? "--project" : "--path", String(options.projectPath || ""), "--build", cocosBuildArgument(options)];
  const program = String(options.editorPath || "");
  return { program, args, display: [program, ...args].map(quoteArgument).join(" ") };
}

/** "success", "invalidOptions", "buildError" or "unknown". */
export function describeCocosExit(version, code) {
  if (cocosFamily(version) !== 2) {
    if (code === COCOS_EXIT.SUCCESS) return "success";
    if (code === COCOS_EXIT.INVALID_OPTIONS) return "invalidOptions";
    if (code === COCOS_EXIT.BUILD_ERROR) return "buildError";
    return "unknown";
  }
  return code === 0 ? "success" : "unknown";
}

/**
 * What stops or warns about a build before it starts, worst first. Each
 * problem is { code, level: "error" | "warning" }. `project` is what the
 * backend read from the project folder, `editors` the editors it found.
 */
export function cocosBuildProblems(options, { project = null, editorVersion = "" } = {}) {
  const problems = [];
  const add = (code, level, extra = {}) => problems.push({ code, level, ...extra });
  if (!options.projectPath) add("noProject", "error");
  else if (project && !project.exists) add("projectMissing", "error");
  else if (project && !project.engine?.version) add("notCocosProject", "error");
  if (!options.editorPath) add("noEditor", "error");
  else if (project && project.editorExists === false) add("editorMissing", "error");
  if (!options.platform || !COCOS_PLATFORM_PATTERN.test(options.platform)) add("noPlatform", "error");
  const engine = project?.engine?.version || "";
  const editor = editorVersion || options.version;
  if (engine && editor) {
    if (cocosFamily(engine) !== cocosFamily(editor)) add("familyMismatch", "error", { engine, editor });
    else if (engine !== editor) add("versionMismatch", "warning", { engine, editor });
  }
  if (options.configPath && project && project.configExists === false) add("configMissing", "error");
  if (!options.configPath && isNativeCocosPlatform(editor || engine, options.platform)) add("nativeWithoutConfig", "warning");
  return problems;
}
