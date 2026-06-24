<script setup>
import { computed } from "vue";
import { renderMarkdown } from "../utils/markdown.js";

const props = defineProps({
  message: { type: Object, required: true },
  tableReferences: { type: Array, default: () => [] },
});

const emit = defineEmits(["open-table-reference"]);

const isUser = computed(() => props.message.role === "user");
const isAssistant = computed(() => props.message.role === "assistant");
const renderedContent = computed(() => renderMarkdown(props.message.content || "", {
  tableReferences: isAssistant.value ? props.tableReferences : [],
}).html);
const hasThinking = computed(() => Boolean(props.message.thinking));
const hasTools = computed(() => Boolean(props.message.toolUses?.length || props.message.toolResults?.length));

function onContentClick(event) {
  const button = event.target?.closest?.(".wb-md-table-ref[data-table-name]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  emit("open-table-reference", button.dataset.tableName || "");
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
  const mcpPrefix = "mcp__dbscout-db__";
  if (name.startsWith(mcpPrefix)) {
    return name.slice(mcpPrefix.length);
  }
  return name;
}

function toolIcon(name) {
  const normalized = toolDisplayName(name);
  if (normalized.includes("read_query") || normalized.includes("query")) return "sql";
  if (normalized.includes("describe") || normalized.includes("schema")) return "schema";
  if (normalized.includes("sample") || normalized.includes("row")) return "rows";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("list")) return "list";
  return "tool";
}

function pairedSteps(toolUses, toolResults) {
  const uses = Array.isArray(toolUses) ? toolUses : [];
  const results = Array.isArray(toolResults) ? toolResults : [];
  const resultById = new Map(results.map((r) => [r.id, r]));
  return uses.map((use) => ({
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
        <summary>思考过程</summary>
        <pre class="wb-ai-thinking-content">{{ message.thinking }}</pre>
      </details>

      <!-- Tool steps -->
      <div v-if="hasTools" class="wb-ai-tool-steps" aria-label="工具调用">
        <div
          v-for="step in pairedSteps(message.toolUses, message.toolResults)"
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
            {{ step.result ? (step.result.isError ? "失败" : "完成") : "运行中…" }}
          </span>
          <code v-if="formatToolInput(step.input)" class="wb-ai-tool-input">{{ formatToolInput(step.input) }}</code>
          <span v-if="step.result?.summary" class="wb-ai-tool-result">
            {{ step.result.summary }}
          </span>
        </div>
      </div>

      <!-- Main content -->
      <div
        v-if="message.content"
        class="wb-ai-message-content wb-md"
        v-html="renderedContent"
        @click="onContentClick"
      ></div>
    </div>
  </article>
</template>
