<script setup>
import { t } from "../i18n/index.js";
import { computed } from "vue";
import AgentArtifactCard from "./AgentArtifactCard.vue";
import { extractEvidenceReferences } from "../utils/agentEvidence.js";
import { renderMarkdown } from "../utils/markdown.js";

const props = defineProps({
  message: { type: Object, required: true },
  tableReferences: { type: Array, default: () => [] },
  copied: { type: Boolean, default: false },
});

const emit = defineEmits(["open-table-reference", "open-reference", "open-artifact", "reveal-artifact", "copy-message", "copy-message-markdown", "regenerate"]);

const INTERNAL_AGENT_TOOL_NAMES = new Set([
  "get_database_profile",
  "refresh_database_profile",
  "search_database_profile",
  "find_related_tables",
]);

const isUser = computed(() => props.message.role === "user");
const isAssistant = computed(() => props.message.role === "assistant");
const renderedContent = computed(() => renderMarkdown(props.message.content || "", {
  tableReferences: isAssistant.value ? props.tableReferences : [],
}).html);
const hasThinking = computed(() => Boolean(props.message.thinking));

const canShowActions = computed(() => isAssistant.value && props.message.done);
const copyText = computed(() => markdownToPlainText(props.message.content || ""));
const copyMarkdown = computed(() => props.message.content || "");
const toolSteps = computed(() => pairedSteps(props.message.toolUses, props.message.toolResults));
const hasTools = computed(() => toolSteps.value.length > 0);
const evidenceReferences = computed(() => extractEvidenceReferences(props.message.toolResults));
const artifacts = computed(() => Array.isArray(props.message.artifacts) ? props.message.artifacts : []);
const contextLabel = computed(() => combineVisibleLabels(props.message.contextLabel, props.message.projectLabel));
const toolSummaryLabel = computed(() => {
  const steps = toolSteps.value;
  if (!steps.length) return "";
  const completed = steps.filter((step) => step.result && !step.result.isError).length;
  const failed = steps.filter((step) => step.result?.isError).length;
  const running = steps.length - completed - failed;
  const parts = [`工具 ${steps.length}`];
  if (completed) parts.push(`完成 ${completed}`);
  if (running) parts.push(`运行中 ${running}`);
  if (failed) parts.push(`失败 ${failed}`);
  return parts.join(" · ");
});

function formatElapsed(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
}

function combineVisibleLabels(...labels) {
  const visible = [];
  for (const label of labels) {
    const parts = String(label || "")
      .split(" · ")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const value of parts) {
      if (visible.includes(value)) continue;
      visible.push(value);
    }
  }
  return visible.join(" · ");
}

