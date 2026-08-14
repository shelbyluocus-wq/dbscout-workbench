import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { ensureSvn } from "./ensure-svn.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...rest] = process.argv.slice(2);

function run(bin, args) {
  const child = spawn(process.execPath, [bin, ...args], {
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

if (command === "dev") {
  run(path.join(rootDir, "scripts", "tauri-dev.mjs"), rest);
} else {
  if (command === "build") await ensureSvn();
  run(path.join(rootDir, "node_modules", "@tauri-apps", "cli", "tauri.js"), [command, ...rest]);
}