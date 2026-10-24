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

const FIELDS = Object.freeze([
  { key: "name", group: "general" },
  { key: "sourceDatabase", group: "database", mono: true },
  { key: "targetDatabase", group: "database", mono: true },
  { key: "sourceClient", group: "client", mono: true },
  { key: "targetClient", group: "client", mono: true },
  { key: "cocosVersion", group: "build", mono: true },
  { key: "cocosPath", group: "build", mono: true, wide: true },
  { key: "buildPlatform", group: "build", mono: true },
  { key: "buildConfig", group: "build", mono: true },
]);

function update(key, event) {
  props.flow.updatePlatform(props.platform.id, { [key]: event.target.value });
}
</script>

<template>
  <div class="wb-rf-platform-editor" role="group" :aria-label="t('releaseFlow.platformEditor.label', { name: platform.name })">
    <label
      v-for="field in FIELDS"
      :key="field.key"
      class="wb-rf-field"
      :class="{ 'is-wide': field.wide }"
    >
      {{ t(`releaseFlow.platformEditor.${field.key}`) }}
      <input
        :value="platform[field.key]"
        :class="{ 'wb-rf-code': field.mono }"
        :disabled="busy"
        spellcheck="false"
        @change="update(field.key, $event)"
      />
    </label>
    <label class="wb-rf-field">
      {{ t('releaseFlow.platformEditor.transferTemplateId') }}
      <select :value="platform.transferTemplateId" :disabled="busy" @change="update('transferTemplateId', $event)">
        <option value="">{{ t('releaseFlow.platformEditor.noTemplate') }}</option>
        <option v-for="template in templates" :key="template.id" :value="template.id">{{ template.name }}</option>
      </select>
    </label>
    <p class="wb-rf-hint is-wide">{{ t('releaseFlow.platformEditor.hint') }}</p>
  </div>
</template>

<style scoped>
.wb-rf-platform-editor {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px 14px;
  padding: 14px;
  border-radius: 8px;
  background: var(--wb-field-surface);
}

.is-wide {
  grid-column: span 2;
}

.wb-rf-hint.is-wide {
  grid-column: 1 / -1;
}
</style>
