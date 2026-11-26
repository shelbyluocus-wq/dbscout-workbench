<script setup>
import { computed, ref, watch } from "vue";
import { FolderOpen, HardDrive, History, Trash2, UserRound } from "lucide-vue-next";

import BackupNumberInput from "./BackupNumberInput.vue";
import { t } from "../i18n/index.js";
import { useConfirm } from "../composables/useConfirm.js";

const props = defineProps({
  backup: { type: Object, required: true },
  account: { type: Object, default: null },
});

const emit = defineEmits(["close"]);

const { confirm, alert } = useConfirm();

const busy = computed(() => props.backup.busy);
const config = computed(() => props.backup.config.value || {});
const account = computed(() => props.account || null);
const isLoggedIn = computed(() => Boolean(account.value?.isLoggedIn?.value));
const displayName = computed(() => account.value?.displayName?.value || "");
const username = computed(() => account.value?.username?.value || "");
const serverUrl = computed(() => account.value?.serverUrl?.value || "");
const accountError = computed(() => account.value?.lastError?.value || "");
const accountBusy = computed(() => account.value?.busy?.value || account.value?.busy || {});

function currentError(fallback) {
  return props.backup.lastError.value || fallback;
}

// ---- Backup settings draft ---------------------------------------------------
// The form edits a local draft so v-model triggers Vue reactivity (the backend
// config lives in a shallowRef). Fields listed here are saved by "Save
// settings"; everything else (such as the automatic snapshot scope) is saved
// immediately elsewhere and must not be overwritten by a stale draft.
const EDITABLE_FIELDS = ["auditRetentionDays", "storageDir"];

const draftConfig = ref({});

function editedFields(draft, base) {
  const edits = {};
  for (const key of EDITABLE_FIELDS) {
    if ((draft?.[key] ?? null) !== (base?.[key] ?? null)) edits[key] = draft[key];
  }
  if ("storageDir" in edits) edits.resolvedStorageDir = draft.resolvedStorageDir;
  return edits;
}

watch(
  () => props.backup.config.value,
  (value, previous) => {
    // Keep unsaved edits when the config refreshes for an unrelated reason,
    // for example after toggling a database on the Snapshots tab.
    const edits = previous ? editedFields(draftConfig.value, previous) : {};
    draftConfig.value = { ...(value || {}), ...edits };
  },
  { immediate: true },
);

const isDirty = computed(() => Object.keys(editedFields(draftConfig.value, config.value)).length > 0);

function onDiscard() {
  draftConfig.value = { ...config.value };
}

const storageDirDisplay = computed(() => {
  const dir = draftConfig.value?.storageDir || draftConfig.value?.resolvedStorageDir;
  return dir && String(dir).trim() ? dir : t("backup.settings.storageDefault");
});

async function openBackupPath(path) {
  const ok = await props.backup.openBackupPath(path);
  if (!ok) {
    await alert({ title: t("backup.alert.openFailedTitle"), message: currentError(t("backup.alert.openFailed")) });
  }
  return ok;
}

async function onOpenStorageDir() {
  const dir = draftConfig.value?.storageDir;
  const savedDir = config.value?.storageDir;
  if (dir && dir !== savedDir) {
    const ok = await props.backup.saveConfig({ ...draftConfig.value });
    if (!ok) {
      await alert({ title: t("backup.alert.openFailedTitle"), message: currentError(t("backup.alert.openSaveFailed")) });
      return;
    }
  }
  await openBackupPath(draftConfig.value?.resolvedStorageDir || draftConfig.value?.storageDir);
}

async function onPickStorageDir() {
  const dir = await props.backup.pickStorageDir();
  if (dir) {
    draftConfig.value = { ...draftConfig.value, storageDir: dir, resolvedStorageDir: dir };
  }
}

async function onSaveConfig() {
  const ok = await props.backup.saveConfig({ ...draftConfig.value });
  if (!ok) {
    await alert({ title: t("backup.alert.saveFailedTitle"), message: currentError(t("backup.alert.saveFailed")) });
    return;
  }
  await alert({
    title: t("backup.alert.savedTitle"),
    message: t("backup.alert.saved"),
  });
  emit("close");
}

