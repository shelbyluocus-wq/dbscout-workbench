<script setup>
// Interactive database route for workflow steps: MySQL connection selector plus
// sourceDatabase -> targetDatabase comboboxes backed by loaded schemas.
import { computed, ref, watch } from "vue";
import { ArrowRight } from "lucide-vue-next";
import { DefaultDatabaseIcon as Database } from "./DefaultDatabaseIcon.js";
import { t } from "../i18n/index.js";
import { formatPlatformConnectionLabel, usePlatformFieldMeta } from "../utils/releasePlatformFields.js";
import ReleaseCombobox from "./ReleaseCombobox.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
  disabled: { type: Boolean, default: false },
  showConnection: { type: Boolean, default: true },
});

const workspaceRef = computed(() => props.workspace);
const platform = computed(() => props.flow.platform.value);
const {
  desktop,
  mysqlConnections,
  autoMatched,
  databaseOptionsFor,
  updateField,
} = usePlatformFieldMeta(workspaceRef, platform);

const sourceDraft = ref("");
const targetDraft = ref("");

watch(() => platform.value?.sourceDatabase, (value) => {
  sourceDraft.value = String(value || "");
}, { immediate: true });

watch(() => platform.value?.targetDatabase, (value) => {
  targetDraft.value = String(value || "");
}, { immediate: true });

function commitDb(key, value) {
  const next = String(value ?? "").trim();
  if (!next) {
    if (key === "sourceDatabase") sourceDraft.value = String(platform.value?.sourceDatabase || "");
    else targetDraft.value = String(platform.value?.targetDatabase || "");
    return;
  }
  if (key === "sourceDatabase") sourceDraft.value = next;
  else targetDraft.value = next;
  updateField(key, next);
}

function onConnectionChange(event) {
  updateField("connectionId", event.target.value);
}
</script>

<template>
  <div class="wb-rf-db-route-wrap">
    <div v-if="workspace && showConnection && (desktop || mysqlConnections.length)" class="wb-rf-inline-conn">
      <label class="wb-rf-inline-conn-field">
        <span>{{ t('releaseFlow.platformEditor.connectionId') }}</span>
        <select
          :value="platform.connectionId || ''"
          class="wb-rf-input"
          :disabled="disabled"
          data-release-field="connectionId"
          @change="onConnectionChange"
        >
          <option value="">
            {{ autoMatched
              ? t('releaseFlow.platformEditor.autoConnectionMatched', { name: formatPlatformConnectionLabel(autoMatched) })
              : t('releaseFlow.platformEditor.autoConnection') }}
          </option>
          <option v-for="conn in mysqlConnections" :key="conn.id" :value="conn.id">
            {{ formatPlatformConnectionLabel(conn) }}
          </option>
        </select>
      </label>
    </div>

    <div class="wb-rf-route">
      <div class="wb-rf-route-node" :class="{ 'is-editable': Boolean(workspace) }">
        <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.database.source') }}</span>
        <ReleaseCombobox
          v-if="workspace"
          v-model="sourceDraft"
          :options="databaseOptionsFor('sourceDatabase')"
          :label="t('releaseFlow.database.source')"
          :placeholder="t('releaseFlow.platformEditor.chooseDatabase')"
          :disabled="disabled"
          :input-props="{ 'data-release-field': 'sourceDatabase' }"
          @pick="commitDb('sourceDatabase', $event)"
          @focusout="commitDb('sourceDatabase', sourceDraft)"
        />
        <strong v-else class="wb-rf-code">{{ platform.sourceDatabase }}</strong>
      </div>
      <span class="wb-rf-route-arrow" aria-hidden="true"><ArrowRight :size="18" /></span>
      <div class="wb-rf-route-node is-target" :class="{ 'is-editable': Boolean(workspace) }">
        <span><Database :size="13" aria-hidden="true" />{{ t('releaseFlow.database.target', { platform: platform.name }) }}</span>
        <ReleaseCombobox
          v-if="workspace"
          v-model="targetDraft"
          :options="databaseOptionsFor('targetDatabase')"
          :label="t('releaseFlow.database.target', { platform: platform.name })"
          :placeholder="t('releaseFlow.platformEditor.chooseDatabase')"
          :disabled="disabled"
          :input-props="{ 'data-release-field': 'targetDatabase' }"
          @pick="commitDb('targetDatabase', $event)"
          @focusout="commitDb('targetDatabase', targetDraft)"
        />
        <strong v-else class="wb-rf-code">{{ platform.targetDatabase }}</strong>
      </div>
    </div>
  </div>
</template>
