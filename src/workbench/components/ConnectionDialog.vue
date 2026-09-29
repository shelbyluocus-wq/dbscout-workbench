<script setup>
import { t } from "../i18n/index.js";
import { computed, ref } from "vue";
import { useEscClose } from "../composables/useEscClose.js";
import { parseConnectionConfigText } from "../utils/connectionConfigImport.js";
import { isConnFormComplete, isConnTestReady, normalizeConnectionKind } from "../utils/connectionKinds.js";

const props = defineProps({
  dialog: { type: Object, required: true },
  busy: { type: Boolean, default: false },
  testBusy: { type: Boolean, default: false },
});

const emit = defineEmits(["submit", "cancel", "test", "field-change", "config-import", "config-import-error"]);
const draggingConfig = ref(false);
const dialogRef = ref(null);

useEscClose(() => props.dialog.open, () => emit("cancel"), () => props.busy || props.testBusy, { dialogRef });

const formComplete = computed(() => isConnFormComplete(props.dialog));
const testReady = computed(() => isConnTestReady(props.dialog));
const kindPlaceholders = computed(() => {
  const kind = normalizeConnectionKind(props.dialog.kind);
  if (kind === "clickhouse") return { host: "127.0.0.1", port: "8123", username: "default" };
  if (kind === "mongodb") return { host: "127.0.0.1 或 mongodb:// 连接串", port: "27017", username: "可空" };
  return { host: "127.0.0.1", port: "3306", username: "root" };
});

function applyKindDefaults() {
  const kind = normalizeConnectionKind(props.dialog.kind);
  props.dialog.kind = kind;
  const ports = { mysql: "3306", clickhouse: "8123", mongodb: "27017" };
  const users = { mysql: "root", clickhouse: "default", mongodb: "" };
  const otherPorts = Object.values(ports).filter((port) => port !== ports[kind]);
  const otherUsers = Object.values(users).filter((user) => user !== users[kind]);
  if (!props.dialog.port || otherPorts.includes(props.dialog.port)) props.dialog.port = ports[kind];
  if (!props.dialog.username || otherUsers.includes(props.dialog.username)) {
    props.dialog.username = users[kind];
  }
  emit("field-change");
}

function onFieldChange() {
  emit("field-change");
}

function setDropEffect(event) {
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onDialogDragEnter(event) {
  setDropEffect(event);
  draggingConfig.value = true;
}

function onDialogDragOver(event) {
  setDropEffect(event);
  draggingConfig.value = true;
}

function onDialogDragLeave(event) {
  if (event.currentTarget?.contains(event.relatedTarget)) return;
  draggingConfig.value = false;
}

async function onDialogDrop(event) {
  draggingConfig.value = false;
  const file = Array.from(event.dataTransfer?.files || [])[0];
  if (!file) return;
  try {
    const parsed = parseConnectionConfigText(await file.text(), { fileName: file.name });
    emit("config-import", parsed.config);
  } catch (error) {
    emit("config-import-error", error);
  }
}
</script>

<template>
  <div v-if="dialog.open" class="wb-dialog-overlay">
    <form
      ref="dialogRef"
      class="wb-dialog"
      :class="{ 'is-config-dragging': draggingConfig }"
      role="dialog"
      aria-modal="true"
      :aria-label="t('m_441ba9e5a9b7')"
      tabindex="-1"
      @submit.prevent="emit('submit')"
      @dragenter.prevent.stop="onDialogDragEnter"
      @dragover.prevent.stop="onDialogDragOver"
      @dragleave.prevent.stop="onDialogDragLeave"
      @drop.prevent.stop="onDialogDrop"
    >
      <header class="wb-dialog-header">
        <strong>{{ t('m_441ba9e5a9b7') }}</strong>
        <button type="button" class="wb-dialog-close" @click="emit('cancel')">×</button>
      </header>
      <div class="wb-config-dropzone" :class="{ 'is-active': draggingConfig }">
        <span class="wb-config-dropzone-mark">JSON</span>
        <span>{{ t('m_c34d1be9488f') }}</span>
      </div>
      <label class="wb-dialog-field">
        <span>{{ t('m_ba40014ff496') }}</span>
        <select v-model="dialog.kind" @change="applyKindDefaults">
          <option value="mysql">MySQL</option>
          <option value="clickhouse">ClickHouse</option>
          <option value="mongodb">MongoDB</option>
        </select>
      </label>
      <label class="wb-dialog-field">
        <span>{{ t('m_e87d9f23a3f5') }}</span>
        <input v-model="dialog.host" :placeholder="kindPlaceholders.host" @input="onFieldChange" />
      </label>
      <label class="wb-dialog-field">
        <span>{{ t('m_e71ac32b544b') }}</span>
        <input
          v-model="dialog.port"
          :placeholder="kindPlaceholders.port"
          @input="onFieldChange"
        />
      </label>
      <label class="wb-dialog-field">
        <span>{{ t('m_1a3f0617d6de') }}</span>
        <input
          v-model="dialog.username"
          :placeholder="kindPlaceholders.username"
          @input="onFieldChange"
        />
      </label>
      <label class="wb-dialog-field">
        <span>{{ t('m_a621ab606db2') }}</span>
        <input v-model="dialog.password" type="password" :placeholder="t('m_a621ab606db2')" @input="onFieldChange" />
      </label>
      <p v-if="dialog.importedDatabase" class="wb-dialog-note">{{ t('m_33330b4229f1') }}{{ dialog.importedDatabase }}</p>
      <p v-if="dialog.error" class="wb-dialog-error">{{ dialog.error }}</p>
      <footer class="wb-dialog-actions">
        <button type="button" @click="emit('cancel')">{{ t('m_2cd0f3be8738') }}</button>
        <button
          type="button"
          class="wb-dialog-test-btn"
          :class="{ 'is-success': dialog.testPassed }"
          :disabled="testBusy || busy || !testReady"
          @click="emit('test')"
        >
          {{ testBusy ? t('m_105a9082c346') : dialog.testPassed ? t('m_0a7bc17bba9f') : t('m_0a98a48eaaac') }}
        </button>
        <button
          type="submit"
          class="wb-dialog-primary"
          :disabled="busy || testBusy || !formComplete"
        >
          {{ busy ? t('m_ee9ebe523d42') : t('m_5a048351a77f') }}
        </button>
      </footer>
    </form>
  </div>
</template>