async function onClearAuditLogs() {
  const approved = await confirm({
    title: t("backup.alert.clearConfirmTitle"),
    message: t("backup.alert.clearConfirm"),
    confirmText: t("backup.alert.clearConfirmAction"),
    danger: true,
  });
  if (!approved) return;
  const result = await props.backup.clearAuditLogs();
  const deletedCount = Number(result?.deletedCount || 0);
  await alert({
    title: deletedCount > 0 ? t("backup.alert.clearedTitle") : t("backup.alert.clearNoneTitle"),
    message: deletedCount > 0 ? t("backup.alert.cleared", { count: deletedCount }) : t("backup.alert.clearNone"),
  });
}

// ---- Account -------------------------------------------------------------------
// Local form state kept separate from the account composable so v-model works
// on plain inputs. Account actions apply immediately, independent of Save.
const accountDraft = ref({ serverUrl: "", username: "", displayName: "" });
watch(
  () => [serverUrl.value],
  () => {
    accountDraft.value.serverUrl = serverUrl.value;
  },
  { immediate: true },
);

async function onSaveServerUrl() {
  const ok = await account.value?.setServer(accountDraft.value.serverUrl);
  if (!ok) {
    await alert({ title: t("backup.alert.saveFailedTitle"), message: accountError.value || t("backup.alert.serverSaveFailed") });
  }
}

async function onRegister() {
  if (!accountDraft.value.username.trim()) {
    await alert({ title: t("backup.alert.usernameTitle"), message: t("backup.alert.registerNeedsUser") });
    return;
  }
  const ok = await account.value?.register(
    accountDraft.value.username,
    accountDraft.value.displayName,
  );
  if (!ok) {
    await alert({ title: t("backup.alert.registerFailedTitle"), message: accountError.value || t("backup.alert.registerFailedTitle") });
    return;
  }
  // Clear the form fields on success — the user is now shown in the header.
  accountDraft.value.username = "";
  accountDraft.value.displayName = "";
}

async function onLogin() {
  if (!accountDraft.value.username.trim()) {
    await alert({ title: t("backup.alert.usernameTitle"), message: t("backup.alert.loginNeedsUser") });
    return;
  }
  const ok = await account.value?.login(accountDraft.value.username);
  if (!ok) {
    await alert({ title: t("backup.alert.loginFailedTitle"), message: accountError.value || t("backup.alert.loginFailedTitle") });
    return;
  }
  accountDraft.value.username = "";
  accountDraft.value.displayName = "";
}

async function onLogout() {
  const approved = await confirm({
    title: t("backup.alert.logoutTitle"),
    message: t("backup.alert.logout"),
    confirmText: t("m_3ab8cc15939f"),
    danger: true,
  });
  if (!approved) return;
  await account.value?.logout();
}
</script>

