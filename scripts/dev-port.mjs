import net from "node:net";

export const DEFAULT_DEV_PORT = 1431;
export const DEFAULT_DEV_HOST = "127.0.0.1";
export const MAX_PORT_ATTEMPTS = 20;

export function buildDevServerUrl(host = DEFAULT_DEV_HOST, port = DEFAULT_DEV_PORT) {
  return `http://${host}:${port}`;
}

export function isPortAvailable(port, host = DEFAULT_DEV_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort({
  start = DEFAULT_DEV_PORT,
  host = DEFAULT_DEV_HOST,
  maxAttempts = MAX_PORT_ATTEMPTS,
  check = isPortAvailable,
} = {}) {
  const requested = Number(start);
  if (!Number.isInteger(requested) || requested <= 0 || requested > 65535) {
    throw new Error(`Invalid dev port: ${start}`);
  }

  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = requested + offset;
    if (await check(port, host)) return port;
  }

  throw new Error(`No available dev port found near ${requested}`);
}