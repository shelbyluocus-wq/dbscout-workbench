import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentProxyEnv } from "./proxyEnv.mjs";

describe("agent proxy environment normalization", () => {
  it("rewrites stale localhost 7890 proxy entries to a reachable fallback", async () => {
    const checked = [];
    const env = await normalizeAgentProxyEnv(
      {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        HTTP_PROXY: "http://127.0.0.1:7890",
        NO_PROXY: "localhost,127.0.0.1",
      },
      {
        fallbackProxy: "http://127.0.0.1:7892",
        isReachable: async (host, port) => {
          checked.push(`${host}:${port}`);
          return port === 7892;
        },
      }
    );

    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7892");
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7892");
    assert.equal(env.https_proxy, "http://127.0.0.1:7892");
    assert.equal(env.http_proxy, "http://127.0.0.1:7892");
    assert.deepEqual(checked, ["127.0.0.1:7890", "127.0.0.1:7892"]);
  });

  it("keeps a reachable explicit proxy unchanged", async () => {
    const env = await normalizeAgentProxyEnv(
      {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        HTTP_PROXY: "http://127.0.0.1:7890",
      },
      {
        fallbackProxy: "http://127.0.0.1:7892",
        isReachable: async (_host, port) => port === 7890,
      }
    );

    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.https_proxy, undefined);
    assert.equal(env.http_proxy, undefined);
  });

  it("uses DBSCOUT_AGENT_FALLBACK_PROXY before the default fallback", async () => {
    const env = await normalizeAgentProxyEnv(
      {
        HTTPS_PROXY: "http://127.0.0.1:7890",
        DBSCOUT_AGENT_FALLBACK_PROXY: "http://127.0.0.1:19090",
      },
      {
        fallbackProxy: "http://127.0.0.1:7892",
        isReachable: async (_host, port) => port === 19090,
      }
    );

    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:19090");
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:19090");
  });
});
