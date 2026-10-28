import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cocosBuildCommand,
  cocosBuildOptions,
  cocosBuildProblems,
  cocosFamily,
  cocosMajorVersion,
  cocosOutputDir,
  cocosPlatformChoices,
  cocosPlatformsFor,
  cocosPlatformValue,
  cocosVersionChoices,
  defaultCocosEditorPath,
  describeCocosExit,
  isNativeCocosPlatform,
  resolveProjectPath,
} from "./cocosBuildCommand.js";

test("Cocos Creator 3.x builds with --project and an exported build configuration", () => {
  const command = cocosBuildCommand({
    editorPath: "C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\CocosCreator.exe",
    projectPath: "D:\\release\\tw\\client",
    version: "3.8.8",
    configPath: "D:\\release\\tw\\client\\build-config\\web-mobile.json",
    logPath: "D:\\logs\\build.log",
  });
  assert.deepEqual(command.args, [
    "--project",
    "D:\\release\\tw\\client",
    "--build",
    "configPath=D:\\release\\tw\\client\\build-config\\web-mobile.json;logDest=D:\\logs\\build.log",
  ]);
  assert.match(command.display, /^C:\\ProgramData\\cocos\\editors\\Creator\\3\.8\.8\\CocosCreator\.exe --project /);
  assert.match(command.display, /--build "configPath=.*;logDest=.*"$/);
});

test("Cocos Creator 2.4 builds with --path and names the platform", () => {
  const command = cocosBuildCommand({
    editorPath: "/Applications/Cocos/Creator/2.4.13/CocosCreator.app/Contents/MacOS/CocosCreator",
    projectPath: "/Users/dev/nzg",
    version: "2.4.13",
    platform: "web-mobile",
  });
  assert.deepEqual(command.args, ["--path", "/Users/dev/nzg", "--build", "platform=web-mobile;debug=false;md5Cache=true"]);
});

test("paths with spaces are quoted in the displayed command", () => {
  const command = cocosBuildCommand({ editorPath: "C:\\Program Files\\Cocos\\CocosCreator.exe", projectPath: "D:\\my game", version: "3.8.8" });
  assert.equal(command.display, '"C:\\Program Files\\Cocos\\CocosCreator.exe" --project "D:\\my game" --build "platform=web-mobile;debug=false;md5Cache=true"');
});

test("exit codes follow the documented meanings", () => {
  assert.equal(describeCocosExit("3.8.8", 36), "success");
  assert.equal(describeCocosExit("3.8.8", 32), "invalidOptions");
  assert.equal(describeCocosExit("3.8.8", 34), "buildError");
  assert.equal(describeCocosExit("3.8.8", 0), "unknown");
  assert.equal(describeCocosExit("2.4.13", 0), "success");
  assert.equal(describeCocosExit("2.4.13", 36), "unknown");
  assert.equal(cocosMajorVersion("v3"), 0);
  assert.equal(cocosMajorVersion(" 3.8.8"), 3);
  assert.equal(defaultCocosEditorPath("3.8.8"), "C:\\ProgramData\\cocos\\editors\\Creator\\3.8.8\\CocosCreator.exe");
});

test("a platform's settings become build options; a relative configuration follows the project", () => {
  const options = cocosBuildOptions({
    targetClient: "D:\\jswz\\release\\tw\\jswz",
    cocosPath: "D:\\jswz\\chengxu\\client\\creator3.8\\CocosCreator.exe",
    cocosVersion: "3.8.8",
    buildPlatform: "android",
    buildConfig: "build-config/android.json",
    buildOutputName: "android-tw",
    buildDebug: false,
    buildMd5Cache: true,
    buildQaGuard: true,
  });
  assert.equal(options.configPath, "D:\\jswz\\release\\tw\\jswz\\build-config/android.json");
  assert.equal(resolveProjectPath("/Users/dev/nzg", "/abs/config.json"), "/abs/config.json");
  assert.equal(resolveProjectPath("/Users/dev/nzg", ""), "");
  assert.deepEqual(cocosBuildCommand(options).args.slice(2), ["--build", `configPath=${options.configPath};outputName=android-tw`]);
});

