<script setup>
import { computed, nextTick, ref } from "vue";
import { Pencil, RefreshCw, Trash2 } from "lucide-vue-next";
import { useConfirm } from "../composables/useConfirm.js";

const props = defineProps({
  sync: {
    type: Object,
    required: true,
  },
  busy: {
    type: Boolean,
    default: false,
  },
});

const { confirm } = useConfirm();

const templateName = ref("");
const feedback = ref("");
const feedbackIsError = ref(false);
const renamingId = ref("");
const renameValue = ref("");
const renameInput = ref(null);
let feedbackTimer = null;

const templates = computed(() => props.sync.exclusionTemplates.value);
const enabledIds = computed(() => props.sync.enabledTemplateIds.value);
const effectiveCount = computed(() => props.sync.effectiveExcludedTables.value.length);
const canSave = computed(() => !props.busy && Boolean(templateName.value.trim()) && effectiveCount.value > 0);
const saveButtonTitle = computed(() => {
  if (!effectiveCount.value) return "请先在左侧勾选要排除的表";
  return "把当前已排除的表保存为全局模板，所有连接共用";
});

function isEnabled(id) {
  return enabledIds.value.includes(id);
}

function showFeedback(message, isError = false) {
  feedback.value = message;
  feedbackIsError.value = isError;
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    feedback.value = "";
    feedbackTimer = null;
  }, 2600);
}

function saveTemplate() {
  const result = props.sync.saveExclusionTemplate(templateName.value);
  if (result.status === "created") {
    showFeedback(`已保存模板“${result.template.name}”（${result.template.tables.length} 张表）`);
    templateName.value = "";
    return;
  }
  if (result.status === "updated") {
    showFeedback(`已更新同名模板“${result.template.name}”`);
    templateName.value = "";
    return;
  }
  if (result.status === "empty") {
    showFeedback("请先在左侧勾选要排除的表", true);
    return;
  }
  showFeedback("请输入模板名称", true);
}

async function startRename(template) {
  renamingId.value = template.id;
  renameValue.value = template.name;
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

function cancelRename() {
  renamingId.value = "";
  renameValue.value = "";
}

function commitRename() {
  if (!renamingId.value) return;
  const id = renamingId.value;
  const result = props.sync.renameExclusionTemplate(id, renameValue.value);
  if (result.status === "duplicate") {
    showFeedback("已存在同名模板，请换一个名称", true);
    renameInput.value?.focus();
    return;
  }
  if (result.status === "invalid") {
    showFeedback("模板名称不能为空", true);
    renameInput.value?.focus();
    return;
  }
  cancelRename();
}

function toggleTemplate(id, event) {
  props.sync.setExclusionTemplateEnabled(id, event.target.checked);
}

function updateTemplate(template) {
  const result = props.sync.updateExclusionTemplateTables(template.id);
  if (result.status === "updated") {
    showFeedback(`模板“${template.name}”已更新为当前排除列表（${result.count} 张表）`);
    return;
  }
  showFeedback("请先在左侧勾选要排除的表", true);
}

async function removeTemplate(template) {
  const confirmed = await confirm({
    title: "删除排除模板",
    message: `确定删除模板“${template.name}”？`,
    note: "删除后该模板内的表不再自动排除，已手动添加的排除不受影响。",
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  props.sync.deleteExclusionTemplate(template.id);
  showFeedback(`已删除模板“${template.name}”`);
}
</script>

<template>
  <section class="wb-sync-templates" aria-label="排除模板">
    <header class="wb-sync-templates-head">
      <div class="wb-database-sync-section-title">
        <strong>排除模板</strong>
        <span v-if="templates.length">{{ templates.length }}</span>
      </div>
      <span class="wb-sync-templates-tip">全局共用</span>
    </header>

    <ul v-if="templates.length" class="wb-sync-templates-list">
      <li
        v-for="template in templates"
        :key="template.id"
        class="wb-sync-template-row"
        :class="{ 'is-enabled': isEnabled(template.id) }"
      >
        <input
          v-if="renamingId === template.id"
          ref="renameInput"
          v-model="renameValue"
          class="wb-sync-template-rename"
          type="text"
          maxlength="40"
          aria-label="重命名模板"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename"
        />
        <template v-else>
          <label class="wb-sync-template-toggle" :title="template.tables.join('、') || '空模板'">
            <input
              type="checkbox"
              :checked="isEnabled(template.id)"
              :disabled="busy"
              :aria-label="`启用模板 ${template.name}`"
              @change="toggleTemplate(template.id, $event)"
            />
            <span class="wb-sync-template-name">{{ template.name }}</span>
            <span class="wb-sync-template-count">{{ template.tables.length }} 表</span>
          </label>
          <span class="wb-sync-template-actions">
            <button
              type="button"
              title="用当前排除列表更新该模板"
              :disabled="busy || !effectiveCount"
              @click="updateTemplate(template)"
            >
              <RefreshCw :size="12" />
            </button>
            <button type="button" title="重命名" :disabled="busy" @click="startRename(template)">
              <Pencil :size="12" />
            </button>
            <button type="button" class="is-danger" title="删除模板" :disabled="busy" @click="removeTemplate(template)">
              <Trash2 :size="12" />
            </button>
          </span>
        </template>
      </li>
    </ul>
    <p v-else class="wb-sync-templates-empty">还没有模板；把当前排除保存下来，任何连接都能一键启用。</p>

    <form class="wb-sync-template-save" @submit.prevent="saveTemplate">
      <input
        v-model="templateName"
        type="text"
        placeholder="新模板名称…"
        aria-label="新模板名称"
        maxlength="40"
        :disabled="busy"
      />
      <button type="submit" :disabled="!canSave" :title="saveButtonTitle">存为模板</button>
    </form>
    <p v-if="feedback" class="wb-sync-template-feedback" :class="{ 'is-error': feedbackIsError }">{{ feedback }}</p>
  </section>
</template>
