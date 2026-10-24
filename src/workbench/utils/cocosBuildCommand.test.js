import assert from "node:assert/strict";
import { test } from "node:test";
import { cocosBuildCommand, cocosMajorVersion, defaultCocosEditorPath, describeCocosExit } from "./cocosBuildCommand.js";

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