test("installed editors become a version list, oldest first", () => {
  assert.deepEqual(
    cocosVersionChoices([
      { version: "3.8.8", path: "D:\\client2\\creator3.8\\CocosCreator.exe" },
      { version: "2.4.15", path: "D:\\creator_2.4.3\\CocosCreator.exe" },
      { version: "3.8.8", path: "D:\\other\\CocosCreator.exe" },
      { version: "  ", path: "D:\\blank\\CocosCreator.exe" },
    ]),
    ["2.4.15", "3.8.8"],
  );
  assert.deepEqual(cocosVersionChoices(null), []);
});

test("3.x and 2.4 have their own platforms, native targets and output folders", () => {
  assert.equal(cocosFamily("3.8.8"), 3);
  assert.equal(cocosFamily("2.4.13"), 2);
  assert.equal(cocosFamily("x"), 0);
  assert.ok(cocosPlatformsFor("3.8.8").includes("windows"));
  assert.ok(cocosPlatformsFor("2.4.13").includes("win32"));
  const creator2 = cocosPlatformChoices("2.4.15");
  assert.deepEqual(
    creator2.slice(7, 14).map((item) => item.label),
    ["HarmonyOS Next", "淘宝小游戏", "Web Mobile", "Web Desktop", "Facebook Instant Games", "Android", "HUAWEI AppGallery Connect"],
  );
  assert.equal(creator2.at(-1).label, "Windows");
  assert.equal(creator2.find((item) => item.label === "微信小游戏").value, "wechatgame");
  assert.equal(creator2.find((item) => item.label === "OPPO 小游戏").value, "quickgame");
  assert.equal(creator2.find((item) => item.label === "vivo 小游戏").value, "qgame");
  assert.equal(creator2.find((item) => item.label === "华为快游戏").value, "huawei");
  assert.equal(cocosPlatformValue("2.4.15", "Windows"), "win32");
  assert.equal(cocosPlatformValue("2.4.15", "win32"), "win32");
  assert.equal(cocosPlatformChoices("3.8.8").find((item) => item.value === "windows").label, "Windows");
  assert.equal(isNativeCocosPlatform("3.8.8", "android"), true);
  assert.equal(isNativeCocosPlatform("2.4.13", "web-mobile"), false);
  assert.equal(cocosOutputDir({ projectPath: "D:\\tw\\jswz", version: "3.8.8", platform: "android" }), "D:\\tw\\jswz\\build\\android");
  assert.equal(cocosOutputDir({ projectPath: "D:\\tw\\jswz", version: "3.8.8", platform: "android", outputName: "tw" }), "D:\\tw\\jswz\\build\\tw");
  assert.equal(cocosOutputDir({ projectPath: "/dev/nzg", version: "2.4.13", platform: "android" }), "/dev/nzg/build/jsb-link");
  assert.equal(cocosOutputDir({ projectPath: "/dev/nzg", version: "2.4.13", platform: "web-mobile" }), "/dev/nzg/build/web-mobile");
});

test("checks before a build: missing pieces stop it, version differences warn", () => {
  const options = { projectPath: "D:\\jswz", editorPath: "C:\\Cocos\\CocosCreator.exe", version: "3.8.6", platform: "android", configPath: "" };
  const codes = (problems) => problems.map((problem) => `${problem.level}:${problem.code}`);
  assert.deepEqual(codes(cocosBuildProblems({ ...options, projectPath: "", editorPath: "", platform: "" })), ["error:noProject", "error:noEditor", "error:noPlatform"]);
  assert.deepEqual(codes(cocosBuildProblems(options, { project: { exists: false } })), ["error:projectMissing", "warning:nativeWithoutConfig"]);
  const project = { exists: true, engine: { version: "3.8.8" }, editorExists: true };
  assert.deepEqual(codes(cocosBuildProblems(options, { project, editorVersion: "3.8.6" })), ["warning:versionMismatch", "warning:nativeWithoutConfig"]);
  assert.deepEqual(codes(cocosBuildProblems(options, { project, editorVersion: "2.4.13" })), ["error:familyMismatch", "warning:nativeWithoutConfig"]);
  assert.deepEqual(codes(cocosBuildProblems({ ...options, platform: "web-mobile" }, { project, editorVersion: "3.8.8" })), []);
  assert.deepEqual(codes(cocosBuildProblems({ ...options, configPath: "D:\\x.json" }, { project: { ...project, configExists: false }, editorVersion: "3.8.8" })), ["error:configMissing"]);
  assert.deepEqual(codes(cocosBuildProblems({ ...options, platform: "android;rm" }, { project, editorVersion: "3.8.8" })), ["error:noPlatform"]);
});
