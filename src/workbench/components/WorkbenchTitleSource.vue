<script setup>
// The title bar names the database of the tab on screen: tabs show only
// table names, so this is where the source of the current page is read.
// Clicking it opens that database's home, unless the home is already shown.
import { computed } from "vue";
import { t } from "../i18n/index.js";
import { useAliases } from "../composables/aliasStore.js";
import { databaseTextColorCss, useDatabaseDecorations } from "../composables/databaseDecorationStore.js";
import { databaseDecorationIconComponent } from "./databaseDecorationIcons.js";

const props = defineProps({
  tab: { type: Object, default: null },
  connections: { type: Array, default: () => [] },
});
const emit = defineEmits(["open-home"]);
const { databaseLabel, connectionLabel } = useAliases();
const { getDatabaseDecoration } = useDatabaseDecorations();

const source = computed(() => {
  const connectionId = String(props.tab?.connectionId || "");
  const database = String(props.tab?.database || "").trim();
  if (!connectionId || !database) return null;
  const connection = props.connections.find((item) => String(item.id) === connectionId);
  const decoration = getDatabaseDecoration(connectionId, database);
  const textColor = databaseTextColorCss(decoration?.textColor);
  return {
    connectionId,
    database,
    label: databaseLabel(connectionId, database) || database,
    service: connectionLabel(connectionId, connection?.label || connectionId),
    icon: decoration ? databaseDecorationIconComponent(decoration.icon) : null,
    style: {
      ...(decoration?.color ? { "--wb-title-source-icon-color": decoration.color } : {}),
      ...(textColor ? { "--wb-title-source-name-color": textColor } : {}),
    },
  };
});
const atHome = computed(() => props.tab?.kind === "home");

function openHome() {
  if (source.value && !atHome.value) emit("open-home", { connectionId: source.value.connectionId, database: source.value.database });
}
</script>

<template>
  <component
    :is="atHome ? 'span' : 'button'"
    v-if="source"
    class="wb-title-source"
    :class="{ 'is-home': atHome }"
    :type="atHome ? undefined : 'button'"
    :style="source.style"
    :title="atHome ? `${source.service} · ${source.label}` : t('titleSource.openHome', { name: source.label })"
    :data-tauri-drag-region="atHome ? '' : undefined"
    @click="openHome"
  >
    <component :is="source.icon" v-if="source.icon" class="wb-title-source-icon is-decorated" :size="14" :stroke-width="1.7" aria-hidden="true" />
    <svg v-else class="wb-title-source-icon" width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">
      <ellipse cx="6" cy="2.7" rx="4.1" ry="1.9" />
      <path d="M1.9 2.7v6.6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9V2.7" />
      <path d="M1.9 6c0 1.05 1.83 1.9 4.1 1.9s4.1-.85 4.1-1.9" />
    </svg>
    <strong class="wb-title-source-name">{{ source.label }}</strong>
    <span class="wb-title-source-service">{{ source.service }}</span>
  </component>
</template>
