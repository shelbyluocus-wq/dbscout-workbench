import { spawn } from "node:child_process";
import net from "node:net";

function defaultRunCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      resolve({ status: status ?? (signal ? 1 : 0), signal, stdout, stderr });
    });
  });
}

export function waitForChildExit(child, { timeoutMs = 10_000 } = {}) {
  if (!child || typeof child !== "object") throw new TypeError("child is required");
  if (child.exitCode !== null && child.exitCode !== undefined) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.("exit", onExit);
      child.off?.("error", onError);
    };
    const onExit = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for child PID ${child.pid} to exit`));
    }, timeoutMs);
    timer.unref?.();
    child.once?.("exit", onExit);
    child.once?.("error", onError);
  });
}

export function isPortAvailable(port, { host = "127.0.0.1" } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new RangeError(`Invalid TCP port: ${port}`));
  }
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

async function waitForPortRelease(port, checkPort, { attempts = 50, intervalMs = 100, signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) return;
    if (await checkPort(port)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (signal?.aborted) return;
  throw new Error(`Port ${port} is still bound after owned process cleanup`);
}

async function terminateUnixProcessGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return { status: 0, stdout: "", stderr: "" };
}

export async function terminateOwnedProcessTree({
  child,
  port,
  platform = process.platform,
  runCommand = defaultRunCommand,
  waitForExit = waitForChildExit,
  isPortAvailable: checkPort = isPortAvailable,
} = {}) {
  const pid = Number(child?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Owned child PID is required for cleanup");

  const alreadyExited = child.exitCode !== null && child.exitCode !== undefined;
  if (!alreadyExited) {
    const result = platform === "win32"
      ? await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"])
      : await terminateUnixProcessGroup(pid);
    if (result?.status !== 0) {
      const detail = String(result?.stderr || result?.stdout || "unknown failure").trim();
      throw new Error(`${platform === "win32" ? "taskkill" : "process-group cleanup"} failed: ${detail}`);
    }
    const releaseWait = new AbortController();
    try {
      await Promise.race([
        waitForExit(child),
        waitForPortRelease(port, checkPort, { signal: releaseWait.signal }),
      ]);
    } finally {
      releaseWait.abort();
    }
  }

  await waitForPortRelease(port, checkPort, { attempts: 10, intervalMs: 50 });
}
