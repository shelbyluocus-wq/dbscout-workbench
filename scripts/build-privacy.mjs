import os from "node:os";
import path from "node:path";

// Pass path-remapping flags as individual Cargo arguments, including when a
// workspace path contains spaces. No developer-specific paths are checked in.
export function privateBuildEnvironment({ env = process.env, root, home = os.homedir() } = {}) {
  if (!root) throw new Error("workspace root is required");
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean)
    : (env.RUSTFLAGS || "").split(/\s+/).filter(Boolean);
  const mappings = [
    [home, "/build/home"],
    [env.CARGO_HOME || path.join(home, ".cargo"), "/build/cargo"],
    [env.RUSTUP_HOME || path.join(home, ".rustup"), "/build/rustup"],
    [root, "/build/workspace"],
  ];
  for (const [source, target] of mappings) {
    const flag = `--remap-path-prefix=${source}=${target}`;
    if (!flags.includes(flag)) flags.push(flag);
  }
  return { ...env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
}
