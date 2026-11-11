<script setup>
// Where a platform's update goes: its databases, client folders, conversion
// template and Cocos editor. Fields save when they lose focus, so typing never
// resets finished steps keystroke by keystroke. The build options themselves
// are set on the client build page.
import { computed } from "vue";
import { FolderOpen } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { isSyncCapableConnection, resolvePlatformConnection } from "../composables/useReleaseRealDriver.js";
import { invokeWorkbench, isTauriRuntime } from "../utils/tauriBridge.js";

const props = defineProps({
  workspace: { type: Object, required: true },
  platform: { type: Object, required: true },
});

const desktop = isTauriRuntime();
const busy = computed(() => Boolean(props.workspace.flowOfPlatform(props.platform.id)?.busy.value));
const templates = computed(() => props.workspace.templates.value);
const allConnections = computed(() => props.workspace.connections?.value || []);
const mysqlConnections = computed(() => allConnections.value.filter(isSyncCapableConnection));
const autoMatched = computed(() => resolvePlatformConnection(
  { ...props.platform, connectionId: "" },
  allConnections.value,
  props.workspace.databasesByConnection?.value,
));
const activeConnection = computed(() => resolvePlatformConnection(
  props.platform,
  allConnections.value,
  props.workspace.databasesByConnection?.value,
));
const databaseOptions = computed(() => {
  const id = activeConnection.value?.id;
  const list = id ? props.workspace.databasesByConnection?.value?.[id] : null;
  return Array.isArray(list) ? list : [];
});
const dbListId = computed(() => `wb-rf-db-list-${props.platform.id}`);

const GROUPS = Object.freeze([
  { id: "database", fields: [{ key: "sourceDatabase", dbList: true }, { key: "targetDatabase", dbList: true }] },
  { id: "client", fields: [{ key: "sourceClient", browse: "folder", wide: true }, { key: "targetClient", browse: "folder", wide: true }] },
  { id: "build", fields: [{ key: "cocosVersion" }, { key: "buildPlatform" }, { key: "cocosPath", browse: "editor", wide: true }] },
]);

function update(key, event) {
  props.workspace.updatePlatform(props.platform.id, { [key]: event.target.value });
}

function connectionLabel(conn) {
  if (!conn) return "";
  const name = conn.name || conn.host || conn.id;
  const addr = conn.host ? `${conn.host}${conn.port ? `:${conn.port}` : ""}` : "";
  return addr && name !== addr ? `${name} (${addr})` : name;
}

async function browsePath(field) {
  const start = String(props.platform[field.key] || "").trim();
  const cmd = field.browse === "editor" ? "cocos_pick_executable" : "svn_wc_pick_folder";
  const picked = await invokeWorkbench(cmd, { start }).catch(() => null);
  if (picked) props.workspace.updatePlatform(props.platform.id, { [field.key]: picked });
}
</script>

<template>
  <div class="wb-rf-card wb-rf-platform-editor" role="group" :aria-label="t('releaseFlow.platformEditor.label', { name: platform.name })">
    <label class="wb-rf-field">
      {{ t('releaseFlow.platformEditor.name') }}
      <input :value="platform.name" :disabled="busy" @change="update('name', $event)" />
    </label>
    <datalist v-if="databaseOptions.length" :id="dbListId">
      <option v-for="db in databaseOptions" :key="db" :value="db" />
    </datalist>
    <section v-for="group in GROUPS" :key="group.id" class="wb-rf-editor-group">
      <h4>{{ t(`releaseFlow.platformEditor.group.${group.id}`) }}</h4>
      <div class="wb-rf-editor-fields">
        <label v-if="group.id === 'database' && (desktop || mysqlConnections.length)" class="wb-rf-field is-wide">
          {{ t('releaseFlow.platformEditor.connectionId') }}
          <select :value="platform.connectionId || ''" :disabled="busy" data-platform-connection @change="update('connectionId', $event)">
            <option value="">
              {{ autoMatched
                ? t('releaseFlow.platformEditor.autoConnectionMatched', { name: connectionLabel(autoMatched) })
                : t('releaseFlow.platformEditor.autoConnection') }}
            </option>
            <option v-for="conn in mysqlConnections" :key="conn.id" :value="conn.id">{{ connectionLabel(conn) }}</option>
          </select>
        </label>
        <label v-for="field in group.fields" :key="field.key" class="wb-rf-field" :class="{ 'is-wide': field.wide }">
          {{ t(`releaseFlow.platformEditor.${field.key}`) }}
          <span v-if="desktop && field.browse" class="wb-rf-path-field">
            <input
              :value="platform[field.key]"
              class="wb-rf-code"
              :disabled="busy"
              spellcheck="false"
              @change="update(field.key, $event)"
            />
            <button type="button" class="wb-rf-btn" :disabled="busy" @click="browsePath(field)">
              <FolderOpen :size="14" aria-hidden="true" />{{ t('releaseFlow.platformEditor.browse') }}
            </button>
          </span>
          <input
            v-else
            :value="platform[field.key]"
            :list="field.dbList && databaseOptions.length ? dbListId : undefined"
            class="wb-rf-code"
            :disabled="busy"
            spellcheck="false"
            @change="update(field.key, $event)"
          />
        </label>
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

.wb-rf-platform-editor > .wb-rf-field {
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
