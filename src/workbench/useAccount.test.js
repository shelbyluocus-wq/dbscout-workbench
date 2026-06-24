import test from "node:test";
import assert from "node:assert/strict";

import { useAccount } from "./composables/useAccount.js";

/**
 * Minimal in-memory backend stubbing the account + sync commands. Mirrors the
 * central server's username/token model: register creates a user, login looks
 * it up, and sync_audit_now promotes local audit rows into a shared list.
 */
function createBackend() {
  const users = new Map(); // username -> { userId, username, displayName, token }
  let account = { serverUrl: "http://localhost:8765", session: null };
  const sharedAudit = [];
  const localAudit = [
    {
      id: 1,
      ts: "2026-06-24T09:00:00Z",
      connectionId: "demo",
      database: "game_db",
      tableName: "player",
      operation: "UPDATE",
      columnName: "level",
      oldValue: "12",
      newValue: "99",
      source: "grid",
      status: "committed",
      isRollback: false,
      clientId: "cid-1",
      synced: false,
    },
  ];
  let seq = 0;

  return {
    sharedAudit,
    invokeWorkbench(command, payload = {}) {
      if (command === "get_account") {
        return Promise.resolve({ serverUrl: account.serverUrl, session: account.session });
      }
      if (command === "set_account_server") {
        account.serverUrl = (payload.request?.serverUrl || "").trim() || null;
        return Promise.resolve({ serverUrl: account.serverUrl, session: account.session });
      }
      if (command === "register_account") {
        const username = (payload.request?.username || "").trim();
        if (!username) return Promise.reject(new Error("用户名不能为空"));
        if (users.has(username)) return Promise.reject(new Error("用户名已被注册"));
        const displayName = (payload.request?.displayName || "").trim() || username;
        const user = {
          userId: `u-${++seq}`,
          username,
          displayName,
          token: `t-${seq}`,
        };
        users.set(username, user);
        account.session = { ...user };
        return Promise.resolve({ serverUrl: account.serverUrl, session: account.session });
      }
      if (command === "login_account") {
        const username = (payload.request?.username || "").trim();
        const user = users.get(username);
        if (!user) return Promise.reject(new Error("用户不存在，请先注册"));
        account.session = { ...user };
        return Promise.resolve({ serverUrl: account.serverUrl, session: account.session });
      }
      if (command === "logout_account") {
        account.session = null;
        return Promise.resolve({ serverUrl: account.serverUrl, session: null });
      }
      if (command === "list_shared_audit_logs") {
        return Promise.resolve(sharedAudit.slice());
      }
      if (command === "sync_audit_now") {
        if (!account.session) return Promise.resolve({ accepted: 0, skipped: 0 });
        const user = account.session;
        let accepted = 0;
        let skipped = 0;
        for (const row of localAudit) {
          if (row.synced || sharedAudit.some((s) => s.clientId === row.clientId)) {
            skipped += 1;
            continue;
          }
          sharedAudit.unshift({
            clientId: row.clientId,
            ts: row.ts,
            userId: user.userId,
            username: user.username,
            displayName: user.displayName,
            connectionId: row.connectionId,
            database: row.database,
            tableName: row.tableName,
            operation: row.operation,
            columnName: row.columnName,
            oldValue: row.oldValue,
            newValue: row.newValue,
            source: row.source,
            status: row.status,
            isRollback: row.isRollback,
          });
          row.synced = true;
          accepted += 1;
        }
        return Promise.resolve({ accepted, skipped });
      }
      return Promise.resolve(null);
    },
  };
}

test("loadAccount populates serverUrl and empty session initially", async () => {
  const backend = createBackend();
  const account = useAccount({ ...backend });
  await account.loadAccount();
  assert.equal(account.serverUrl.value, "http://localhost:8765");
  assert.equal(account.isLoggedIn.value, false);
  assert.equal(account.currentUser.value, null);
});

test("register creates a session and fires onSessionChanged", async () => {
  let changed = 0;
  const backend = createBackend();
  const account = useAccount({ ...backend, onSessionChanged: () => { changed += 1; } });
  await account.register("alice", "Alice");
  assert.equal(account.isLoggedIn.value, true);
  assert.equal(account.username.value, "alice");
  assert.equal(account.displayName.value, "Alice");
  assert.equal(changed, 1);
});

test("register with a duplicate username fails and sets lastError", async () => {
  const backend = createBackend();
  const account = useAccount({ ...backend });
  await account.register("bob", "Bob");
  const ok = await account.register("bob", "Bob2");
  assert.equal(ok, false);
  assert.match(account.lastError.value, /已被注册/);
});

test("login fails for an unknown user then succeeds after register", async () => {
  const backend = createBackend();
  const account = useAccount({ ...backend });
  const ok = await account.login("carol");
  assert.equal(ok, false);
  assert.match(account.lastError.value, /不存在/);
  await account.register("carol");
  account.lastError.value = "";
  const ok2 = await account.login("carol");
  assert.equal(ok2, true);
  assert.equal(account.username.value, "carol");
});

test("logout clears the session", async () => {
  const backend = createBackend();
  const account = useAccount({ ...backend });
  await account.register("dave");
  assert.equal(account.isLoggedIn.value, true);
  await account.logout();
  assert.equal(account.isLoggedIn.value, false);
  assert.equal(account.currentUser.value, null);
});

test("setServer updates the server url", async () => {
  const backend = createBackend();
  const account = useAccount({ ...backend });
  await account.loadAccount();
  await account.setServer("http://10.0.0.5:8765");
  assert.equal(account.serverUrl.value, "http://10.0.0.5:8765");
});

test("syncNow promotes local rows into the shared list attributed to the user", async () => {
  const backend = createBackend();
  const account = useAccount({ ...backend });
  await account.register("eve", "Eve");
  const result = await account.syncNow();
  assert.equal(result.accepted, 1);
  assert.equal(backend.sharedAudit.length, 1);
  assert.equal(backend.sharedAudit[0].username, "eve");
  assert.equal(backend.sharedAudit[0].displayName, "Eve");
  assert.equal(backend.sharedAudit[0].clientId, "cid-1");
  // A second sync skips the already-synced row.
  const result2 = await account.syncNow();
  assert.equal(result2.accepted, 0);
  assert.equal(result2.skipped, 1);
});