function markdownToPlainText(markdown) {
  return String(markdown || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```\w*\n?|\n?```$/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>`]/g, "")
    .replace(/^\s*[-+]\s+/gm, "- ")
    .replace(/^\s*\d+\.\s+/gm, (match) => match.trim() + " ")
    .trim();
}

function onContentClick(event) {
  const button = event.target?.closest?.(".wb-md-table-ref[data-table-name]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  emit("open-table-reference", button.dataset.tableName || "");
}

function openEvidenceReference(reference) {
  if (!reference?.action) return;
  emit("open-reference", reference.action);
}

function evidenceTitle(reference) {
  switch (reference?.action?.action) {
    case "focus_cell":
      return "跳转到单元格";
    case "focus_row":
      return "跳转到行";
    case "focus_column":
      return "跳转到列";
    default:
      return "打开表";
  }
}

function formatToolInput(input) {
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  if (keys.includes("sql") && typeof input.sql === "string") {
    return input.sql;
  }
  return keys.map((key) => `${key}: ${JSON.stringify(input[key])}`).join("\n");
}

function toolDisplayName(name) {
  if (typeof name !== "string") return "工具";
  for (const mcpPrefix of ["mcp__dbscout-db__", "mcp__dbscout-project__", "mcp__dbscout-artifacts__"]) {
    if (name.startsWith(mcpPrefix)) {
      return name.slice(mcpPrefix.length);
    }
  }
  return name;
}

function isInternalAgentTool(name) {
  return INTERNAL_AGENT_TOOL_NAMES.has(toolDisplayName(name));
}

function toolIcon(name) {
  const normalized = toolDisplayName(name);
  if (normalized.includes("read_query") || normalized.includes("query")) return "sql";
  if (normalized.includes("describe") || normalized.includes("schema")) return "schema";
  if (normalized.includes("sample") || normalized.includes("row")) return "rows";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("list")) return "list";
  if (normalized.includes("spreadsheet") || normalized.includes("text_file")) return "file";
  return "tool";
}

function pairedSteps(toolUses, toolResults) {
  const uses = Array.isArray(toolUses) ? toolUses : [];
  const results = Array.isArray(toolResults) ? toolResults : [];
  const resultById = new Map(results.map((r) => [r.id, r]));
  return uses
    .filter((use) => !isInternalAgentTool(use?.name))
    .map((use) => ({
      ...use,
      result: resultById.get(use.id) || null,
    }));
}
</script>

<template>
  <article class="wb-ai-message" :class="[`is-${message.role}`, { 'is-done': message.done }]">
    <div class="wb-ai-message-body">
      <!-- Thinking block -->
      <details v-if="hasThinking" class="wb-ai-thinking">
        <summary>{{ t('m_a62acb184f47') }}</summary>
        <pre class="wb-ai-thinking-content">{{ message.thinking }}</pre>
      </details>

      <!-- Tool steps -->
      <details v-if="hasTools" class="wb-ai-tool-steps" :aria-label="t('m_a8ca3c13eb75')">
        <summary class="wb-ai-tool-summary">{{ toolSummaryLabel }}</summary>
        <div
          v-for="step in toolSteps"
          :key="step.id"
          class="wb-ai-tool-step"
          :class="{ 'is-error': step.result?.isError }"
        >
          <span class="wb-ai-tool-icon" :class="`is-${toolIcon(step.name)}`" aria-hidden="true">
            <svg v-if="toolIcon(step.name) === 'sql'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M7 7h10M7 12h10M7 17h5" />
            </svg>
            <svg v-else-if="toolIcon(step.name) === 'schema'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            <svg v-else-if="toolIcon(step.name) === 'rows'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
            <svg v-else-if="toolIcon(step.name) === 'search'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <svg v-else-if="toolIcon(step.name) === 'list'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <path d="M9 9h6v6H9z" />
            </svg>
          </span>
          <span class="wb-ai-tool-name">{{ toolDisplayName(step.name) }}</span>
          <span
            class="wb-ai-tool-status"
            :class="{ 'is-error': step.result?.isError, 'is-ok': step.result && !step.result.isError, 'is-running': !step.result }"
          >
            {{ step.result ? (step.result.isError ? t('m_28384d7afd2e') : t('m_c0b3fbff51cc')) : t('m_14d9f2d830ad') }}
          </span>
          <code v-if="formatToolInput(step.input)" class="wb-ai-tool-input">{{ formatToolInput(step.input) }}</code>
          <span v-if="step.result?.summary" class="wb-ai-tool-result">
            {{ step.result.summary }}
          </span>
        </div>
      </details>

      <div v-if="evidenceReferences.length" class="wb-ai-evidence-list" :aria-label="t('m_9e75bf0096fe')">
        <button
          v-for="reference in evidenceReferences"
          :key="reference.key"
          type="button"
          class="wb-ai-evidence-chip"
          :title="evidenceTitle(reference)"
          @click="openEvidenceReference(reference)"
        >
          {{ reference.label }}
        </button>
      </div>

      <div v-if="artifacts.length" class="wb-ai-artifact-list" :aria-label="t('m_b43e80fa2708')">
        <AgentArtifactCard
          v-for="artifact in artifacts"
          :key="artifact.path"
          :artifact="artifact"
          @open="emit('open-artifact', artifact)"
          @reveal="emit('reveal-artifact', artifact)"
        />
      </div>

      <!-- Main content -->
      <div
        v-if="message.content"
        class="wb-ai-message-content wb-md"
        v-html="renderedContent"
        @click="onContentClick"
      ></div>

      <p v-if="contextLabel" class="wb-ai-context-label">{{ contextLabel }}</p>

      <footer v-if="canShowActions" class="wb-ai-message-actions">
        <span v-if="formatElapsed(message.elapsedMs)" class="wb-ai-message-elapsed">{{ t('m_e77e3d58b0dc') }} {{ formatElapsed(message.elapsedMs) }}</span>
        <button type="button" class="wb-ai-message-action" @click="emit('copy-message', { message, text: copyText })">{{ copied ? t('m_8f6f8d979c98') : t('m_63d90d977348') }}</button>
        <button type="button" class="wb-ai-message-action" @click="emit('copy-message-markdown', { message, text: copyMarkdown })">{{ t('m_f9c71ee4c435') }}</button>
        <button type="button" class="wb-ai-message-action" @click="emit('regenerate', message)">{{ t('m_3221a042ea36') }}</button>
      </footer>
    </div>
  </article>
</template>
