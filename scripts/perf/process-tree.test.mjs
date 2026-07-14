import test from "node:test";
import assert from "node:assert/strict";

const processModule = await import("./process-tree.mjs").catch(() => ({}));

function requireApi(name) {
  assert.equal(typeof processModule[name], "function", `process-tree.mjs must export ${name}`);
  return processModule[name];
}

test("Windows cleanup terminates only the owned PID tree, waits for exit, and verifies the port", async () => {
  const terminateOwnedProcessTree = requireApi("terminateOwnedProcessTree");
  const calls = [];

  await terminateOwnedProcessTree({
    child: { pid: 4321, exitCode: null },
    port: 14319,
    platform: "win32",
    runCommand: async (command, args) => {
      calls.push(["command", command, args]);
      return { status: 0, stdout: "SUCCESS", stderr: "" };
    },
    waitForExit: async (child) => calls.push(["exit", child.pid]),
    isPortAvailable: async (port) => {
      calls.push(["port", port]);
      return true;
    },
  });

  assert.deepEqual(calls, [
    ["command", "taskkill", ["/PID", "4321", "/T", "/F"]],
    ["exit", 4321],
    ["port", 14319],
    ["port", 14319],
  ]);
});

test("cleanup rejects missing PIDs, taskkill failures, child-exit timeouts, and bound ports", async () => {
  const terminateOwnedProcessTree = requireApi("terminateOwnedProcessTree");
  await assert.rejects(
    () => terminateOwnedProcessTree({ child: {}, port: 1, platform: "win32" }),
    /pid/i,
  );
  await assert.rejects(
    () => terminateOwnedProcessTree({
      child: { pid: 7 },
      port: 1,
      platform: "win32",
      runCommand: async () => ({ status: 1, stderr: "denied" }),
      waitForExit: async () => {},
      isPortAvailable: async () => true,
    }),
    /taskkill.*denied/i,
  );
  await assert.rejects(
    () => terminateOwnedProcessTree({
      child: { pid: 7 },
      port: 1,
      platform: "win32",
      runCommand: async () => ({ status: 0 }),
      waitForExit: async () => { throw new Error("exit timeout"); },
      isPortAvailable: async () => true,
    }),
    /exit timeout/i,
  );
  await assert.rejects(
    () => terminateOwnedProcessTree({
      child: { pid: 7 },
      port: 1,
      platform: "win32",
      runCommand: async () => ({ status: 0 }),
      waitForExit: async () => {},
      isPortAvailable: async () => false,
    }),
    /port.*still bound/i,
  );
});

test("already exited children skip termination but still require port release", async () => {
  const terminateOwnedProcessTree = requireApi("terminateOwnedProcessTree");
  let commands = 0;
  await terminateOwnedProcessTree({
    child: { pid: 12, exitCode: 0 },
    port: 1431,
    runCommand: async () => { commands += 1; return { status: 0 }; },
    waitForExit: async () => {},
    isPortAvailable: async () => true,
  });
  assert.equal(commands, 0);
});

test("Windows cleanup accepts released ports when the child exit event is delayed", async () => {
  const terminateOwnedProcessTree = requireApi("terminateOwnedProcessTree");
  let releaseExit;
  const delayedExit = new Promise((resolve) => { releaseExit = resolve; });

  await terminateOwnedProcessTree({
    child: { pid: 4321, exitCode: null },
    port: 14319,
    platform: "win32",
    runCommand: async () => ({ status: 0, stdout: "SUCCESS", stderr: "" }),
    waitForExit: async () => delayedExit,
    isPortAvailable: async () => true,
  });

  releaseExit();
});
