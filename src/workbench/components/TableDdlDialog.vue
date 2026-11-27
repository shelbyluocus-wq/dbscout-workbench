<script setup>
import { t } from "../i18n/index.js";
import { onBeforeUnmount, ref } from "vue";
import { Check, Copy, Terminal } from "lucide-vue-next";
import { useEscClose } from "../composables/useEscClose.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  connectionId: { type: String, default: "" },
  database: { type: String, default: "" },
  tableName: { type: String, default: "" },
  ddl: { type: String, default: "" },
  loading: { type: Boolean, default: false },
  error: { type: String, default: "" },
  canOpenInSqlConsole: { type: Boolean, default: false },
});

const emit = defineEmits(["close", "open-in-sql"]);

const dialogRef = ref(null);
const copied = ref(false);
let copyTimer = null;

useEscClose(() => props.open, () => emit("close"), null, { dialogRef });

async function copyDdl() {
  if (!props.ddl) return;
  try {
    await navigator.clipboard?.writeText?.(props.ddl);
  } catch {
    // Fallback ignored when clipboard is unavailable in restricted contexts.
  }
  copied.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copied.value = false; }, 1500);
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-table-ddl-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('tableDdl.title')"
      tabindex="-1"
    >
      <header class="wb-dialog-header">
        <div>
          <strong>{{ t('tableDdl.title') }}</strong>
          <small v-if="database || tableName">{{ [database, tableName].filter(Boolean).join(".") }}</small>
        </div>
        <button type="button" class="wb-dialog-close" :aria-label="t('m_3fd47edce45b')" @click="emit('close')">×</button>
      </header>

      <div class="wb-table-ddl-body">
        <p v-if="loading" class="wb-table-ddl-state" role="status">{{ t('tableDdl.loading') }}</p>
        <p v-else-if="error" class="wb-dialog-error" role="alert">{{ error }}</p>
        <pre v-else class="wb-table-ddl-code"><code>{{ ddl }}</code></pre>
      </div>

      <footer class="wb-dialog-actions">
        <button
          v-if="canOpenInSqlConsole"
          type="button"
          :disabled="loading || !ddl"
          @click="emit('open-in-sql', { connectionId, database, tableName, ddl })"
        >
          <Terminal :size="14" aria-hidden="true" />
          <span>{{ t('tableDdl.openInSql') }}</span>
        </button>
        <button
          type="button"
          class="wb-dialog-primary"
          :disabled="loading || !ddl"
          @click="copyDdl"
        >
          <Check v-if="copied" :size="14" aria-hidden="true" />
          <Copy v-else :size="14" aria-hidden="true" />
          <span>{{ copied ? t('tableDdl.copied') : t('tableDdl.copy') }}</span>
        </button>
        <button type="button" @click="emit('close')">{{ t('m_3fd47edce45b') }}</button>
      </footer>
    </section>
  </div>
</template>
