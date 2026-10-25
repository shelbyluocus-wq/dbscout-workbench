<script setup>
// The SVN page: a real working copy (a platform's client, or any folder),
// with its changes, side-by-side diffs, commit, revert, conflict resolution
// and log, run through the SVN client Blackcat already uses for updates.
// Commits, reverts and resolutions are kept in the history. In the browser
// preview a simulated working copy answers instead.
import { computed, onMounted, ref } from "vue";
import { FolderOpen } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { createSvnBackendSource, useSvnWorkspace } from "../composables/useSvnWorkspace.js";
import { isTauriRuntime } from "../utils/tauriBridge.js";
import ReleaseSectionHead from "./ReleaseSectionHead.vue";
import ReleaseSvnWorkspace from "./ReleaseSvnWorkspace.vue";

const props = defineProps({
  workspace: { type: Object, required: true },
});

const preview = !isTauriRuntime();
const source = createSvnBackendSource();
const platforms = computed(() => props.workspace.state.platforms);
const path = ref(props.workspace.state.svn.path || platforms.value[0]?.targetClient || "");
const platformOf = (root) => platforms.value.find((platform) => [platform.targetClient, platform.sourceClient].includes(root)) || null;

const svn = useSvnWorkspace({
  source,
  onRecord(record) {
    const platform = platformOf(svn.state.root);
    props.workspace.recordTool({
      kind: "svn",
      platformId: platform?.id || "",
      platformName: platform?.name || "",
      demo: preview,
      outcome: record.outcome,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      details: { ...record.details, action: record.kind },
    });
  },
});

const quickPicks = computed(() => platforms.value.flatMap((platform) => [
  { key: `${platform.id}-target`, label: t('releaseFlow.svn.pick.platform', { platform: platform.name }), path: platform.targetClient },
]).concat(platforms.value[0] ? [{ key: "source", label: t("releaseFlow.svn.pick.source"), path: platforms.value[0].sourceClient }] : []));

function open(target = path.value) {
  path.value = String(target || "").trim();
  props.workspace.setSvnPath(path.value);
  void svn.open(path.value);
}

async function browse() {
  const picked = await source.pickFolder(path.value).catch(() => null);
  if (picked) open(picked);
}

onMounted(() => {
  if (path.value) open();
});
</script>

<template>
  <ReleaseSectionHead :workspace="workspace" :title="t('releaseFlow.svn.title')" :description="t(preview ? 'releaseFlow.svn.descriptionPreview' : 'releaseFlow.svn.description')">
    <template #tag>
      <span class="wb-rf-chip" :class="preview ? 'is-quiet' : 'is-accent'">{{ t(preview ? 'releaseFlow.svn.simulated' : 'releaseFlow.real') }}</span>
    </template>
  </ReleaseSectionHead>

  <form class="wb-rf-svn-target" @submit.prevent="open()">
    <label class="wb-rf-field wb-rf-svn-path-field">
      {{ t('releaseFlow.svn.workingCopy') }}
      <input v-model="path" class="wb-rf-code" spellcheck="false" data-svn-root />
    </label>
    <button type="button" class="wb-rf-btn" @click="browse"><FolderOpen :size="14" aria-hidden="true" />{{ t('releaseFlow.svn.browse') }}</button>
    <button type="submit" class="wb-rf-btn is-primary" :disabled="!path.trim()">{{ t('releaseFlow.svn.open') }}</button>
  </form>
  <div class="wb-rf-svn-quick" role="group" :aria-label="t('releaseFlow.svn.quick')">
    <button
      v-for="pick in quickPicks"
      :key="pick.key"
      type="button"
      class="wb-rf-chip"
      :class="{ 'is-accent': pick.path === svn.state.root }"
      :title="pick.path"
      @click="open(pick.path)"
    >{{ pick.label }}</button>
  </div>

  <ReleaseSvnWorkspace v-if="svn.state.root" :svn="svn" :simulated="preview" />
</template>
