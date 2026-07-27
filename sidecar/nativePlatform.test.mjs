import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nativeCliBinaryName,
  nativeSdkPackageName,
} from "./nativePlatform.mjs";

describe("nativeSdkPackageName", () => {
  it("maps supported desktop targets to the optional SDK package", () => {
    assert.equal(
      nativeSdkPackageName({ platform: "win32", arch: "x64" }),
      "claude-agent-sdk-win32-x64"
    );
    assert.equal(
      nativeSdkPackageName({ platform: "darwin", arch: "arm64" }),
      "claude-agent-sdk-darwin-arm64"
    );
    assert.equal(
      nativeSdkPackageName({ platform: "linux", arch: "x64", musl: true }),
      "claude-agent-sdk-linux-x64-musl"
    );
    assert.equal(
      nativeSdkPackageName({ platform: "linux", arch: "arm64", musl: false }),
      "claude-agent-sdk-linux-arm64"
    );
  });

  it("rejects unsupported platforms", () => {
    assert.equal(
      nativeSdkPackageName({ platform: "freebsd", arch: "x64" }),
      null
    );
  });
});

describe("nativeCliBinaryName", () => {
  it("uses the Windows executable suffix only on Windows", () => {
    assert.equal(nativeCliBinaryName("win32"), "claude.exe");
    assert.equal(nativeCliBinaryName("linux"), "claude");
  });
});
