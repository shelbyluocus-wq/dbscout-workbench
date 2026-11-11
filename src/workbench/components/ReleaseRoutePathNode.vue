<script setup>
// Editable path card inside a release workflow step (sourceClient / targetClient).
// Commits on blur/Enter or native folder picker so typing never resets steps mid-keystroke.
import { computed } from "vue";
import { FolderOpen } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { usePlatformFieldMeta } from "../utils/releasePlatformFields.js";

const props = defineProps({
  workspace: { type: Object, default: null },
  platform: { type: Object, required: true },
  fieldKey: { type: String, required: true },
  label: { type: String, required: true },
  target: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  browseKind: { type: String, default: "folder" },
  hint: { type: String, default: "" },
});

const workspaceRef = computed(() => props.workspace);
const platformRef = computed(() => props.platform);
const { updateField, browseField } = usePlatformFieldMeta(workspaceRef, platformRef);

function commit(event) {
  updateField(props.fieldKey, event.target.value);
}

function browse() {
  void browseField(props.fieldKey, props.browseKind);
}
</script>

<template>
  <div class="wb-rf-route-node" :class="{ 'is-target': target, 'is-editable': Boolean(workspace) }">
    <span>
      <slot name="icon" />
      {{ label }}
    </span>
    <div v-if="workspace" class="wb-rf-path-field">
      <input
        :value="platform[fieldKey]"
        class="wb-rf-input wb-rf-code"
        :disabled="disabled"
        spellcheck="false"
        :aria-label="label"
        :data-release-field="fieldKey"
        @change="commit"
      />
      <button
        type="button"
        class="wb-rf-btn is-small"
        :disabled="disabled"
        :data-release-browse="fieldKey"
        @click="browse"
      >
        <FolderOpen :size="13" aria-hidden="true" />{{ t('releaseFlow.platformEditor.browse') }}
      </button>
    </div>
    <strong v-else class="wb-rf-code">{{ platform[fieldKey] }}</strong>
    <p v-if="hint" class="wb-rf-route-hint wb-rf-code">{{ hint }}</p>
  </div>
</template>
