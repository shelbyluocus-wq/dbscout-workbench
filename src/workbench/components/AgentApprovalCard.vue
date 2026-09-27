<script setup>
import { t } from "../i18n/index.js";
import { computed } from "vue";

const props = defineProps({
  approval: { type: Object, required: true },
});

const emit = defineEmits(["approve", "deny"]);

const toolName = computed(() => String(props.approval.toolName || "工具"));
const input = computed(() => props.approval.input || {});

const title = computed(() => {
  const normalized = toolName.value;
  if (normalized.includes("run_write_query")) return "写入数据库";
  if (normalized.includes("create_spreadsheet")) return "生成 Excel 文件";
  if (normalized.includes("create_text_file")) return "生成本地文件";
  if (normalized.includes("Write")) return "写入文件";
  if (normalized.includes("Edit")) return "编辑文件";
  if (normalized.includes("Bash")) return "执行命令";
  return "工具执行请求";
});

const summary = computed(() => {
  const value = input.value;
  if (!value || typeof value !== "object") return "";
  if (toolName.value.includes("create_spreadsheet")) {
    const sheets = Array.isArray(value.sheets) ? value.sheets : [];
    const rows = sheets.reduce((sum, sheet) => sum + (Array.isArray(sheet?.rows) ? sheet.rows.length : 0), 0);
    return `${value.fileName || "未命名.xlsx"}\n${sheets.length} 个工作表 · ${rows} 行`;
  }
  if (toolName.value.includes("create_text_file")) {
    return `${value.fileName || "未命名文件"}\n${String(value.format || "txt").toUpperCase()}`;
  }
  if (typeof value.sql === "string") return value.sql;
  if (typeof value.command === "string") return value.command;
  if (typeof value.path === "string") return value.path;
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
});

const hasDetails = computed(() => Object.keys(input.value).length > 0);

function approve() {
  emit("approve", props.approval.reqId);
}

function deny() {
  emit("deny", props.approval.reqId, "用户拒绝");
}
</script>

<template>
  <article class="wb-ai-approval-card" aria-live="polite">
    <header class="wb-ai-approval-header">
      <span class="wb-ai-approval-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </span>
      <strong>{{ title }}</strong>
    </header>

    <div v-if="hasDetails" class="wb-ai-approval-body">
      <div class="wb-ai-approval-meta">
        <span class="wb-ai-approval-tool">{{ toolName }}</span>
      </div>
      <pre class="wb-ai-approval-detail">{{ summary }}</pre>
    </div>

    <div class="wb-ai-approval-actions">
      <button type="button" class="wb-ai-btn wb-ai-btn-secondary" @click="deny"> {{ t('m_136de7a8c46f') }} </button>
      <button type="button" class="wb-ai-btn wb-ai-btn-primary" @click="approve"> {{ t('m_8cbe697b1573') }} </button>
    </div>
  </article>
</template>
