import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...rest] = process.argv.slice(2);

if (command === "dev") {
  const child = spawn(process.execPath, [path.join(rootDir, "scripts", "tauri-dev.mjs"), ...rest], {
    stdio: "inherit",
    cwd: rootDir,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
} else {
  const tauriBin = path.join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const child = spawn(process.execPath, [tauriBin, command, ...rest], {
    stdio: "inherit",
    cwd: rootDir,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}