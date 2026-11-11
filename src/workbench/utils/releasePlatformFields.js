import { computed } from "vue";
import { isSyncCapableConnection, resolvePlatformConnection } from "../composables/useReleaseRealDriver.js";
import { invokeWorkbench, isTauriRuntime } from "./tauriBridge.js";

const PICK_COMMANDS = Object.freeze({
  folder: "svn_wc_pick_folder",
  project: "cocos_pick_project",
  editor: "cocos_pick_editor",
});

export function formatPlatformConnectionLabel(conn) {
  if (!conn) return "";
  const name = conn.name || conn.host || conn.id;
  const addr = conn.host ? `${conn.host}${conn.port ? `:${conn.port}` : ""}` : "";
  return addr && name !== addr ? `${name} (${addr})` : name;
}

export async function pickPlatformPathValue(currentValue, kind = "folder", invoke = invokeWorkbench) {
  const cmd = PICK_COMMANDS[kind] || PICK_COMMANDS.folder;
  const start = String(currentValue || "").trim();
  return invoke(cmd, { start }).catch(() => null);
}

export function usePlatformFieldMeta(workspaceRef, platformRef) {
  const desktop = isTauriRuntime();
  const allConnections = computed(() => workspaceRef.value?.connections?.value || []);
  const mysqlConnections = computed(() => allConnections.value.filter(isSyncCapableConnection));
  const autoMatched = computed(() => {
    const platform = platformRef.value;
    if (!platform) return null;
    return resolvePlatformConnection(
      { ...platform, connectionId: "" },
      allConnections.value,
      workspaceRef.value?.databasesByConnection?.value,
    );
  });
  const activeConnection = computed(() => {
    const platform = platformRef.value;
    if (!platform) return null;
    return resolvePlatformConnection(
      platform,
      allConnections.value,
      workspaceRef.value?.databasesByConnection?.value,
    );
  });
  const databaseOptions = computed(() => {
    const id = activeConnection.value?.id;
    const list = id ? workspaceRef.value?.databasesByConnection?.value?.[id] : null;
    if (Array.isArray(list) && list.length) return list;
    const platforms = workspaceRef.value?.state?.platforms || [];
    const seen = new Set();
    const fallback = [];
    for (const item of platforms) {
      for (const name of [item?.sourceDatabase, item?.targetDatabase]) {
        const clean = String(name || "").trim();
        if (clean && !seen.has(clean)) {
          seen.add(clean);
          fallback.push(clean);
        }
      }
    }
    return fallback;
  });

  function databaseOptionsFor(key) {
    const current = String(platformRef.value?.[key] || "").trim();
    const list = [...databaseOptions.value];
    if (current && !list.includes(current)) list.unshift(current);
    return list;
  }

  function updateField(key, value) {
    const platform = platformRef.value;
    if (!platform?.id || !workspaceRef.value?.updatePlatform) return false;
    return workspaceRef.value.updatePlatform(platform.id, { [key]: String(value ?? "") });
  }

  async function browseField(key, kind = "folder") {
    const platform = platformRef.value;
    if (!platform?.id) return null;
    const picked = await pickPlatformPathValue(platform[key], kind);
    if (picked) updateField(key, picked);
    return picked;
  }

  return {
    desktop,
    allConnections,
    mysqlConnections,
    autoMatched,
    activeConnection,
    databaseOptions,
    databaseOptionsFor,
    updateField,
    browseField,
  };
}
