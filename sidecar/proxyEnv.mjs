import { createConnection } from "node:net";

const PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
const DEFAULT_FALLBACK_PROXY = "http://127.0.0.1:7892";

/**
 * Normalizes proxy variables before the Claude Agent SDK is started.
 *
 * Some desktop launch paths inherit stale localhost proxy settings. If the
 * configured loopback proxy is unreachable, but the configured fallback is
 * reachable, rewrite all HTTP(S) proxy variables consistently for the SDK and
 * native CLI child process.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   fallbackProxy?: string,
 *   isReachable?: (host: string, port: number) => Promise<boolean>,
 * }} options
 * @returns {Promise<Record<string, string | undefined>>}
 */
export async function normalizeAgentProxyEnv(env, options = {}) {
  const nextEnv = { ...env };
  const currentProxy = firstProxyUrl(nextEnv);
  if (!currentProxy || !isLoopbackHost(currentProxy.hostname)) {
    return nextEnv;
  }

  const isReachable = options.isReachable ?? isTcpReachable;
  if (await isReachable(currentProxy.hostname, currentProxy.port)) {
    return nextEnv;
  }

  const fallbackCandidates = [
    nextEnv.DBSCOUT_AGENT_FALLBACK_PROXY,
    options.fallbackProxy,
    DEFAULT_FALLBACK_PROXY,
  ];

  for (const candidate of fallbackCandidates) {
    const fallbackProxy = parseProxyUrl(candidate);
    if (!fallbackProxy) continue;
    if (!(await isReachable(fallbackProxy.hostname, fallbackProxy.port))) {
      continue;
    }

    setAllProxyVars(nextEnv, fallbackProxy.raw);
    return nextEnv;
  }

  return nextEnv;
}

function firstProxyUrl(env) {
  for (const key of PROXY_KEYS) {
    const proxy = parseProxyUrl(env[key]);
    if (proxy) return proxy;
  }
  return null;
}

function parseProxyUrl(value) {
  if (!value || typeof value !== "string") return null;
  const raw = value.trim();
  try {
    const url = new URL(raw);
    if (!url.hostname) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return {
      raw,
      protocol: url.protocol,
      hostname: url.hostname,
      port: proxyPort(url),
    };
  } catch {
    return null;
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function proxyPort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function setAllProxyVars(env, proxy) {
  for (const key of PROXY_KEYS) {
    env[key] = proxy;
  }
}

function isTcpReachable(host, port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 700 });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };

    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
