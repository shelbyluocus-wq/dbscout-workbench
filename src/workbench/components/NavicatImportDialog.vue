<script setup>
import { computed, ref, watch } from "vue";
import { Database, FileUp, LoaderCircle, RefreshCw } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { useEscClose } from "../composables/useEscClose.js";
import { invokeWorkbench } from "../utils/tauriBridge.js";
import { annotateNavicatCandidates, isNavicatNcxFileName } from "../utils/navicatImport.js";

const props = defineProps({
  open: { type: Boolean, default: false },
  existingConnections: { type: Array, default: () => [] },
  savedConnections: { type: Array, default: () => [] },
  initialNcxPayload: { type: Object, default: null },
  invoke: { type: Function, default: invokeWorkbench },
});

const emit = defineEmits(["close", "import"]);

const dialogRef = ref(null);
const scanning = ref(false);
const importing = ref(false);
const draggingNcx = ref(false);
const errorMessage = ref("");
const sourceKind = ref("registry");
const sourceSupported = ref(true);
const skippedUnsupported = ref(0);
const rawCandidates = ref([]);
const selectedIds = ref(new Set());
const activeFilter = ref("all");

useEscClose(() => props.open, () => emit("close"), () => scanning.value || importing.value, { dialogRef });

const annotatedCandidates = computed(() =>
  annotateNavicatCandidates(rawCandidates.value, props.existingConnections, props.savedConnections),
);

const mysqlCount = computed(() => annotatedCandidates.value.filter((item) => item.kind === "mysql").length);
const mongoCount = computed(() => annotatedCandidates.value.filter((item) => item.kind === "mongodb").length);

const filteredCandidates = computed(() => {
  if (activeFilter.value === "all") return annotatedCandidates.value;
  return annotatedCandidates.value.filter((item) => item.kind === activeFilter.value);
});

const selectedItems = computed(() =>
  annotatedCandidates.value.filter((item) => selectedIds.value.has(item.id)),
);

const selectedCount = computed(() => selectedItems.value.length);
const hasNewCandidates = computed(() => annotatedCandidates.value.some((item) => !item.alreadyExists && !item.duplicateInBatch));
const hasSelectedWithoutPassword = computed(() =>
  selectedItems.value.some((item) => item.passwordStatus === "missing" || item.passwordStatus === "unreadable"),
);

function applyScanResult(result) {
  sourceSupported.value = Boolean(result?.supported ?? true);
  sourceKind.value = String(result?.source || "registry");
  skippedUnsupported.value = Number(result?.skippedUnsupported || 0);
  rawCandidates.value = Array.isArray(result?.connections) ? result.connections : [];
  activeFilter.value = "all";
  const annotated = annotateNavicatCandidates(rawCandidates.value, props.existingConnections, props.savedConnections);
  selectedIds.value = new Set(annotated.filter((item) => item.defaultSelected).map((item) => item.id));
}

async function scanLocalNavicat() {
  scanning.value = true;
  errorMessage.value = "";
  try {
    const result = await props.invoke("scan_navicat_connections");
    applyScanResult(result);
  } catch (error) {
    rawCandidates.value = [];
    selectedIds.value = new Set();
    errorMessage.value = t("navicatImport.scanFailed", { error: String(error?.message || error || "") });
  } finally {
    scanning.value = false;
  }
}

async function importFromNcxPayload(payload = {}) {
  scanning.value = true;
  errorMessage.value = "";
  try {
    const result = await props.invoke("import_navicat_ncx_file", payload);
    if (!result) return;
    applyScanResult(result);
  } catch (error) {
    errorMessage.value = t("navicatImport.scanFailed", { error: String(error?.message || error || "") });
  } finally {
    scanning.value = false;
  }
}

function pickNcxFile() {
  if (scanning.value || importing.value) return;
  void importFromNcxPayload({});
}

watch(
  () => [props.open, props.initialNcxPayload],
  ([isOpen, ncxPayload]) => {
    if (!isOpen) return;
    errorMessage.value = "";
    if (ncxPayload?.content) {
      void importFromNcxPayload({ content: ncxPayload.content });
    } else {
      void scanLocalNavicat();
    }
  },
  { immediate: true },
);

