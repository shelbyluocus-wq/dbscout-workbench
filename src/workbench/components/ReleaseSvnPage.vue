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
  <div>
    <ReleasePageHead page-id="clientSvn" />

    <div class="wb-rf-stack">
      <div class="wb-rf-route-node is-target wb-rf-svn-target">
        <span><FolderGit2 :size="13" aria-hidden="true" />{{ t('releaseFlow.svn.target', { platform: platform.name }) }}</span>
        <strong class="wb-rf-code">{{ platform.targetClient }}</strong>
        <small class="wb-rf-hint">{{ t('releaseFlow.svn.targetHint') }}</small>
      </div>

      <section
        v-if="pending || (task.status === 'done' && task.result?.resolved)"
        class="wb-rf-section wb-rf-conflicts"
        :class="{ 'is-pending': pending }"
        aria-labelledby="wb-rf-conflicts-title"
      >
        <div class="wb-rf-section-head">
          <h4 id="wb-rf-conflicts-title">{{ t('releaseFlow.svn.conflicts', { count: conflicts.length }) }}</h4>
          <div v-if="pending" class="wb-rf-section-tools">
            <button type="button" class="wb-rf-ghost" :disabled="busy" @click="flow.setAllConflictChoices('theirs')">{{ t('releaseFlow.svn.allTheirs') }}</button>
            <button type="button" class="wb-rf-ghost" :disabled="busy" @click="flow.setAllConflictChoices('mine')">{{ t('releaseFlow.svn.allMine') }}</button>
          </div>
        </div>
        <p class="wb-rf-hint">{{ t(pending ? 'releaseFlow.svn.conflictsHint' : 'releaseFlow.svn.conflictsResolved') }}</p>
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
                @click="flow.setConflictChoice(conflict.path, choice)"
              >
                <component :is="CHOICE_ICONS[choice]" :size="12" aria-hidden="true" />
                {{ t(`releaseFlow.svn.choice.${choice}`) }}
              </button>
            </div>
          </li>
        </ul>
        <p v-if="pending && conflicts.some((conflict) => conflict.choice === 'manual')" class="wb-rf-hint">{{ t('releaseFlow.svn.manualHint') }}</p>
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
    </div>
  </div>
</template>

<style scoped>
.wb-rf-svn-target small {
  margin-top: 2px;
}

.wb-rf-conflicts.is-pending {
  border-color: var(--wb-warning-border);
}

.wb-rf-conflict-list {
  display: grid;
  gap: 6px;
}

.wb-rf-conflict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--wb-field-surface);
}

.wb-rf-conflict .wb-rf-segmented button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
</style>
