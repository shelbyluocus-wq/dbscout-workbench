<script setup>
import { computed } from "vue";
import { ExternalLink, FileJson, FileSpreadsheet, FileText, FolderOpen } from "lucide-vue-next";

const props = defineProps({
  artifact: { type: Object, required: true },
});

const emit = defineEmits(["open", "reveal"]);

const format = computed(() => String(props.artifact.format || "file").toLowerCase());
const isSpreadsheet = computed(() => format.value === "xlsx");
const isJson = computed(() => format.value === "json");
const icon = computed(() => {
  if (isSpreadsheet.value) return FileSpreadsheet;
  if (isJson.value) return FileJson;
  return FileText;
});

const detail = computed(() => {
  const parts = [format.value.toUpperCase()];
  if (isSpreadsheet.value) {
    const sheets = Number(props.artifact.sheetCount || 0);
    const rows = Number(props.artifact.rowCount || 0);
    if (sheets) parts.push(`${sheets} 个工作表`);
    if (rows) parts.push(`${rows} 行`);
  }
  const size = formatBytes(props.artifact.sizeBytes);
  if (size) parts.push(size);
  return parts.join(" · ");
});

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <article class="wb-ai-artifact" :title="artifact.path">
    <span class="wb-ai-artifact-icon" aria-hidden="true">
      <component :is="icon" :size="18" />
    </span>
    <span class="wb-ai-artifact-info">
      <strong>{{ artifact.fileName }}</strong>
      <small>{{ detail }}</small>
      <span>{{ artifact.path }}</span>
    </span>
    <span class="wb-ai-artifact-actions">
      <button type="button" title="打开文件" @click="emit('open', artifact)">
        <ExternalLink :size="14" />
        <span>打开</span>
      </button>
      <button type="button" class="is-icon-only" title="打开所在文件夹" aria-label="打开所在文件夹" @click="emit('reveal', artifact)">
        <FolderOpen :size="15" />
      </button>
    </span>
  </article>
</template>
