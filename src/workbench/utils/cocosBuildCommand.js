// Command-line build for Cocos Creator, as documented in "Publish from the
// Command Line": 3.x takes `--project` and reports through its exit code
// (36 success, 32 invalid build options, 34 build error); 2.4 takes `--path`
// and documents no exit codes, so only 0 counts as success there. Build
// options travel in one `--build` argument separated by semicolons. The
// editor still needs a desktop session even when started this way. The
// backend (cocos_build.rs) builds the same arguments from the same options;
// this module shows them and checks the choices before a build starts.

export const COCOS_EXIT = Object.freeze({ SUCCESS: 36, INVALID_OPTIONS: 32, BUILD_ERROR: 34 });

// Publish targets as the editor's Build panel lists them: the label is the
// name on that page, the value is the platform id the command line expects.
// Any other id Cocos knows can still be typed in. Native targets need the
// platform SDKs set up in the editor's preferences.
const COCOS_PLATFORM_CHOICES = Object.freeze({
  3: Object.freeze([
    ["web-mobile", "Web Mobile"],
    ["web-desktop", "Web Desktop"],
    ["android", "Android"],
    ["ios", "iOS"],
    ["mac", "Mac"],
    ["windows", "Windows"],
    ["wechatgame", "微信小游戏"],
    ["alipay-mini-game", "支付宝小游戏"],
    ["taobao-mini-game", "淘宝小游戏"],
    ["bytedance-mini-game", "抖音小游戏"],
    ["xiaomi-quick-game", "小米快游戏"],
    ["huawei-quick-game", "华为快游戏"],
    ["oppo-mini-game", "OPPO 小游戏"],
    ["vivo-mini-game", "vivo 小游戏"],
    ["honor-mini-game", "荣耀小游戏"],
  ]),
  2: Object.freeze([
    ["ios", "iOS"],
    ["mac", "Mac"],
    ["baidugame", "百度小游戏"],
    ["baidugame-subcontext", "百度小游戏开放数据域"],
    ["xiaomi", "小米快游戏"],
    ["link-sure", "连尚小游戏"],
    ["qtt", "趣头条小游戏"],
    ["harmonyos-next", "HarmonyOS Next"],
    ["taobao-minigame", "淘宝小游戏"],
    ["web-mobile", "Web Mobile"],
    ["web-desktop", "Web Desktop"],
    ["fb-instant-games", "Facebook Instant Games"],
    ["android", "Android"],
    ["huawei-agc", "HUAWEI AppGallery Connect"],
    ["android-instant", "Android Instant"],
    ["alipay", "支付宝小游戏"],
    ["bytedance", "字节跳动小游戏"],
    ["bytedance-subcontext", "字节跳动小游戏开放数据域"],
    ["huawei", "华为快游戏"],
    ["quickgame", "OPPO 小游戏"],
    ["qgame", "vivo 小游戏"],
    ["honor-minigame", "荣耀小游戏"],
    ["wechatgame", "微信小游戏"],
    ["wechatgame-subcontext", "微信小游戏开放数据域"],
    ["win32", "Windows"],
  ]),
});
export const COCOS_PLATFORMS = Object.freeze({
  3: Object.freeze(COCOS_PLATFORM_CHOICES[3].map(([value]) => value)),
  2: Object.freeze(COCOS_PLATFORM_CHOICES[2].map(([value]) => value)),
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

/** { value, label } in the same order as that version's Build panel. */
export function cocosPlatformChoices(version) {
  return COCOS_PLATFORM_CHOICES[cocosFamily(version) || 3].map(([value, label]) => ({ value, label }));
}

/** A typed Build-panel name or a platform id, as the id the command line uses. */
export function cocosPlatformValue(version, text) {
  const raw = String(text ?? "").trim();
  const choice = cocosPlatformChoices(version).find((item) => item.value === raw || item.label.toLowerCase() === raw.toLowerCase());
  return choice ? choice.value : raw;
}

function versionRank(version) {
  return String(version).split(".").map((part) => Number.parseInt(part, 10) || 0);
}

/** Installed editor versions, oldest first, one entry when several copies match. */
export function cocosVersionChoices(editors) {
  const seen = new Set();
  const versions = [];
  for (const editor of editors || []) {
    const version = String(editor?.version || "").trim();
    if (!version || seen.has(version)) continue;
    seen.add(version);
    versions.push(version);
  }
  return versions.sort((left, right) => {
    const a = versionRank(left);
    const b = versionRank(right);
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (a[index] || 0) - (b[index] || 0);
      if (diff) return diff;
    }
    return 0;
  });
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
