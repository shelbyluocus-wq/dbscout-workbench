<script setup>
// Where a platform's update goes: its databases, client folders, conversion
// template and Cocos editor. Fields save when they lose focus, so typing never
// resets finished steps keystroke by keystroke. The build options themselves
// are set on the client build page.
import { computed, reactive, watch } from "vue";
import { FolderOpen } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { formatPlatformConnectionLabel, usePlatformFieldMeta } from "../utils/releasePlatformFields.js";
import ReleaseCombobox from "./ReleaseCombobox.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
  platform: { type: Object, required: true },
});

const workspaceRef = computed(() => props.workspace);
const platformRef = computed(() => props.platform);
const busy = computed(() => Boolean(props.workspace.flowOfPlatform(props.platform.id)?.busy.value));
const templates = computed(() => props.workspace.templates.value);
const {
  desktop,
  mysqlConnections,
  autoMatched,
  databaseOptionsFor,
  updateField,
  browseField,
} = usePlatformFieldMeta(workspaceRef, platformRef);

const dbDrafts = reactive({ sourceDatabase: "", targetDatabase: "" });

watch(() => props.platform.sourceDatabase, (value) => {
  dbDrafts.sourceDatabase = String(value || "");
}, { immediate: true });

watch(() => props.platform.targetDatabase, (value) => {
  dbDrafts.targetDatabase = String(value || "");
}, { immediate: true });

const GROUPS = Object.freeze([
  { id: "database", fields: [{ key: "sourceDatabase", dbList: true }, { key: "targetDatabase", dbList: true }] },
  { id: "client", fields: [{ key: "sourceClient", browse: "folder", wide: true }, { key: "targetClient", browse: "folder", wide: true }] },
  { id: "build", fields: [{ key: "cocosVersion" }, { key: "buildPlatform" }, { key: "cocosPath", browse: "editor", wide: true }] },
]);

function update(key, event) {
  updateField(key, event.target.value);
}

function commitDb(key, value) {
  const next = String(value ?? "").trim();
  if (!next) {
    dbDrafts[key] = String(props.platform[key] || "");
    return;
  }
  dbDrafts[key] = next;
  updateField(key, next);
}

function browsePath(field) {
  void browseField(field.key, field.browse);
}
</script>

<template>
  <div class="wb-rf-card wb-rf-platform-editor" role="group" :aria-label="t('releaseFlow.platformEditor.label', { name: platform.name })">
    <div class="wb-rf-platform-editor-top">
      <label class="wb-rf-field">
        {{ t('releaseFlow.platformEditor.name') }}
        <input :value="platform.name" :disabled="busy" data-platform-name @change="update('name', $event)" />
      </label>
      <slot name="actions" :busy="busy" />
    </div>
    <section v-for="group in GROUPS" :key="group.id" class="wb-rf-editor-group">
      <h4>{{ t(`releaseFlow.platformEditor.group.${group.id}`) }}</h4>
      <div class="wb-rf-editor-fields">
        <label v-if="group.id === 'database' && (desktop || mysqlConnections.length)" class="wb-rf-field is-wide">
          {{ t('releaseFlow.platformEditor.connectionId') }}
          <select :value="platform.connectionId || ''" :disabled="busy" data-platform-connection @change="update('connectionId', $event)">
            <option value="">
              {{ autoMatched
                ? t('releaseFlow.platformEditor.autoConnectionMatched', { name: formatPlatformConnectionLabel(autoMatched) })
                : t('releaseFlow.platformEditor.autoConnection') }}
            </option>
            <option v-for="conn in mysqlConnections" :key="conn.id" :value="conn.id">{{ formatPlatformConnectionLabel(conn) }}</option>
          </select>
        </label>
        <div v-for="field in group.fields" :key="field.key" class="wb-rf-field" :class="{ 'is-wide': field.wide }">
          <span>{{ t(`releaseFlow.platformEditor.${field.key}`) }}</span>
          <span v-if="field.browse" class="wb-rf-path-field">
            <input
              :value="platform[field.key]"
              class="wb-rf-code"
              :disabled="busy"
              spellcheck="false"
              :aria-label="t(`releaseFlow.platformEditor.${field.key}`)"
              @change="update(field.key, $event)"
            />
            <button type="button" class="wb-rf-btn" :disabled="busy" @click="browsePath(field)">
              <FolderOpen :size="14" aria-hidden="true" />{{ t('releaseFlow.platformEditor.browse') }}
            </button>
          </span>
          <ReleaseCombobox
            v-else-if="field.dbList"
            v-model="dbDrafts[field.key]"
            :options="databaseOptionsFor(field.key)"
            :label="t(`releaseFlow.platformEditor.${field.key}`)"
            :placeholder="t('releaseFlow.platformEditor.chooseDatabase')"
            :disabled="busy"
            @pick="commitDb(field.key, $event)"
            @focusout="commitDb(field.key, dbDrafts[field.key])"
          />
          <input
            v-else
            :value="platform[field.key]"
            class="wb-rf-code"
            :disabled="busy"
            spellcheck="false"
            :aria-label="t(`releaseFlow.platformEditor.${field.key}`)"
            @change="update(field.key, $event)"
          />
        </div>
        <label v-if="group.id === 'client'" class="wb-rf-field is-wide">
          {{ t('releaseFlow.platformEditor.transferTemplateId') }}
          <select :value="platform.transferTemplateId" :disabled="busy" @change="update('transferTemplateId', $event)">
            <option value="">{{ t('releaseFlow.platformEditor.noTemplate') }}</option>
            <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
          </select>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wb-rf-platform-editor {
  gap: 22px;
}

.wb-rf-platform-editor-top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px 16px;
}

.wb-rf-platform-editor-top > .wb-rf-field {
  flex: 1 1 220px;
  max-width: 280px;
}

.wb-rf-editor-group {
  display: grid;
  gap: 10px;
}

.wb-rf-editor-group h4 {
  margin: 0;
  color: var(--wb-secondary-text);
  font-size: var(--wb-fs-body);
  font-weight: 650;
}

.wb-rf-editor-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.is-wide {
  grid-column: 1 / -1;
}
</style>
