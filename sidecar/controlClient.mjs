import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CONTROL_PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT_MS = 90_000;
const HOST_START_TIMEOUT_MS = 20_000;
const HOST_START_POLL_MS = 100;

export function controlEndpointCandidates(env = process.env, platform = process.platform) {
  const explicit = String(env.DBSCOUT_CONTROL_ENDPOINT || "").trim();
  if (explicit) return [path.resolve(explicit)];

  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "com.dbscout.workbench", "control-endpoint.json")];
  }
  if (platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "com.dbscout.workbench", "control-endpoint.json")];
  }
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return [path.join(dataHome, "com.dbscout.workbench", "control-endpoint.json")];
}

export async function readControlEndpoint(options = {}) {
  const candidates = options.candidates || controlEndpointCandidates(options.env, options.platform);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const endpoint = JSON.parse(await readFile(candidate, "utf8"));
      validateEndpoint(endpoint);
      if (!isProcessAlive(endpoint.pid)) throw new Error("黑猫控制端点来自已经退出的进程");
      return { ...endpoint, discoveryPath: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `找不到正在运行的黑猫控制端点。${
      lastError ? ` (${String(lastError.message || lastError)})` : ""
    }`
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function appExecutableFromArgs(args = process.argv.slice(2), env = process.env) {
  const explicitEnv = String(env.DBSCOUT_APP_EXECUTABLE || "").trim();
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index] || "");
    if (argument === "--app-executable") return String(args[index + 1] || "").trim();
    if (argument.startsWith("--app-executable=")) {
      return argument.slice("--app-executable=".length).trim();
    }
  }
  return explicitEnv;
}

export async function launchHiddenWorkbench(options = {}) {
  const executable = String(
    options.appExecutable || appExecutableFromArgs(options.args, options.env)
  ).trim();
  if (!executable) {
    throw new Error(
      "黑猫未运行，且 MCP 配置缺少 --app-executable。请从黑猫 AI 设置重新复制接入命令。"
    );
  }

  const child = spawn(executable, ["--mcp-headless"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export async function readOrStartControlEndpoint(options = {}) {
  try {
    return await readControlEndpoint(options);
  } catch (initialError) {
    const launch = options.launchWorkbench || launchHiddenWorkbench;
    await launch(options);
    const timeoutMs = options.hostStartTimeoutMs || HOST_START_TIMEOUT_MS;
    const pollMs = options.hostStartPollMs || HOST_START_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    let lastError = initialError;
    while (Date.now() < deadline) {
      await delay(pollMs);
      try {
        return await readControlEndpoint(options);
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `已尝试在后台启动黑猫，但控制服务未在 ${timeoutMs}ms 内就绪：${String(
        lastError?.message || lastError
      )}`
    );
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validateEndpoint(endpoint) {
  if (!Number.isInteger(endpoint?.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error("黑猫控制端点端口无效");
  }
  if (!endpoint?.token || typeof endpoint.token !== "string") {
    throw new Error("黑猫控制端点令牌无效");
  }
  if (Number(endpoint.protocolVersion) !== CONTROL_PROTOCOL_VERSION) {
    throw new Error(
      `黑猫控制协议版本不兼容：需要 ${CONTROL_PROTOCOL_VERSION}，实际 ${endpoint.protocolVersion ?? "未知"}`
    );
  }
}

export class ControlClient {
  constructor(options = {}) {
    this.options = options;
    this.socket = null;
    this.buffer = "";
    this.sequence = 0;
    this.pending = new Map();
    this.connecting = null;
    this.authenticated = false;
  }

  async request(op, payload = {}) {
    await this.connect();
    const id = `mcp-${process.pid}-${Date.now()}-${++this.sequence}`;
    const message = { op, id, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`黑猫控制请求超时：${op}`));
      }, this.options.requestTimeoutMs || REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async connect() {
    if (this.socket && this.authenticated && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async open() {
    this.close();
    const endpoint = await readOrStartControlEndpoint(this.options);
    const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
    this.socket = socket;
    this.buffer = "";
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.onClosed(socket, new Error("黑猫控制连接已关闭")));
    socket.on("error", (error) => this.onClosed(socket, error));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接黑猫控制端点超时")), 5_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("黑猫控制端点认证超时")), 5_000);
      this.helloWaiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      socket.write(`${JSON.stringify({ op: "hello", token: endpoint.token })}\n`);
    });
    if (!hello?.ok) throw new Error(hello?.error || "黑猫控制端点认证失败");
    if (Number(hello.protocolVersion) !== CONTROL_PROTOCOL_VERSION) {
      throw new Error("黑猫控制协议版本不兼容");
    }
    this.authenticated = true;
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (this.helloWaiter) {
        const waiter = this.helloWaiter;
        this.helloWaiter = null;
        waiter.resolve(message);
        continue;
      }
      const pending = this.pending.get(String(message.id || ""));
      if (!pending) continue;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(String(message.error || "黑猫控制请求失败")));
    }
  }

  onClosed(socket, error) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.authenticated = false;
    if (this.helloWaiter) {
      this.helloWaiter.reject(error);
      this.helloWaiter = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    const error = new Error("黑猫控制连接已关闭");
    if (this.helloWaiter) {
      this.helloWaiter.reject(error);
      this.helloWaiter = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (socket && !socket.destroyed) socket.destroy();
  }
}
