<script setup>
// "Field relations" on the relation page: every relation of the table, split
// into the ones its columns make and the ones made at it. Items waiting for a
// decision come first; rejected ones wait in a closed group.
import { t } from "../i18n/index.js";
import { computed } from "vue";
import { ArrowDownLeft, ArrowUpRight, ChevronRight, TriangleAlert } from "lucide-vue-next";
import {
  relationNeedsReview,
  relationTitle,
  splitRejectedRelations,
  tableDisplayName,
} from "../utils/configRelations.js";
import RelationSectionHead from "./RelationSectionHead.vue";
import ConfigRelationCard from "./ConfigRelationCard.vue";

const props = defineProps({
  outgoing: { type: Array, default: () => [] },
  incoming: { type: Array, default: () => [] },
  // Backend lowercase-name -> { name, comment } map.
  tables: { type: Object, default: () => ({}) },
  mentionTables: { type: Object, default: null },
  pendingReview: { type: Set, default: () => new Set() },
  open: { type: Boolean, default: true },
  rejectedOpen: { type: Boolean, default: false },
});

const emit = defineEmits(["toggle", "toggle-rejected", "open-table", "review"]);

const bodyId = `wb-relations-table-${Math.random().toString(36).slice(2, 10)}`;

// Waiting decisions first; otherwise the backend's stable order.
function attentionFirst(relations) {
  return [...relations].sort((left, right) => Number(relationNeedsReview(right)) - Number(relationNeedsReview(left)));
}

const outgoingGroups = computed(() => splitRejectedRelations(props.outgoing));
const incomingGroups = computed(() => splitRejectedRelations(props.incoming));
const outgoingActive = computed(() => attentionFirst(outgoingGroups.value.active));
const incomingActive = computed(() => attentionFirst(incomingGroups.value.active));
// A self reference is listed on both sides by the backend; show it once.
const rejected = computed(() => {
  const seen = new Set();
  return [...outgoingGroups.value.rejected, ...incomingGroups.value.rejected].filter((relation) => {
    if (seen.has(relation.id)) return false;
    seen.add(relation.id);
    return true;
  });
});
const activeCount = computed(() => new Set([...outgoingActive.value, ...incomingActive.value].map((relation) => relation.id)).size);
const reviewCount = computed(() => new Set([...outgoingActive.value, ...incomingActive.value]
  .filter(relationNeedsReview)
  .map((relation) => relation.id)).size);

function outgoingTitle(relation) {
  return `${relation.sourceColumn} → ${tableDisplayName(props.tables, relation.targetTable)}.${relation.targetColumn}`;
}

function incomingTitle(relation) {
  return `${tableDisplayName(props.tables, relation.sourceTable)}.${relation.sourceColumn} → ${relation.targetColumn}`;
}
</script>

<template>
  <section class="wb-relations-block">
    <RelationSectionHead
      :label="t('relations.table.title')"
      :count="activeCount"
      :open="open"
      :controls="bodyId"
      @toggle="emit('toggle')"
    >
      <span v-if="reviewCount" class="wb-relations-attention">
        <TriangleAlert :size="12" aria-hidden="true" />{{ t('relations.table.needsReview', { count: reviewCount }) }}
      </span>
    </RelationSectionHead>

    <div v-show="open" :id="bodyId" class="wb-relations-block-body">
      <div class="wb-relations-group">
        <div class="wb-relations-group-label is-outgoing">
          <ArrowUpRight :size="12" :stroke-width="2.2" aria-hidden="true" />
          <span>{{ t('relations.table.outgoing') }}</span>
          <span class="wb-relations-group-count">{{ outgoingActive.length }}</span>
        </div>
        <ConfigRelationCard
          v-for="relation in outgoingActive"
          :key="relation.id"
          :relation="relation"
          direction="outgoing"
          :tables="mentionTables"
          :labels="tables"
          :title="outgoingTitle(relation)"
          :busy="pendingReview.has(relation.id)"
          @open="emit('open-table', $event)"
          @review="emit('review', relation, $event)"
        />
        <p v-if="!outgoingActive.length" class="wb-relations-note is-inset">{{ t('relations.table.outgoingEmpty') }}</p>
      </div>

      <div class="wb-relations-group">
        <div class="wb-relations-group-label is-incoming">
          <ArrowDownLeft :size="12" :stroke-width="2.2" aria-hidden="true" />
          <span>{{ t('relations.table.incoming') }}</span>
          <span class="wb-relations-group-count">{{ incomingActive.length }}</span>
        </div>
        <ConfigRelationCard
          v-for="relation in incomingActive"
          :key="relation.id"
          :relation="relation"
          direction="incoming"
          :tables="mentionTables"
          :labels="tables"
          :title="incomingTitle(relation)"
          :busy="pendingReview.has(relation.id)"
          @open="emit('open-table', $event)"
          @review="emit('review', relation, $event)"
        />
        <p v-if="!incomingActive.length" class="wb-relations-note is-inset">{{ t('relations.table.incomingEmpty') }}</p>
      </div>

      <template v-if="rejected.length">
        <button
          type="button"
          class="wb-relations-quiet-toggle"
          :aria-expanded="rejectedOpen"
          @click="emit('toggle-rejected')"
        >
          <ChevronRight :size="12" :stroke-width="2.2" :class="{ 'is-open': rejectedOpen }" aria-hidden="true" />
          {{ t('relations.table.rejected', { count: rejected.length }) }}
        </button>
        <div v-if="rejectedOpen" class="wb-relations-group">
          <ConfigRelationCard
            v-for="relation in rejected"
            :key="relation.id"
            :relation="relation"
            :tables="mentionTables"
            :labels="tables"
            :title="relationTitle(relation, tables)"
            :busy="pendingReview.has(relation.id)"
            @open="emit('open-table', $event)"
            @review="emit('review', relation, $event)"
          />
        </div>
      </template>
    </div>
  </section>
</template>
