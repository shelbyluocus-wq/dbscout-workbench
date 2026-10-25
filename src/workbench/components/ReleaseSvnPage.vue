<script setup>
// Phase 2, step 1: update the platform client to the latest revision before
// anything is copied into it. Conflicts must be settled here, one choice per
// file, before the copy may start.
import { computed } from "vue";
import { Cloud, FolderGit2, HardDrive, User } from "lucide-vue-next";
import { t } from "../i18n/index.js";
import { CONFLICT_CHOICES } from "../composables/useReleaseFlow.js";
import ReleasePageHead from "./ReleasePageHead.vue";
import ReleaseTaskPanel from "./ReleaseTaskPanel.vue";

const props = defineProps({
  flow: { type: Object, required: true },
  workspace: { type: Object, default: null },
});
defineEmits(["run", "rerun", "navigate"]);

const platform = computed(() => props.flow.platform.value);
const task = computed(() => props.flow.state.tasks["client.svn"]);
const conflicts = computed(() => props.flow.svnConflicts.value);
const pending = computed(() => props.flow.conflictsPending.value);
const busy = computed(() => props.flow.busy.value);
const CHOICE_ICONS = { theirs: Cloud, mine: HardDrive, manual: User };
</script>

<template>
  <ReleasePageHead page-id="clientSvn" />

  <div class="wb-rf-route-node is-target">
    <span><FolderGit2 :size="13" aria-hidden="true" />{{ t('releaseFlow.svn.target', { platform: platform.name }) }}</span>
    <strong class="wb-rf-code">{{ platform.targetClient }}</strong>
  </div>

  <section
    v-if="pending || (task.status === 'done' && task.result?.resolved)"
    class="wb-rf-card wb-rf-conflicts"
    :class="{ 'is-pending': pending }"
    aria-labelledby="wb-rf-conflicts-title"
  >
    <div class="wb-rf-group-head">
      <h4 id="wb-rf-conflicts-title">{{ t('releaseFlow.svn.conflicts', { count: conflicts.length }) }}</h4>
      <div v-if="pending" class="wb-rf-group-tools">
        <button type="button" class="wb-rf-btn is-quiet is-small" :disabled="busy" @click="flow.setAllConflictChoices('theirs')">{{ t('releaseFlow.svn.allTheirs') }}</button>
        <button type="button" class="wb-rf-btn is-quiet is-small" :disabled="busy" @click="flow.setAllConflictChoices('mine')">{{ t('releaseFlow.svn.allMine') }}</button>
      </div>
    </div>
    <ul class="wb-rf-list wb-rf-conflict-list">
      <li v-for="conflict in conflicts" :key="conflict.path" class="wb-rf-conflict">
        <span class="wb-rf-code">{{ conflict.path }}</span>
        <div class="wb-rf-segmented" role="radiogroup" :aria-label="t('releaseFlow.svn.choiceFor', { path: conflict.path })">
          <button
            v-for="choice in CONFLICT_CHOICES"
            :key="choice"
            type="button"
            role="radio"
            :aria-checked="conflict.choice === choice"
            :disabled="busy || !pending"
            :title="choice === 'manual' ? t('releaseFlow.svn.manualHint') : undefined"
            @click="flow.setConflictChoice(conflict.path, choice)"
          >
            <component :is="CHOICE_ICONS[choice]" :size="13" aria-hidden="true" />
            {{ t(`releaseFlow.svn.choice.${choice}`) }}
          </button>
        </div>
      </li>
    </ul>
  </section>

  <ReleaseTaskPanel :flow="flow" task-id="client.svn">
    <template #done="{ result }">
      <strong>{{ t('releaseFlow.svn.done', { revision: result.revision, count: result.updated }) }}</strong>
      <span v-if="result.resolved">{{ t('releaseFlow.svn.doneResolved', { count: result.resolved }) }}</span>
    </template>
    <template #attention="{ result }">
      <strong>{{ t('releaseFlow.svn.attention', { revision: result.revision, count: result.conflicts?.length || 0 }) }}</strong>
    </template>
  </ReleaseTaskPanel>
</template>

<style scoped>
.wb-rf-conflicts.is-pending {
  border-color: var(--wb-warning-border);
}

.wb-rf-conflict-list {
  display: grid;
}

.wb-rf-conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 12px 0;
  border-top: 1px solid var(--wb-line);
}
</style>
