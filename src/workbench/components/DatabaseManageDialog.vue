<script setup>
import { t } from "../i18n/index.js";
import { computed, nextTick, ref, watch } from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { DEFAULT_CHARSET_OPTIONS } from "../utils/tableDesign.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  mode: { type: String, default: "create" }, // "create" | "edit" | "drop"
  connectionId: { type: String, default: "" },
  connectionLabel: { type: String, default: "" },
  database: { type: String, default: "" },
  invokeWorkbench: { type: Function, required: true },
});

const emit = defineEmits(["close", "created", "updated", "dropped"]);

const dialogRef = ref(null);
const dbNameInputRef = ref(null);
const confirmInputRef = ref(null);
const busy = ref(false);
const loading = ref(false);
const error = ref("");
const databaseName = ref("");
const charset = ref("utf8mb4");
const collation = ref("utf8mb4_general_ci");
const confirmInput = ref("");
const charsets = ref(DEFAULT_CHARSET_OPTIONS);
let loadToken = 0;

useEscClose(() => props.open, () => emit("close"), () => busy.value, { dialogRef });

const isCreate = computed(() => props.mode === "create");
const isEdit = computed(() => props.mode === "edit");
const isDrop = computed(() => props.mode === "drop");

const availableCollations = computed(() => {
  const current = String(charset.value || "").toLowerCase();
  const matched = charsets.value.find((item) => item.charset.toLowerCase() === current);
  if (matched?.collations?.length) return matched.collations;
  return collation.value ? [collation.value] : [];
});

const sqlPreview = computed(() => {
  const name = (isCreate.value ? databaseName.value : props.database).trim() || "database_name";
  const ident = `\`${name.replaceAll("`", "``")}\``;
  if (isDrop.value) return `DROP DATABASE ${ident}`;
  if (isEdit.value) {
    return `ALTER DATABASE ${ident} CHARACTER SET ${charset.value || "utf8mb4"}${collation.value ? ` COLLATE ${collation.value}` : ""}`;
  }
  return `CREATE DATABASE ${ident}${charset.value ? ` CHARACTER SET ${charset.value}` : ""}${collation.value ? ` COLLATE ${collation.value}` : ""}`;
});

const canSubmit = computed(() => {
  if (busy.value || loading.value) return false;
  if (isCreate.value) return Boolean(databaseName.value.trim());
  if (isEdit.value) return Boolean(charset.value.trim());
  if (isDrop.value) return confirmInput.value.trim() === props.database.trim() && Boolean(props.database.trim());
  return false;
});

function onCharsetChange(nextCharset) {
  charset.value = nextCharset;
  const matched = charsets.value.find((item) => item.charset.toLowerCase() === String(nextCharset || "").toLowerCase());
  if (matched) {
    collation.value = matched.defaultCollation || matched.collations?.[0] || "";
  }
}

async function loadMetadata() {
  const token = ++loadToken;
  error.value = "";
  databaseName.value = isCreate.value ? "" : props.database;
  confirmInput.value = "";
  charsets.value = DEFAULT_CHARSET_OPTIONS;
  charset.value = "utf8mb4";
  collation.value = "utf8mb4_general_ci";

  if (!props.open || !props.connectionId || isDrop.value) {
    await nextTick();
    if (isDrop.value) confirmInputRef.value?.focus();
    return;
  }

  loading.value = true;
  try {
    if (isCreate.value) {
      const result = await props.invokeWorkbench("list_server_charsets", { connectionId: props.connectionId });
      if (token !== loadToken) return;
      if (Array.isArray(result) && result.length) {
        charsets.value = result;
        const preferred = result.find((item) => item.charset === "utf8mb4") || result[0];
        charset.value = preferred.charset;
        collation.value = preferred.defaultCollation || preferred.collations?.[0] || "";
      }
    } else if (isEdit.value) {
      const result = await props.invokeWorkbench("get_database_properties", {
        connectionId: props.connectionId,
        database: props.database,
      });
      if (token !== loadToken) return;
      if (Array.isArray(result?.charsets) && result.charsets.length) {
        charsets.value = result.charsets;
      }
      charset.value = result?.charset || "utf8mb4";
      collation.value = result?.collation || "";
    }
  } catch (err) {
    if (token === loadToken) error.value = String(err?.message || err || "");
  } finally {
    if (token === loadToken) {
      loading.value = false;
      await nextTick();
      if (isCreate.value) dbNameInputRef.value?.focus();
    }
  }
}

watch(
  () => [props.open, props.mode, props.connectionId, props.database],
  ([open]) => {
    if (open) void loadMetadata();
  },
  { immediate: true },
);

