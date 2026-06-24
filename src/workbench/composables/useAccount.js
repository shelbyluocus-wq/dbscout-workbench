import { computed, reactive, shallowRef } from "vue";

import {
  invokeWorkbench as defaultInvokeWorkbench,
} from "../utils/tauriBridge.js";

function errorMessage(error) {
  return String(error?.message || error || "未知错误");
}

/**
 * Account/session composable for the shared change-log feature.
 *
 * Wraps the 6 account Tauri commands (get_account / set_account_server /
 * register_account / login_account / logout_account / sync_audit_now) and
 * exposes reactive account state. Mirrors the `useBackupCenter` options-object
 * pattern: `invokeWorkbench` is injectable for tests.
 *
 * @param {object} options
 * @param {(command: string, payload?: object) => Promise<any>} [options.invokeWorkbench]
 *   Injected command invoker (defaults to the real Tauri bridge / mock fallback).
 * @param {() => void} [options.onSessionChanged] Called after a successful
 *   login/logout/register so the host (e.g. useBackupCenter) can refresh the
 *   shared change-log view.
 */
export function useAccount(options = {}) {
  const invokeWorkbench = options.invokeWorkbench || defaultInvokeWorkbench;
  const onSessionChanged = options.onSessionChanged || (() => {});

  // The backend AccountView: { serverUrl, session: { userId, username,
  // displayName, token } | null }. Held in a shallowRef and replaced wholesale.
  const account = shallowRef({ serverUrl: null, session: null });

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

  async function loadAccount() {
    busy.loading = true;
    try {
      const result = await invokeWorkbench("get_account", {});
      // Default to http://localhost:8765 if no server URL is configured yet.
      if (!result.serverUrl) {
        result.serverUrl = "http://localhost:8765";
      }
      account.value = result;
      lastError.value = "";
      return true;
    } catch (error) {
      lastError.value = errorMessage(error);
      return false;
    } finally {
      busy.loading = false;
    }
  }

  async function setServer(url) {
    busy.savingServer = true;
    try {
      account.value = await invokeWorkbench("set_account_server", {
        request: { serverUrl: String(url || "").trim() },
      });
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
      account.value = await invokeWorkbench("register_account", {
        request: {
          username: String(usernameInput || "").trim(),
          displayName: displayNameInput ? String(displayNameInput).trim() : undefined,
        },
      });
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
      account.value = await invokeWorkbench("login_account", {
        request: { username: String(usernameInput || "").trim() },
      });
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
      account.value = await invokeWorkbench("logout_account", {});
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
    isLoggedIn,
    currentUser,
    displayName,
    username,
    serverUrl,
    loadAccount,
    setServer,
    register,
    login,
    logout,
    syncNow,
  };
}
