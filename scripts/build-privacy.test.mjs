import test from "node:test";
import assert from "node:assert/strict";
import { privateBuildEnvironment } from "./build-privacy.mjs";

test("remaps home, toolchain and workspace paths without splitting paths containing spaces", () => {
  const result = privateBuildEnvironment({ root: "/Users/example/My Project", home: "/Users/example", env: { RUSTFLAGS: "-C debuginfo=0", KEEP_ME: "yes" } });
  const flags = result.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
  assert.deepEqual(flags.slice(0, 2), ["-C", "debuginfo=0"]);
  assert.ok(flags.includes("--remap-path-prefix=/Users/example/My Project=/build/workspace"));
  assert.equal(result.KEEP_ME, "yes");
  assert.deepEqual(privateBuildEnvironment({ root: "/Users/example/My Project", home: "/Users/example", env: result }), result);
});

test("encoded Rust flags retain their precedence over plain flags", () => {
  const result = privateBuildEnvironment({ root: "/work", home: "/home/user", env: { CARGO_ENCODED_RUSTFLAGS: "--cfg\x1fmy_flag", RUSTFLAGS: "ignored", CARGO_HOME: "/cache/cargo" } });
  assert.equal(result.CARGO_ENCODED_RUSTFLAGS.startsWith("--cfg\x1fmy_flag\x1f"), true);
  assert.ok(result.CARGO_ENCODED_RUSTFLAGS.includes("--remap-path-prefix=/cache/cargo=/build/cargo"));
  assert.throws(() => privateBuildEnvironment({ env: {} }), /workspace root/);
});