<template>
  <div class="wb-backup-settings">
    <div class="wb-backup-settings-scroll">
      <section class="wb-backup-settings-section" aria-labelledby="wb-backup-settings-storage">
        <header class="wb-backup-settings-head">
          <span class="wb-backup-settings-icon"><HardDrive :size="16" aria-hidden="true" /></span>
          <div>
            <h3 id="wb-backup-settings-storage">{{ t('m_6d8627b2f68e') }}</h3>
            <p>{{ t('m_0d76d263a7c9') }}</p>
          </div>
        </header>
        <div class="wb-backup-storage-control">
          <code class="wb-backup-storage-path" :title="storageDirDisplay">{{ storageDirDisplay }}</code>
          <button type="button" class="wb-backup-icon-text" :disabled="busy.openingPath || busy.savingConfig" @click="onOpenStorageDir"><FolderOpen :size="14" aria-hidden="true" />{{ t('m_c771248e511f') }}</button>
          <button type="button" :disabled="busy.pickingDir || busy.savingConfig" @click="onPickStorageDir">
            {{ busy.pickingDir ? t('m_71732f06ad09') : t('m_d7392d66de94') }}
          </button>
        </div>
      </section>

      <section class="wb-backup-settings-section" aria-labelledby="wb-backup-settings-history">
        <header class="wb-backup-settings-head">
          <span class="wb-backup-settings-icon"><History :size="16" aria-hidden="true" /></span>
          <div>
            <h3 id="wb-backup-settings-history">{{ t('m_7bf9d4a5d756') }}</h3>
            <p>{{ t('backup.settings.historyDescription') }}</p>
          </div>
        </header>
        <div class="wb-backup-config-fields">
          <label class="wb-backup-config-field">
            <span>{{ t('m_73ee420285b4') }}</span>
            <span class="wb-backup-config-input">
              <BackupNumberInput v-model="draftConfig.auditRetentionDays" :min="1" :aria-label="t('m_a3ce04787765')" />
              <em>{{ t('m_49da61ceeea2') }}</em>
            </span>
          </label>
          <div class="wb-backup-config-field">
            <span>{{ t('backup.settings.clearLabel') }}</span>
            <span class="wb-backup-config-input">
              <button
                type="button"
                class="wb-backup-action-danger wb-backup-icon-text"
                :disabled="busy.listing || busy.deleting"
                :title="t('m_492827885e5c')"
                @click="onClearAuditLogs"
              ><Trash2 :size="14" aria-hidden="true" />{{ busy.deleting ? t('m_191f6e5642c2') : t('backup.settings.clearAction') }}</button>
              <em>{{ t('m_492827885e5c') }}</em>
            </span>
          </div>
        </div>
      </section>

      <section class="wb-backup-settings-section wb-account-section" aria-labelledby="wb-backup-settings-account">
        <header class="wb-backup-settings-head">
          <span class="wb-backup-settings-icon"><UserRound :size="16" aria-hidden="true" /></span>
          <div>
            <h3 id="wb-backup-settings-account">{{ t('m_082edb693d65') }}</h3>
            <p>{{ t('m_a7ef24167da2') }} {{ t('backup.settings.accountImmediate') }}</p>
          </div>
        </header>

        <div class="wb-backup-config-fields">
          <label class="wb-backup-config-field">
            <span>{{ t('m_937c4d303733') }}</span>
            <span class="wb-account-server-control">
              <input
                v-model="accountDraft.serverUrl"
                type="text"
                placeholder="http://192.168.1.243:8766"
                :aria-label="t('m_937c4d303733')"
              />
              <button type="button" :disabled="accountBusy.savingServer" @click="onSaveServerUrl">
                {{ accountBusy.savingServer ? t('m_ff509c9ba052') : t('m_a3030bf8f16d') }}
              </button>
            </span>
          </label>

          <div v-if="isLoggedIn" class="wb-account-logged-in">
            <div class="wb-account-session">
              <span class="wb-account-avatar">{{ (displayName || username || '?').slice(0, 1).toUpperCase() }}</span>
              <span class="wb-account-session-text">
                <strong>{{ displayName || username }}</strong>
                <em>@{{ username }}</em>
              </span>
            </div>
            <button
              type="button"
              class="wb-backup-action-danger"
              :disabled="accountBusy.loggingOut"
              @click="onLogout"
            >{{ accountBusy.loggingOut ? t('m_4803e2da0873') : t('m_3ab8cc15939f') }}</button>
          </div>

          <template v-else>
            <label class="wb-backup-config-field">
              <span>{{ t('m_1a3f0617d6de') }}</span>
              <input
                v-model="accountDraft.username"
                type="text"
                class="wb-account-input"
                :placeholder="t('m_243b4d9f1f88')"
                :aria-label="t('m_1a3f0617d6de')"
              />
            </label>
            <label class="wb-backup-config-field">
              <span>{{ t('m_72e6ce1c561e') }}</span>
              <input
                v-model="accountDraft.displayName"
                type="text"
                class="wb-account-input"
                :placeholder="t('m_2ee067611e30')"
                :aria-label="t('m_7a1e2b964b67')"
              />
            </label>
            <p v-if="accountError" class="wb-dialog-error">{{ accountError }}</p>
            <div class="wb-account-actions">
              <p class="wb-account-hint">{{ t('m_e7c4c138ba05') }}</p>
              <button type="button" :disabled="accountBusy.registering" @click="onRegister">
                {{ accountBusy.registering ? t('m_0debc065262a') : t('m_c4fb62202bad') }}
              </button>
              <button type="button" class="wb-dialog-primary" :disabled="accountBusy.loggingIn" @click="onLogin">
                {{ accountBusy.loggingIn ? t('m_3f06ed8f8c38') : t('m_1e2df9c3075a') }}
              </button>
            </div>
          </template>
        </div>
      </section>
    </div>

    <footer class="wb-backup-settings-footer" :data-dirty="isDirty">
      <span class="wb-backup-settings-state" role="status">
        {{ isDirty ? t('backup.settings.unsaved') : t('backup.settings.upToDate') }}
      </span>
      <button type="button" :disabled="!isDirty || busy.savingConfig" @click="onDiscard">{{ t('backup.settings.discard') }}</button>
      <button type="button" class="wb-dialog-primary" :disabled="!isDirty || busy.savingConfig" @click="onSaveConfig">
        {{ busy.savingConfig ? t('m_ff509c9ba052') : t('m_c8550237ba70') }}
      </button>
    </footer>
  </div>
</template>
