<script setup>
// Where a platform's release goes: its databases, client folders, conversion
// template and Cocos editor. Fields save when they lose focus, so typing never
// resets finished steps keystroke by keystroke.
import { computed } from "vue";
import { t } from "../i18n/index.js";

const props = defineProps({
  flow: { type: Object, required: true },
  platform: { type: Object, required: true },
});

const busy = computed(() => props.flow.busy.value);
const templates = computed(() => props.flow.templates.value);

const GROUPS = Object.freeze([
  { id: "database", fields: [{ key: "sourceDatabase" }, { key: "targetDatabase" }] },
  { id: "client", fields: [{ key: "sourceClient" }, { key: "targetClient" }] },
  { id: "build", fields: [{ key: "cocosVersion" }, { key: "buildPlatform" }, { key: "cocosPath", wide: true }] },
]);

function update(key, event) {
  props.flow.updatePlatform(props.platform.id, { [key]: event.target.value });
}
</script>

<template>
  <div class="wb-rf-card wb-rf-platform-editor" role="group" :aria-label="t('releaseFlow.platformEditor.label', { name: platform.name })">
    <label class="wb-rf-field">
      {{ t('releaseFlow.platformEditor.name') }}
      <input :value="platform.name" :disabled="busy" @change="update('name', $event)" />
    </label>
    <section v-for="group in GROUPS" :key="group.id" class="wb-rf-editor-group">
      <h4>{{ t(`releaseFlow.platformEditor.group.${group.id}`) }}</h4>
      <div class="wb-rf-editor-fields">
        <label v-for="field in group.fields" :key="field.key" class="wb-rf-field" :class="{ 'is-wide': field.wide }">
          {{ t(`releaseFlow.platformEditor.${field.key}`) }}
          <input :value="platform[field.key]" class="wb-rf-code" :disabled="busy" spellcheck="false" @change="update(field.key, $event)" />
        </label>
        <label v-if="group.id === 'client'" class="wb-rf-field">
          {{ t('releaseFlow.platformEditor.transferTemplateId') }}
          <select :value="platform.transferTemplateId" :disabled="busy" @change="update('transferTemplateId', $event)">
            <option value="">{{ t('releaseFlow.platformEditor.noTemplate') }}</option>
            <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
          </select>
        </label>
      </div>
    </section>
    <p class="wb-rf-hint">{{ t('releaseFlow.platformEditor.hint') }}</p>
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
  font-size: 12px;
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