function toggleItem(id) {
  if (importing.value) return;
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

function selectAllVisible() {
  const next = new Set(selectedIds.value);
  for (const item of filteredCandidates.value) next.add(item.id);
  selectedIds.value = next;
}

function selectNewOnly() {
  selectedIds.value = new Set(
    annotatedCandidates.value.filter((item) => item.defaultSelected).map((item) => item.id),
  );
}

function clearSelection() {
  selectedIds.value = new Set();
}

function setDropEffect(event) {
  if (event?.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onDragEnter(event) {
  setDropEffect(event);
  draggingNcx.value = true;
}

function onDragOver(event) {
  setDropEffect(event);
  draggingNcx.value = true;
}

function onDragLeave(event) {
  if (event.currentTarget?.contains(event.relatedTarget)) return;
  draggingNcx.value = false;
}

async function onDrop(event) {
  draggingNcx.value = false;
  if (scanning.value || importing.value) return;
  const file = Array.from(event.dataTransfer?.files || [])[0];
  if (!file) return;
  if (!isNavicatNcxFileName(file.name)) {
    errorMessage.value = t("navicatImport.ncxOnlyError");
    return;
  }
  const content = await file.text();
  await importFromNcxPayload({ content });
}

function submitImport() {
  if (importing.value || scanning.value || selectedCount.value === 0) return;
  importing.value = true;
  try {
    emit("import", selectedItems.value.map((item) => ({ ...item })));
  } finally {
    importing.value = false;
  }
}

function kindLabel(item) {
  if (item.kind === "mongodb") return "Mongo";
  return item.sourceLabel === "MariaDB" ? "MariaDB" : "MySQL";
}
</script>

<template>
  <div v-if="open" class="wb-dialog-overlay">
    <section
      ref="dialogRef"
      class="wb-dialog wb-navicat-import-dialog"
      :class="{ 'is-config-dragging': draggingNcx }"
      role="dialog"
      aria-modal="true"
      :aria-label="t('navicatImport.title')"
      tabindex="-1"
      @dragenter.prevent.stop="onDragEnter"
      @dragover.prevent.stop="onDragOver"
      @dragleave.prevent.stop="onDragLeave"
      @drop.prevent.stop="onDrop"
    >
      <header class="wb-dialog-header wb-navicat-header">
        <div class="wb-navicat-heading">
          <strong>{{ t('navicatImport.title') }}</strong>
          <p class="wb-navicat-subtitle">{{ t('navicatImport.subtitle') }}</p>
        </div>
        <button
          type="button"
          class="wb-dialog-close"
          :disabled="importing"
          @click="emit('close')"
        >×</button>
      </header>

      <div v-if="draggingNcx" class="wb-navicat-drop-banner">
        <FileUp :size="15" aria-hidden="true" />
        <span>{{ t('navicatImport.dropHint') }}</span>
      </div>

      <div class="wb-navicat-toolbar">
        <div class="wb-navicat-toolbar-left">
          <span class="wb-navicat-source-pill">
            {{ sourceKind === 'ncx' ? t('navicatImport.sourceNcx') : t('navicatImport.sourceRegistry') }}
          </span>
          <div v-if="annotatedCandidates.length > 0" class="wb-navicat-filters" role="group">
            <button
              type="button"
              class="wb-navicat-filter-btn"
              :class="{ 'is-active': activeFilter === 'all' }"
              @click="activeFilter = 'all'"
            >{{ t('navicatImport.filterAll', { count: annotatedCandidates.length }) }}</button>
            <button
              v-if="mysqlCount > 0"
              type="button"
              class="wb-navicat-filter-btn"
              :class="{ 'is-active': activeFilter === 'mysql' }"
              @click="activeFilter = 'mysql'"
            >{{ t('navicatImport.filterMysql', { count: mysqlCount }) }}</button>
            <button
              v-if="mongoCount > 0"
              type="button"
              class="wb-navicat-filter-btn"
              :class="{ 'is-active': activeFilter === 'mongodb' }"
              @click="activeFilter = 'mongodb'"
            >{{ t('navicatImport.filterMongodb', { count: mongoCount }) }}</button>
          </div>
        </div>

        <div class="wb-navicat-toolbar-actions">
          <button
            type="button"
            class="wb-navicat-tool-btn"
            :disabled="scanning || importing"
            @click="scanLocalNavicat"
          >
            <RefreshCw :size="13" aria-hidden="true" />
            <span>{{ t('navicatImport.rescan') }}</span>
          </button>
          <button
            type="button"
            class="wb-navicat-tool-btn"
            :disabled="scanning || importing"
            @click="pickNcxFile"
          >
            <FileUp :size="13" aria-hidden="true" />
            <span>{{ t('navicatImport.pickNcx') }}</span>
          </button>
        </div>
      </div>

      <p v-if="errorMessage" class="wb-navicat-error">{{ errorMessage }}</p>

      <div class="wb-navicat-body">
        <div v-if="scanning" class="wb-navicat-state">
          <LoaderCircle :size="18" class="wb-navicat-spinner" aria-hidden="true" />
          <span>{{ t('navicatImport.scanning') }}</span>
        </div>

        <div v-else-if="!sourceSupported && sourceKind === 'registry'" class="wb-navicat-state is-stacked">
          <Database :size="20" class="wb-navicat-state-icon" aria-hidden="true" />
          <strong>{{ t('navicatImport.windowsOnlyTitle') }}</strong>
          <p>{{ t('navicatImport.windowsOnlyHint') }}</p>
          <button type="button" class="wb-navicat-state-btn" @click="pickNcxFile">
            <FileUp :size="14" aria-hidden="true" />
            <span>{{ t('navicatImport.pickNcxFile') }}</span>
          </button>
        </div>

        <div v-else-if="annotatedCandidates.length === 0" class="wb-navicat-state is-stacked">
          <Database :size="20" class="wb-navicat-state-icon" aria-hidden="true" />
          <strong>{{ t('navicatImport.emptyTitle') }}</strong>
          <p>{{ t('navicatImport.emptyHint') }}</p>
          <button type="button" class="wb-navicat-state-btn" @click="pickNcxFile">
            <FileUp :size="14" aria-hidden="true" />
            <span>{{ t('navicatImport.pickNcxFile') }}</span>
          </button>
        </div>

        <template v-else>
          <div class="wb-navicat-select-bar">
            <span>{{ t('navicatImport.selectedSummary', { selected: selectedCount, total: annotatedCandidates.length }) }}</span>
            <div class="wb-navicat-select-links">
              <button type="button" class="wb-navicat-link-btn" @click="selectAllVisible">
                {{ t('navicatImport.selectAll') }}
              </button>
              <button v-if="hasNewCandidates" type="button" class="wb-navicat-link-btn" @click="selectNewOnly">
                {{ t('navicatImport.selectNewOnly') }}
              </button>
              <button v-if="selectedCount > 0" type="button" class="wb-navicat-link-btn" @click="clearSelection">
                {{ t('navicatImport.clearSelection') }}
              </button>
            </div>
          </div>

          <ul class="wb-navicat-list" role="list">
            <li
              v-for="item in filteredCandidates"
              :key="item.id"
              class="wb-navicat-item"
              :class="{ 'is-selected': selectedIds.has(item.id), 'is-existing': item.alreadyExists }"
              @click="toggleItem(item.id)"
            >
              <input
                type="checkbox"
                class="wb-navicat-checkbox"
                :checked="selectedIds.has(item.id)"
                :aria-label="item.name"
                @click.stop
                @change="toggleItem(item.id)"
              />
              <span class="wb-navicat-kind" :class="`is-${item.kind}`">{{ kindLabel(item) }}</span>
              <div class="wb-navicat-item-copy">
                <div class="wb-navicat-item-title-row">
                  <span class="wb-navicat-item-name" :title="item.name">{{ item.name }}</span>
                </div>
                <div class="wb-navicat-item-meta" :title="item.addressLabel">
                  <span>{{ item.addressLabel }}</span>
                  <span v-if="item.database" class="wb-navicat-item-db">· {{ item.database }}</span>
                </div>
              </div>
              <div class="wb-navicat-badges">
                <span v-if="item.alreadyExists && selectedIds.has(item.id)" class="wb-navicat-badge is-accent">
                  {{ t('navicatImport.badgeWillUpdate') }}
                </span>
                <span v-else-if="item.alreadyExists" class="wb-navicat-badge is-muted">
                  {{ t('navicatImport.badgeExists') }}
                </span>
                <span v-if="item.passwordStatus === 'decrypted'" class="wb-navicat-badge is-ok">
                  {{ t('navicatImport.badgeHasPassword') }}
                </span>
                <span v-else-if="item.passwordStatus === 'missing'" class="wb-navicat-badge is-warn">
                  {{ t('navicatImport.badgeNoPassword') }}
                </span>
                <span v-else-if="item.passwordStatus === 'unreadable'" class="wb-navicat-badge is-warn">
                  {{ t('navicatImport.badgePasswordUnreadable') }}
                </span>
                <span v-if="item.warnings.includes('ssh_tunnel')" class="wb-navicat-badge is-warn">
                  {{ t('navicatImport.badgeSsh') }}
                </span>
                <span v-if="item.warnings.includes('ssl_enabled')" class="wb-navicat-badge is-muted">
                  {{ t('navicatImport.badgeSsl') }}
                </span>
              </div>
            </li>
          </ul>

          <p v-if="skippedUnsupported > 0" class="wb-navicat-footnote">
            {{ t('navicatImport.skippedUnsupported', { count: skippedUnsupported }) }}
          </p>
        </template>
      </div>

      <footer class="wb-dialog-actions wb-navicat-footer">
        <span class="wb-navicat-footer-hint">
          <template v-if="hasSelectedWithoutPassword">
            {{ t('navicatImport.missingPasswordNote') }}
          </template>
        </span>
        <div class="wb-navicat-footer-buttons">
          <button type="button" :disabled="importing" @click="emit('close')">
            {{ t('navicatImport.cancel') }}
          </button>
          <button
            type="button"
            class="wb-dialog-primary"
            :disabled="scanning || importing || selectedCount === 0"
            @click="submitImport"
          >
            {{ importing ? t('navicatImport.importing') : t('navicatImport.importAction', { count: selectedCount }) }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>
