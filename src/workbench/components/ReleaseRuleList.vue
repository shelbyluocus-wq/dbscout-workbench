<script setup>
// Exclusion rules as rows: what each keeps out (a file, a folder with
// everything under it, or a pattern), editable in place and removable. The
// always-excluded version-control folders come first and cannot change.
import { nextTick, ref } from "vue";
import { Asterisk, Check, File, Folder, Lock, Pencil, X } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { exclusionRuleKind } from "../utils/releaseFileRules.js";

const props = defineProps({
  rules: { type: Array, required: true },
  locked: { type: Array, default: () => [] },
  label: { type: String, default: "" },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(["update"]);
const ICONS = Object.freeze({ file: File, folder: Folder, pattern: Asterisk });
const editing = ref("");
const draft = ref("");
const listRef = ref(null);

function startEdit(rule) {
  editing.value = rule;
  draft.value = rule;
  void nextTick(() => listRef.value?.querySelector("input")?.select());
}

function commit() {
  const value = draft.value.trim();
  const rule = editing.value;
  editing.value = "";
  if (!value || value === rule) return;
  emit("update", props.rules.map((entry) => (entry === rule ? value : entry)));
}

function onKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    commit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    editing.value = "";
  }
}

function remove(rule) {
  emit("update", props.rules.filter((entry) => entry !== rule));
}
</script>

<template>
  <ul ref="listRef" class="wb-rf-list wb-rf-rules" :aria-label="label || undefined">
    <li v-for="rule in locked" :key="`locked:${rule}`" class="wb-rf-rule is-locked" :title="t('releaseFlow.files.locked')">
      <Lock :size="13" class="wb-rf-rule-icon" aria-hidden="true" />
      <span class="wb-rf-code wb-rf-rule-text">{{ rule }}</span>
      <span class="wb-rf-rule-kind">{{ t('releaseFlow.files.kind.always') }}</span>
    </li>
    <li v-for="rule in rules" :key="rule" class="wb-rf-rule" :data-rule="rule">
      <component :is="ICONS[exclusionRuleKind(rule)]" :size="13" class="wb-rf-rule-icon" aria-hidden="true" />
      <input
        v-if="editing === rule"
        v-model="draft"
        class="wb-rf-input wb-rf-code wb-rf-rule-input"
        spellcheck="false"
        :aria-label="t('releaseFlow.files.editRule', { rule })"
        @keydown="onKeydown"
        @blur="commit"
      />
      <span v-else class="wb-rf-code wb-rf-rule-text" :title="rule">{{ rule }}</span>
      <span class="wb-rf-rule-kind">{{ t(`releaseFlow.files.kind.${exclusionRuleKind(rule)}`) }}</span>
      <button
        v-if="editing === rule"
        type="button"
        class="wb-rf-icon-btn"
        :aria-label="t('releaseFlow.files.saveRule')"
        @mousedown.prevent
        @click="commit"
      >
        <Check :size="13" aria-hidden="true" />
      </button>
      <button v-else type="button" class="wb-rf-icon-btn" :disabled="disabled" :aria-label="t('releaseFlow.files.editRule', { rule })" @click="startEdit(rule)">
        <Pencil :size="13" aria-hidden="true" />
      </button>
      <button type="button" class="wb-rf-icon-btn" :disabled="disabled" :aria-label="t('releaseFlow.files.removeRule', { rule })" @click="remove(rule)">
        <X :size="13" aria-hidden="true" />
      </button>
    </li>
  </ul>
</template>