async function submit() {
  if (!canSubmit.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (isCreate.value) {
      const res = await props.invokeWorkbench("create_database", {
        request: {
          connectionId: props.connectionId,
          database: databaseName.value.trim(),
          charset: charset.value || null,
          collation: collation.value || null,
        },
      });
      emit("created", { connectionId: props.connectionId, database: res.database, databases: res.databases });
      emit("close");
    } else if (isEdit.value) {
      await props.invokeWorkbench("alter_database", {
        request: {
          connectionId: props.connectionId,
          database: props.database,
          charset: charset.value,
          collation: collation.value || null,
        },
      });
      emit("updated", {
        connectionId: props.connectionId,
        database: props.database,
        charset: charset.value,
        collation: collation.value,
      });
      emit("close");
    } else if (isDrop.value) {
      const res = await props.invokeWorkbench("drop_database", {
        request: {
          connectionId: props.connectionId,
          database: props.database,
          confirmedName: confirmInput.value.trim(),
        },
      });
      emit("dropped", { connectionId: props.connectionId, database: res.database, databases: res.databases });
      emit("close");
    }
  } catch (err) {
    error.value = String(err?.message || err || "");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay">
    <form
      ref="dialogRef"
      class="wb-dialog wb-db-manage-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="isCreate ? t('databaseManage.createTitle') : isEdit ? t('databaseManage.editTitle') : t('databaseManage.dropTitle')"
      tabindex="-1"
      @submit.prevent="submit"
    >
      <header class="wb-dialog-header">
        <strong>{{ isCreate ? t('databaseManage.createTitle') : isEdit ? t('databaseManage.editTitle') : t('databaseManage.dropTitle') }}</strong>
        <button type="button" class="wb-dialog-close" :disabled="busy" @click="emit('close')">×</button>
      </header>

      <p class="wb-db-manage-scope">
        {{ connectionLabel || connectionId }}<template v-if="!isCreate && database"> · {{ database }}</template>
      </p>

      <template v-if="isDrop">
        <div class="wb-db-manage-danger-box" role="alert">
          <strong>{{ t('databaseManage.dropWarningTitle') }}</strong>
          <p>{{ t('databaseManage.dropWarningBody', { database }) }}</p>
        </div>
        <label class="wb-dialog-field">
          <span>{{ t('databaseManage.dropConfirmLabel', { database }) }}</span>
          <input
            ref="confirmInputRef"
            v-model="confirmInput"
            :disabled="busy"
            :placeholder="database"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
      </template>

      <template v-else>
        <label class="wb-dialog-field">
          <span>{{ t('databaseManage.nameLabel') }}</span>
          <input
            v-if="isCreate"
            ref="dbNameInputRef"
            v-model="databaseName"
            :disabled="busy"
            maxlength="64"
            :placeholder="t('databaseManage.namePlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
          <input v-else :value="database" disabled />
        </label>
        <label class="wb-dialog-field">
          <span>{{ t('databaseManage.charsetLabel') }}</span>
          <select :value="charset" :disabled="busy || loading" @change="onCharsetChange($event.target.value)">
            <option v-for="item in charsets" :key="item.charset" :value="item.charset">{{ item.charset }}</option>
          </select>
        </label>
        <label class="wb-dialog-field">
          <span>{{ t('databaseManage.collationLabel') }}</span>
          <select v-model="collation" :disabled="busy || loading || !availableCollations.length">
            <option value="">{{ t('databaseManage.collationAuto') }}</option>
            <option v-for="col in availableCollations" :key="col" :value="col">{{ col }}</option>
          </select>
        </label>
      </template>

      <div class="wb-db-manage-preview">
        <span>{{ t('databaseManage.sqlPreview') }}</span>
        <code>{{ sqlPreview }}</code>
      </div>

      <p v-if="error" class="wb-dialog-error" role="alert">{{ error }}</p>

      <footer class="wb-dialog-actions">
        <button type="button" :disabled="busy" @click="emit('close')">{{ t('m_2cd0f3be8738') }}</button>
        <button
          type="submit"
          class="wb-dialog-primary"
          :class="{ danger: isDrop }"
          :disabled="!canSubmit"
        >
          {{
            busy
              ? t('databaseManage.submitting')
              : isCreate
                ? t('databaseManage.createConfirm')
                : isEdit
                  ? t('databaseManage.editConfirm')
                  : t('databaseManage.dropConfirm')
          }}
        </button>
      </footer>
    </form>
  </div>
</template>
