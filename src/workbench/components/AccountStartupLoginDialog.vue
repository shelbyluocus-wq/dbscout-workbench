<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { UserRound } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  account: { type: Object, required: true },
});

const emit = defineEmits(["close", "authenticated"]);

const dialogRef = ref(null);
const usernameInputRef = ref(null);
const displayNameInputRef = ref(null);

const mode = ref("login");
const username = ref("");
const displayName = ref("");
const localError = ref("");

const serverUrl = computed(() => props.account?.serverUrl?.value || "");
const serverLabel = computed(() => serverUrl.value.replace(/^https?:\/\//i, ""));
const accountBusy = computed(() => props.account?.busy?.value || props.account?.busy || {});
const isBusy = computed(() => Boolean(accountBusy.value?.loggingIn || accountBusy.value?.registering));
const errorMessage = computed(() => localError.value || props.account?.lastError?.value || "");
const isUserNotFound = computed(() => (
  mode.value === "login"
  && /(?:404|不存在|not\s+found)/i.test(errorMessage.value)
));
const dialogTitle = computed(() => (
  mode.value === "register"
    ? t("account.startup.registerTitle")
    : t("account.startup.loginTitle")
));
const canSubmit = computed(() => !isBusy.value && Boolean(username.value.trim()));

function handleClose() {
  if (isBusy.value) return;
  localError.value = "";
  props.account?.clearError?.();
  emit("close");
}

useEscClose(() => props.open, handleClose, null, { dialogRef });

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    mode.value = "login";
    localError.value = "";
    props.account?.clearError?.();
    await nextTick();
    usernameInputRef.value?.focus?.();
  },
  { immediate: true },
);

function clearErrors() {
  if (localError.value) localError.value = "";
  if (props.account?.lastError?.value) props.account.clearError?.();
}

async function switchMode(nextMode) {
  if (isBusy.value || mode.value === nextMode) return;
  mode.value = nextMode;
  clearErrors();
  await nextTick();
  if (nextMode === "register" && username.value.trim()) {
    displayNameInputRef.value?.focus?.();
  } else {
    usernameInputRef.value?.focus?.();
  }
}

async function onSubmit() {
  if (isBusy.value) return;
  const trimmedUser = username.value.trim();
  if (!trimmedUser) {
    localError.value = mode.value === "register"
      ? t("backup.alert.registerNeedsUser")
      : t("backup.alert.loginNeedsUser");
    usernameInputRef.value?.focus?.();
    return;
  }
  clearErrors();
  const ok = mode.value === "register"
    ? await props.account?.register?.(trimmedUser, displayName.value.trim())
    : await props.account?.login?.(trimmedUser);
  if (!ok) {
    return;
  }
  username.value = "";
  displayName.value = "";
  localError.value = "";
  emit("authenticated");
}
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay wb-account-login-overlay">
    <form
      ref="dialogRef"
      class="wb-dialog wb-account-login-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="dialogTitle"
      tabindex="-1"
      @submit.prevent="onSubmit"
    >
      <header class="wb-dialog-header wb-account-login-header">
        <div class="wb-account-login-title">
          <span class="wb-account-login-badge" aria-hidden="true">
            <UserRound :size="16" />
          </span>
          <strong>{{ dialogTitle }}</strong>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :disabled="isBusy"
          :aria-label="t('m_3fd47edce45b')"
          @click="handleClose"
        >
          ×
        </button>
      </header>

      <div v-if="serverUrl" class="wb-account-login-status" :title="serverUrl">
        <span class="wb-account-login-status-dot" aria-hidden="true" />
        <span class="wb-account-login-status-text">{{ t("account.startup.connected") }}</span>
        <code class="wb-account-login-server">{{ serverLabel }}</code>
      </div>

      <p class="wb-account-login-subtitle">
        {{ mode === "register" ? t("account.startup.registerSubtitle") : t("account.startup.loginSubtitle") }}
      </p>

      <div class="wb-account-login-fields">
        <label class="wb-account-login-field">
          <span>{{ t("account.startup.usernameLabel") }}</span>
          <input
            ref="usernameInputRef"
            v-model="username"
            type="text"
            autocomplete="username"
            :disabled="isBusy"
            :placeholder="t('account.startup.usernamePlaceholder')"
            @input="clearErrors"
          />
        </label>

        <label v-if="mode === 'register'" class="wb-account-login-field">
          <span>{{ t("account.startup.displayNameLabel") }}</span>
          <input
            ref="displayNameInputRef"
            v-model="displayName"
            type="text"
            autocomplete="name"
            :disabled="isBusy"
            :placeholder="t('account.startup.displayNamePlaceholder')"
            @input="clearErrors"
          />
        </label>
      </div>

      <div v-if="errorMessage" class="wb-account-login-error" role="alert">
        <span>{{ errorMessage }}</span>
        <button
          v-if="isUserNotFound"
          type="button"
          class="wb-account-login-inline-link"
          :disabled="isBusy"
          @click="switchMode('register')"
        >
          {{ t("account.startup.notFoundSwitch") }}
        </button>
      </div>

      <footer class="wb-account-login-footer">
        <button
          type="button"
          class="wb-account-login-mode-link"
          :disabled="isBusy"
          @click="switchMode(mode === 'register' ? 'login' : 'register')"
        >
          {{ mode === "register" ? t("account.startup.switchToLogin") : t("account.startup.switchToRegister") }}
        </button>
        <div class="wb-account-login-actions">
          <button type="button" :disabled="isBusy" @click="handleClose">
            {{ t("account.startup.later") }}
          </button>
          <button type="submit" class="wb-dialog-primary" :disabled="!canSubmit">
            <template v-if="mode === 'register'">
              {{ accountBusy.registering ? t("account.startup.registering") : t("account.startup.registerAction") }}
            </template>
            <template v-else>
              {{ accountBusy.loggingIn ? t("account.startup.loggingIn") : t("account.startup.loginAction") }}
            </template>
          </button>
        </div>
      </footer>
    </form>
  </div>
</template>
