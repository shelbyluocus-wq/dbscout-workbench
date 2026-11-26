import { computed, getCurrentScope, onScopeDispose, reactive, shallowRef } from "vue";

import {
  invokeWorkbench as defaultInvokeWorkbench,
  listenWorkbenchEvent as defaultListenWorkbenchEvent,
} from "../utils/tauriBridge.js";

export const ACCOUNT_SESSION_CHANGED_EVENT = "account-session-changed";

function errorMessage(error) {
  return String(error?.message || error || "未知错误");
}

function sameSession(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.userId === b.userId
    && a.username === b.username
    && a.displayName === b.displayName
    && a.token === b.token
  );
}

/**
 * Account/session composable for the shared change-log feature.
 *
 * Wraps the 6 account Tauri commands (get_account / set_account_server /
 * register_account / login_account / logout_account / sync_audit_now) and
 * exposes reactive account state. Mirrors the `useBackupCenter` options-object
 * pattern: `invokeWorkbench` and `listen` are injectable for tests.
 *
 * @param {object} options
 * @param {(command: string, payload?: object) => Promise<any>} [options.invokeWorkbench]
 *   Injected command invoker (defaults to the real Tauri bridge / mock fallback).
 * @param {(eventName: string, handler: (event: any) => void) => Promise<() => void> | (() => void)} [options.listen]
 *   Injected event listener for backend-pushed session updates.
 * @param {() => void} [options.onSessionChanged] Called after a successful
 *   login/logout/register or backend session refresh/invalidation so the host
 *   (e.g. useBackupCenter) can refresh shared views.
 */
export function useAccount(options = {}) {
  const invokeWorkbench = options.invokeWorkbench || defaultInvokeWorkbench;
  const listen = options.listen || defaultListenWorkbenchEvent;
  const onSessionChanged = options.onSessionChanged || (() => {});
  const onSynced = options.onSynced || (() => {});

  // The backend AccountView: { serverUrl, session: { userId, username,
  // displayName, token } | null }. Held in a shallowRef and replaced wholesale.
  const account = shallowRef({ serverUrl: null, session: null });
  // Remembers the last signed-in username across unexpected session expiration
  // so login/register forms can prefill it; cleared on explicit logout.
  const lastKnownUsername = shallowRef("");

  const busy = reactive({
    loading: false,
    savingServer: false,
    registering: false,
    loggingIn: false,
    loggingOut: false,
    syncing: false,
  });

  const lastError = shallowRef("");

  const isLoggedIn = computed(() => Boolean(account.value?.session));
  const currentUser = computed(() => account.value?.session || null);
  const displayName = computed(() => account.value?.session?.displayName || "");
  const username = computed(() => account.value?.session?.username || "");
  const serverUrl = computed(() => account.value?.serverUrl || "");

  function applyAccountSnapshot(next, { notifyOnSessionChange = false, clearLastUsername = false } = {}) {
    const prevSession = account.value?.session || null;
    const nextSession = next?.session || null;
    account.value = {
      serverUrl: next?.serverUrl ?? null,
      session: nextSession,
    };
    if (nextSession?.username) {
      lastKnownUsername.value = String(nextSession.username);
    } else if (clearLastUsername) {
      lastKnownUsername.value = "";
    }
    if (notifyOnSessionChange && !sameSession(prevSession, nextSession)) {
      onSessionChanged();
    }
  }

  let disposed = false;
  let stopSessionListener = null;

  function startSessionListener() {
    if (disposed || stopSessionListener || typeof listen !== "function") return;
    Promise.resolve(
      listen(ACCOUNT_SESSION_CHANGED_EVENT, (event) => {
        if (disposed) return;
        const payload = event?.payload;
        if (!payload || typeof payload !== "object") return;
        applyAccountSnapshot(payload, { notifyOnSessionChange: true });
      }),
    )
      .then((unlisten) => {
        if (disposed) {
          if (typeof unlisten === "function") unlisten();
          return;
        }
        stopSessionListener = typeof unlisten === "function" ? unlisten : null;
      })
      .catch(() => {});
  }

  function dispose() {
    disposed = true;
    if (stopSessionListener) {
      stopSessionListener();
      stopSessionListener = null;
    }
  }

  startSessionListener();
  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  async function loadAccount() {
    busy.loading = true;
    try {
      const result = await invokeWorkbench("get_account", {});
      applyAccountSnapshot(result, { notifyOnSessionChange: false });
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.loading = false;
    }
  }

  async function probeStartupLogin() {
    try {
      const result = await invokeWorkbench("probe_account_server", {});
      if (result && typeof result === "object") {
        applyAccountSnapshot(
          {
            serverUrl: result.serverUrl ?? null,
            session: result.session ?? null,
          },
          { notifyOnSessionChange: true },
        );
      }
      const reachable = Boolean(result?.reachable);
      const signedIn = Boolean(result?.session);
      return {
        reachable,
        isLoggedIn: signedIn,
        shouldPrompt: reachable && !signedIn,
      };
    } catch {
      return {
        reachable: false,
        isLoggedIn: Boolean(account.value?.session),
        shouldPrompt: false,
      };
    }
  }

  function clearError() {
    lastError.value = "";
  }

  async function setServer(url) {
    busy.savingServer = true;
    try {
      const result = await invokeWorkbench("set_account_server", {
        request: { serverUrl: String(url || "").trim() },
      });
      applyAccountSnapshot(result, { notifyOnSessionChange: true });
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.savingServer = false;
    }
  }

  async function register(usernameInput, displayNameInput) {
    busy.registering = true;
    try {
      const result = await invokeWorkbench("register_account", {
        request: {
          username: String(usernameInput || "").trim(),
          displayName: displayNameInput ? String(displayNameInput).trim() : undefined,
        },
      });
      applyAccountSnapshot(result, { notifyOnSessionChange: false });
      lastError.value = "";
      onSessionChanged();
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.registering = false;
    }
  }

  async function login(usernameInput) {
    busy.loggingIn = true;
    try {
      const result = await invokeWorkbench("login_account", {
        request: { username: String(usernameInput || "").trim() },
      });
      applyAccountSnapshot(result, { notifyOnSessionChange: false });
      lastError.value = "";
      onSessionChanged();
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.loggingIn = false;
    }
  }

  async function logout() {
    busy.loggingOut = true;
    try {
      const result = await invokeWorkbench("logout_account", {});
      applyAccountSnapshot(result, { notifyOnSessionChange: false, clearLastUsername: true });
      lastError.value = "";
      onSessionChanged();
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.loggingOut = false;
    }
  }

  /** Manually trigger an outbox push to the central server. */
  async function syncNow() {
    busy.syncing = true;
    try {
      const result = await invokeWorkbench("sync_audit_now", {});
      lastError.value = "";
      onSynced();
      return { accepted: Number(result?.accepted || 0), skipped: Number(result?.skipped || 0) };
    } catch (error) {
      lastError.value = errorMessage(error);
      return { accepted: 0, skipped: 0 };
    } finally {
      busy.syncing = false;
    }
  }

  return {
    account,
    busy,
    lastError,
    lastKnownUsername,
    isLoggedIn,
    currentUser,
    displayName,
    username,
    serverUrl,
    loadAccount,
    probeStartupLogin,
    clearError,
    setServer,
    register,
    login,
    logout,
    syncNow,
    dispose,
  };
}
